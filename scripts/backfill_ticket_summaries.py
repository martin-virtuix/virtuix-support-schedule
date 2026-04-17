#!/usr/bin/env python3
"""
Backfill summarized support tickets through the deployed summarize_ticket function.

This script:
  - classifies tickets as missing / legacy / canonical / stale
  - refreshes only the requested candidate classes
  - calls the deployed summarize_ticket Edge Function using one of:
      SUPABASE_FUNCTION_TOKEN (preferred)
      SUPABASE_USER_ACCESS_TOKEN (logged-in Virtuix Hub session)
      SUPABASE_SERVICE_ROLE_KEY (last resort; may fail if it does not match the deployed function env)
  - logs resumable progress and continues past per-ticket failures

Requirements:
  - Python packages: requests
  - Env vars:
      SUPABASE_URL (or VITE_SUPABASE_URL)
      SUPABASE_SERVICE_ROLE_KEY
      SUPABASE_FUNCTION_TOKEN (preferred for Edge Function calls)
      SUPABASE_USER_ACCESS_TOKEN (fallback bearer token from a logged-in Virtuix Hub session)
      VITE_SUPABASE_PUBLISHABLE_KEY (optional; falls back to service role for apikey header)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
  import requests
except Exception:  # pragma: no cover - import guard for runtime clarity
  print("Missing dependency: requests. Install with `python3 -m pip install requests`.")
  raise


REQUEST_TIMEOUT = 120
DEFAULT_PAGE_SIZE = 200
DEFAULT_CONCURRENCY = 2
MAX_ERROR_SAMPLES = 12
CANONICAL_SUMMARY_MARKERS = ("Issue:", "Troubleshooting:", "Resolution:")
LEGACY_SUMMARY_MARKERS = (
  "Ticket Subject:",
  "Requester:",
  "Issue Summary:",
  "Support Actions:",
  "Recommended Next Step:",
  "Next Steps",
)


@dataclass
class TicketBackfillRecord:
  ticket_id: int
  brand: str
  status: str
  subject: str
  summary_text: str | None
  summary_updated_at: str | None
  zendesk_updated_at: str | None


def load_dotenv(dotenv_path: Path) -> None:
  if not dotenv_path.exists():
    return

  for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
      continue
    key, value = line.split("=", 1)
    key = key.strip()
    if not key or key in os.environ:
      continue
    value = value.strip().strip("'").strip('"')
    os.environ[key] = value


def normalize_optional_string(value: Any) -> str | None:
  if not isinstance(value, str):
    return None
  trimmed = value.strip()
  return trimmed or None


def classify_summary_text(value: str | None) -> str:
  if not value or not value.strip():
    return "missing"

  summary = value.strip()
  has_canonical_markers = all(marker in summary for marker in CANONICAL_SUMMARY_MARKERS)
  has_legacy_markers = any(marker in summary for marker in LEGACY_SUMMARY_MARKERS)

  if has_canonical_markers and not has_legacy_markers:
    return "canonical"
  if has_legacy_markers:
    return "legacy"
  return "noncanonical"


def is_stale(record: TicketBackfillRecord) -> bool:
  if not record.summary_updated_at or not record.zendesk_updated_at:
    return False
  return record.summary_updated_at < record.zendesk_updated_at


class SupabaseAdminClient:
  def __init__(
    self,
    supabase_url: str,
    service_role_key: str,
    function_token: str | None,
    user_access_token: str | None,
    publishable_key: str | None,
  ) -> None:
    self.supabase_url = supabase_url.rstrip("/")
    self.service_role_key = service_role_key
    self.function_token = function_token or user_access_token or service_role_key
    self.publishable_key = publishable_key or service_role_key
    self.rest_headers = {
      "Authorization": f"Bearer {service_role_key}",
      "apikey": service_role_key,
    }
    self.function_headers = {
      "Authorization": f"Bearer {self.function_token}",
      "apikey": self.publishable_key,
      "Content-Type": "application/json",
    }

  def _request(
    self,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_payload: Any = None,
    headers: dict[str, str] | None = None,
    timeout: int = REQUEST_TIMEOUT,
  ) -> Any:
    response = requests.request(
      method=method,
      url=f"{self.supabase_url}{path}",
      params=params,
      json=json_payload,
      headers=headers,
      timeout=timeout,
    )
    if response.status_code >= 400:
      raise RuntimeError(f"{method} {path} failed ({response.status_code}): {response.text}")

    if response.text.strip() == "":
      return None

    content_type = response.headers.get("Content-Type", "")
    if "application/json" in content_type:
      return response.json()
    return response.text

  def list_ticket_candidates(
    self,
    *,
    brand: str | None,
    ticket_id: int | None,
    summary_filter: str,
    limit: int,
    offset: int,
  ) -> list[TicketBackfillRecord]:
    params: dict[str, Any] = {
      "select": "ticket_id,brand,status,subject,summary_text,summary_updated_at,zendesk_updated_at",
      "status": "not.in.(spam,deleted)",
      "order": "ticket_id.asc",
      "limit": limit,
      "offset": offset,
    }
    if brand:
      params["brand"] = f"eq.{brand}"
    if ticket_id is not None:
      params["ticket_id"] = f"eq.{ticket_id}"
    if summary_filter == "missing_only":
      params["summary_text"] = "is.null"
    elif summary_filter == "summarized_only":
      params["summary_text"] = "not.is.null"

    data = self._request(
      "GET",
      "/rest/v1/ticket_cache",
      params=params,
      headers=self.rest_headers,
    )

    records: list[TicketBackfillRecord] = []
    for item in data if isinstance(data, list) else []:
      if not isinstance(item, dict):
        continue
      ticket_id_value = item.get("ticket_id")
      if not isinstance(ticket_id_value, int):
        continue
      records.append(
        TicketBackfillRecord(
          ticket_id=ticket_id_value,
          brand=normalize_optional_string(item.get("brand")) or "unknown",
          status=normalize_optional_string(item.get("status")) or "unknown",
          subject=normalize_optional_string(item.get("subject")) or "",
          summary_text=normalize_optional_string(item.get("summary_text")),
          summary_updated_at=normalize_optional_string(item.get("summary_updated_at")),
          zendesk_updated_at=normalize_optional_string(item.get("zendesk_updated_at")),
        ),
      )
    return records

  def summarize_ticket(self, ticket_id: int, *, refresh: bool) -> dict[str, Any]:
    return self._request(
      "POST",
      "/functions/v1/summarize_ticket",
      json_payload={
        "ticket_id": ticket_id,
        "refresh": refresh,
      },
      headers=self.function_headers,
      timeout=max(REQUEST_TIMEOUT, 300),
    )


def should_refresh_record(
  record: TicketBackfillRecord,
  *,
  include_missing: bool,
  include_legacy: bool,
  include_noncanonical: bool,
  include_stale: bool,
  force: bool,
) -> tuple[bool, str]:
  if force:
    return True, "forced"

  classification = classify_summary_text(record.summary_text)
  if classification == "missing":
    return (include_missing, "missing") if include_missing else (False, "skipped_missing")
  if classification == "legacy":
    return (include_legacy, "legacy") if include_legacy else (False, "skipped_legacy")
  if classification == "noncanonical":
    return (include_noncanonical, "noncanonical") if include_noncanonical else (False, "skipped_noncanonical")

  if include_stale and is_stale(record):
    return True, "stale"
  return False, "skipped_canonical"


def call_summarizer_with_retry(
  client: SupabaseAdminClient,
  *,
  ticket_id: int,
  refresh: bool,
  max_attempts: int,
) -> dict[str, Any]:
  last_error: Exception | None = None

  for attempt in range(1, max_attempts + 1):
    try:
      payload = client.summarize_ticket(ticket_id, refresh=refresh)
      if not isinstance(payload, dict):
        raise RuntimeError("summarize_ticket returned a non-object payload")
      if payload.get("ok") is not True:
        raise RuntimeError(str(payload.get("error") or "summarize_ticket returned ok=false"))
      return payload
    except Exception as error:
      last_error = error if isinstance(error, Exception) else RuntimeError(str(error))
      if attempt >= max_attempts:
        break
      backoff = min(2 ** (attempt - 1), 20)
      time.sleep(backoff)

  assert last_error is not None
  raise last_error


def parse_args(argv: list[str]) -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Backfill canonical ticket summaries through summarize_ticket.")
  parser.add_argument("--brand", choices=["all", "omni_one", "omni_arena", "unknown"], default="all")
  parser.add_argument("--ticket-id", type=int, default=None, help="Refresh one ticket by id.")
  parser.add_argument("--max-tickets", type=int, default=None)
  parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
  parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
  parser.add_argument("--max-attempts", type=int, default=3)
  parser.add_argument("--force", action="store_true", help="Refresh every selected ticket, regardless of current summary format.")
  parser.add_argument("--include-stale", action="store_true", help="Also refresh canonical summaries when zendesk_updated_at is newer than summary_updated_at.")
  parser.add_argument("--missing-only", action="store_true", help="Refresh only tickets with no summary.")
  parser.add_argument("--legacy-only", action="store_true", help="Refresh only legacy-format summaries.")
  parser.add_argument("--noncanonical-only", action="store_true", help="Refresh only noncanonical summaries that are neither missing nor legacy.")
  parser.add_argument("--dry-run", action="store_true", help="List candidate tickets without calling summarize_ticket.")
  return parser.parse_args(argv)


def main(argv: list[str]) -> int:
  load_dotenv(Path(".env"))
  args = parse_args(argv)

  supabase_url = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL")
  service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
  function_token = os.environ.get("SUPABASE_FUNCTION_TOKEN")
  user_access_token = os.environ.get("SUPABASE_USER_ACCESS_TOKEN")
  publishable_key = os.environ.get("VITE_SUPABASE_PUBLISHABLE_KEY")

  if not supabase_url:
    print("Missing SUPABASE_URL (or VITE_SUPABASE_URL).")
    return 1
  if not service_role_key:
    print("Missing SUPABASE_SERVICE_ROLE_KEY.")
    return 1

  include_missing = True
  include_legacy = True
  include_noncanonical = True
  if args.missing_only or args.legacy_only or args.noncanonical_only:
    include_missing = args.missing_only
    include_legacy = args.legacy_only
    include_noncanonical = args.noncanonical_only

  client = SupabaseAdminClient(
    supabase_url,
    service_role_key,
    function_token,
    user_access_token,
    publishable_key,
  )
  auth_mode = "service_role"
  if function_token:
    auth_mode = "function_token"
  elif user_access_token:
    auth_mode = "user_access_token"
  print(f"Using summarize_ticket auth mode: {auth_mode}")
  if auth_mode == "service_role":
    print(
      "Warning: summarize_ticket is using SUPABASE_SERVICE_ROLE_KEY as the bearer token. "
      "If the deployed function rejects it, export SUPABASE_USER_ACCESS_TOKEN from a logged-in "
      "Virtuix Hub session and rerun.",
    )
  counters = {
    "processed": 0,
    "queued": 0,
    "generated": 0,
    "refreshed_legacy": 0,
    "refreshed_missing": 0,
    "refreshed_noncanonical": 0,
    "refreshed_stale": 0,
    "refreshed_forced": 0,
    "skipped_canonical": 0,
    "skipped_missing": 0,
    "skipped_legacy": 0,
    "skipped_noncanonical": 0,
    "cached_responses": 0,
    "dry_run": 0,
    "failed": 0,
  }
  error_samples: list[dict[str, Any]] = []

  brand_filter = None if args.brand == "all" else args.brand
  processed = 0
  offset = 0
  page_size = max(1, min(int(args.page_size), 1000))
  concurrency = max(1, min(int(args.concurrency), 16))
  max_attempts = max(1, min(int(args.max_attempts), 10))
  max_queued = args.max_tickets if args.max_tickets is not None and args.max_tickets >= 0 else None

  summary_filter = "all"
  if not args.force:
    if include_missing and not include_legacy and not include_noncanonical and not args.include_stale:
      summary_filter = "missing_only"
    elif not include_missing and (include_legacy or include_noncanonical or args.include_stale):
      summary_filter = "summarized_only"

  refresh_queue: list[tuple[TicketBackfillRecord, str]] = []
  reached_max_queue = False

  while True:
    records = client.list_ticket_candidates(
      brand=brand_filter,
      ticket_id=args.ticket_id,
      summary_filter=summary_filter,
      limit=page_size,
      offset=offset,
    )
    if not records:
      break

    print(f"Loaded {len(records)} tickets at offset {offset}.")
    for record in records:
      should_refresh, reason = should_refresh_record(
        record,
        include_missing=include_missing,
        include_legacy=include_legacy,
        include_noncanonical=include_noncanonical,
        include_stale=args.include_stale,
        force=args.force,
      )
      counters["processed"] += 1
      if should_refresh:
        refresh_queue.append((record, reason))
        counters["queued"] += 1
        if args.dry_run:
          counters["dry_run"] += 1
          print(f"[DRY-RUN] would refresh ticket #{record.ticket_id} ({reason}) - {record.subject}")
        if max_queued is not None and counters["queued"] >= max_queued:
          reached_max_queue = True
          break
      else:
        counters[reason] = counters.get(reason, 0) + 1

    processed += len(records)
    if args.ticket_id is not None:
      break
    if reached_max_queue:
      break
    if len(records) < page_size:
      break
    offset += page_size

  if args.dry_run:
    print("\nBackfill summary:")
    print(json.dumps({"counters": counters, "error_samples": error_samples}, indent=2))
    return 0

  if not refresh_queue:
    print("No tickets matched the requested backfill criteria.")
    print(json.dumps({"counters": counters, "error_samples": error_samples}, indent=2))
    return 0

  def worker(record: TicketBackfillRecord, reason: str) -> tuple[int, str, dict[str, Any]]:
    payload = call_summarizer_with_retry(
      client,
      ticket_id=record.ticket_id,
      refresh=True,
      max_attempts=max_attempts,
    )
    return record.ticket_id, reason, payload

  print(f"Refreshing {len(refresh_queue)} ticket summaries with concurrency={concurrency}...")
  submitted = 0
  completed = 0

  with ThreadPoolExecutor(max_workers=concurrency) as executor:
    in_flight: dict[Future[tuple[int, str, dict[str, Any]]], tuple[TicketBackfillRecord, str]] = {}

    while submitted < len(refresh_queue) or in_flight:
      while submitted < len(refresh_queue) and len(in_flight) < concurrency:
        record, reason = refresh_queue[submitted]
        future = executor.submit(worker, record, reason)
        in_flight[future] = (record, reason)
        submitted += 1

      done, _ = wait(in_flight.keys(), return_when=FIRST_COMPLETED)
      for future in done:
        record, reason = in_flight.pop(future)
        completed += 1
        try:
          _, completed_reason, payload = future.result()
          if payload.get("cached") is True:
            counters["cached_responses"] += 1
          if completed_reason == "legacy":
            counters["refreshed_legacy"] += 1
          elif completed_reason == "missing":
            counters["refreshed_missing"] += 1
          elif completed_reason == "noncanonical":
            counters["refreshed_noncanonical"] += 1
          elif completed_reason == "stale":
            counters["refreshed_stale"] += 1
          elif completed_reason == "forced":
            counters["refreshed_forced"] += 1
          counters["generated"] += 1
          model = payload.get("model")
          print(f"[{completed}/{len(refresh_queue)}] refreshed ticket #{record.ticket_id} ({completed_reason}) model={model}")
        except Exception as error:
          counters["failed"] += 1
          message = str(error)
          if len(error_samples) < MAX_ERROR_SAMPLES:
            error_samples.append({
              "ticket_id": record.ticket_id,
              "reason": reason,
              "subject": record.subject,
              "error": message,
            })
          print(f"[{completed}/{len(refresh_queue)}] failed ticket #{record.ticket_id} ({reason}): {message}")

  print("\nBackfill summary:")
  print(json.dumps({"counters": counters, "error_samples": error_samples}, indent=2))
  return 0 if counters["failed"] == 0 else 2


if __name__ == "__main__":
  raise SystemExit(main(sys.argv[1:]))
