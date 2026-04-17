#!/usr/bin/env python3
"""
Index summarized support tickets into semantic-search tables.

Requirements:
  - Python packages: requests
  - Env vars:
      SUPABASE_URL (or VITE_SUPABASE_URL)
      SUPABASE_SERVICE_ROLE_KEY
      OPENAI_API_KEY (unless --dry-run)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
  import requests
except Exception:  # pragma: no cover - import guard for runtime clarity
  print("Missing dependency: requests. Install with `python3 -m pip install requests`.")
  raise


DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
DEFAULT_BATCH_SIZE = 64
DEFAULT_PAGE_SIZE = 200
REQUEST_TIMEOUT = 90
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
class TicketSummaryRecord:
  ticket_id: int
  brand: str
  status: str
  subject: str
  ticket_url: str | None
  zendesk_updated_at: str | None
  summary_text: str
  summary_updated_at: str | None


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


def now_iso() -> str:
  return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def normalize_optional_string(value: Any) -> str | None:
  if not isinstance(value, str):
    return None
  trimmed = value.strip()
  return trimmed or None


def vector_literal(values: list[float]) -> str:
  return "[" + ",".join(f"{value:.10f}" for value in values) + "]"


def compute_checksum(value: str) -> str:
  return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_summary_text(value: str) -> str:
  return value.strip()


def classify_summary_text(value: str) -> str:
  summary = normalize_summary_text(value)
  if not summary:
    return "empty"

  has_canonical_markers = all(marker in summary for marker in CANONICAL_SUMMARY_MARKERS)
  has_legacy_markers = any(marker in summary for marker in LEGACY_SUMMARY_MARKERS)

  if has_canonical_markers and not has_legacy_markers:
    return "canonical"
  if has_legacy_markers:
    return "legacy"
  return "noncanonical"


class SupabaseHttpClient:
  def __init__(self, supabase_url: str, service_role_key: str) -> None:
    self.supabase_url = supabase_url.rstrip("/")
    self.service_role_key = service_role_key
    self.base_headers = {
      "Authorization": f"Bearer {service_role_key}",
      "apikey": service_role_key,
    }

  def _request(
    self,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_payload: Any = None,
    extra_headers: dict[str, str] | None = None,
    timeout: int = REQUEST_TIMEOUT,
  ) -> Any:
    headers = dict(self.base_headers)
    if extra_headers:
      headers.update(extra_headers)
    if json_payload is not None:
      headers.setdefault("Content-Type", "application/json")

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
    return response.content

  def list_summarized_tickets(
    self,
    *,
    brand: str | None,
    ticket_id: int | None,
    ticket_id_min: int | None,
    ticket_id_max: int | None,
    order: str,
    limit: int,
    offset: int,
  ) -> list[TicketSummaryRecord]:
    params: dict[str, Any] = {
      "select": "ticket_id,brand,status,subject,ticket_url,zendesk_updated_at,summary_text,summary_updated_at",
      "summary_text": "not.is.null",
      "status": "not.in.(spam,deleted)",
      "order": f"ticket_id.{order}",
      "limit": limit,
      "offset": offset,
    }
    if brand:
      params["brand"] = f"eq.{brand}"
    if ticket_id is not None:
      params["ticket_id"] = f"eq.{ticket_id}"
    else:
      ticket_range_filters: list[str] = []
      if ticket_id_min is not None:
        ticket_range_filters.append(f"ticket_id.gte.{ticket_id_min}")
      if ticket_id_max is not None:
        ticket_range_filters.append(f"ticket_id.lte.{ticket_id_max}")
      if ticket_range_filters:
        params["and"] = f"({','.join(ticket_range_filters)})"

    data = self._request(
      "GET",
      "/rest/v1/ticket_cache",
      params=params,
      extra_headers={"Accept-Profile": "public"},
    )

    records: list[TicketSummaryRecord] = []
    for item in data if isinstance(data, list) else []:
      if not isinstance(item, dict):
        continue
      raw_summary = normalize_optional_string(item.get("summary_text"))
      ticket_id_value = item.get("ticket_id")
      if not isinstance(ticket_id_value, int) or not raw_summary:
        continue
      records.append(
        TicketSummaryRecord(
          ticket_id=ticket_id_value,
          brand=normalize_optional_string(item.get("brand")) or "unknown",
          status=normalize_optional_string(item.get("status")) or "unknown",
          subject=normalize_optional_string(item.get("subject")) or "",
          ticket_url=normalize_optional_string(item.get("ticket_url")),
          zendesk_updated_at=normalize_optional_string(item.get("zendesk_updated_at")),
          summary_text=normalize_summary_text(raw_summary),
          summary_updated_at=normalize_optional_string(item.get("summary_updated_at")),
        ),
      )
    return records

  def fetch_existing_embeddings(self, ticket_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not ticket_ids:
      return {}

    ids_literal = ",".join(str(ticket_id) for ticket_id in sorted(set(ticket_ids)))
    data = self._request(
      "GET",
      "/rest/v1/ticket_embedding_chunks",
      params={
        "select": "ticket_id,summary_updated_at,content_checksum",
        "source": "eq.summary",
        "chunk_index": "eq.0",
        "ticket_id": f"in.({ids_literal})",
      },
      extra_headers={"Accept-Profile": "public"},
    )

    results: dict[int, dict[str, Any]] = {}
    for item in data if isinstance(data, list) else []:
      if not isinstance(item, dict):
        continue
      ticket_id_value = item.get("ticket_id")
      if isinstance(ticket_id_value, int):
        results[ticket_id_value] = item
    return results

  def upsert_embedding_rows(self, rows: list[dict[str, Any]]) -> None:
    if not rows:
      return

    self._request(
      "POST",
      "/rest/v1/ticket_embedding_chunks",
      params={"on_conflict": "ticket_id,source,chunk_index"},
      json_payload=rows,
      extra_headers={
        "Accept-Profile": "public",
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      timeout=max(REQUEST_TIMEOUT, 180),
    )

  def delete_summary_embeddings_for_ticket_ids(self, ticket_ids: list[int]) -> None:
    if not ticket_ids:
      return

    ids_literal = ",".join(str(ticket_id) for ticket_id in sorted(set(ticket_ids)))
    self._request(
      "DELETE",
      "/rest/v1/ticket_embedding_chunks",
      params={
        "source": "eq.summary",
        "chunk_index": "eq.0",
        "ticket_id": f"in.({ids_literal})",
      },
      extra_headers={"Accept-Profile": "public"},
      timeout=max(REQUEST_TIMEOUT, 180),
    )


def embed_texts(
  api_key: str,
  model: str,
  texts: list[str],
  *,
  batch_size: int = DEFAULT_BATCH_SIZE,
) -> list[list[float]]:
  if not texts:
    return []

  headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json",
  }
  output: list[list[float]] = []

  for start in range(0, len(texts), batch_size):
    batch = texts[start:start + batch_size]
    response = requests.post(
      "https://api.openai.com/v1/embeddings",
      headers=headers,
      json={"model": model, "input": batch},
      timeout=max(REQUEST_TIMEOUT, 180),
    )
    if response.status_code >= 400:
      raise RuntimeError(f"OpenAI embeddings failed ({response.status_code}): {response.text}")

    payload = response.json()
    data = payload.get("data")
    if not isinstance(data, list):
      raise RuntimeError("OpenAI embeddings response missing data[]")

    ordered = sorted(
      [item for item in data if isinstance(item, dict)],
      key=lambda item: int(item.get("index", 0)),
    )
    for item in ordered:
      embedding = item.get("embedding")
      if not isinstance(embedding, list):
        raise RuntimeError("OpenAI embeddings response item missing embedding")
      values: list[float] = []
      for value in embedding:
        if isinstance(value, (float, int)):
          values.append(float(value))
        else:
          raise RuntimeError("OpenAI embedding contains non-numeric value")
      output.append(values)

  if len(output) != len(texts):
    raise RuntimeError("OpenAI embeddings length mismatch")
  return output


def get_skip_reason(
  existing: dict[str, Any] | None,
  *,
  summary_updated_at: str | None,
  content_checksum: str,
  force: bool,
) -> str | None:
  if force or not existing:
    return None

  existing_updated_at = existing.get("summary_updated_at")
  if isinstance(existing_updated_at, str) and summary_updated_at and existing_updated_at == summary_updated_at:
    return "skipped_unchanged_timestamp"

  existing_checksum = existing.get("content_checksum")
  if isinstance(existing_checksum, str) and existing_checksum == content_checksum:
    return "skipped_unchanged_checksum"

  return None


def build_embedding_rows(
  records: list[TicketSummaryRecord],
  vectors: list[list[float]],
) -> list[dict[str, Any]]:
  if len(records) != len(vectors):
    raise RuntimeError("Embedding vector count mismatch while building DB rows")

  now = now_iso()
  rows: list[dict[str, Any]] = []
  for record, vector in zip(records, vectors):
    content_text = record.summary_text
    rows.append(
      {
        "ticket_id": record.ticket_id,
        "brand": record.brand,
        "status": record.status,
        "subject": record.subject,
        "ticket_url": record.ticket_url,
        "zendesk_updated_at": record.zendesk_updated_at,
        "summary_updated_at": record.summary_updated_at,
        "source": "summary",
        "chunk_index": 0,
        "content_text": content_text,
        "content_checksum": compute_checksum(content_text),
        "token_count": len(content_text.split()),
        "embedding": vector_literal(vector),
        "embedded_at": now,
      },
    )
  return rows


def parse_args(argv: list[str]) -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Index summarized support tickets for semantic search.")
  parser.add_argument("--brand", choices=["all", "omni_one", "omni_arena", "unknown"], default="all")
  parser.add_argument("--ticket-id", type=int, default=None, help="Index one summarized ticket by id.")
  parser.add_argument("--ticket-id-min", type=int, default=None, help="Only consider tickets with id >= this value.")
  parser.add_argument("--ticket-id-max", type=int, default=None, help="Only consider tickets with id <= this value.")
  parser.add_argument("--order", choices=["asc", "desc"], default="asc", help="Process ticket ids in ascending or descending order.")
  parser.add_argument("--max-tickets", type=int, default=None)
  parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
  parser.add_argument("--force", action="store_true", help="Reindex summarized tickets even if unchanged.")
  parser.add_argument(
    "--purge-noncanonical-existing",
    action="store_true",
    help="Delete existing summary embeddings for tickets whose cached summary is still legacy/noncanonical.",
  )
  parser.add_argument("--dry-run", action="store_true", help="Read candidates without writing DB rows.")
  parser.add_argument("--embedding-model", default=os.environ.get("OPENAI_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL))
  parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
  return parser.parse_args(argv)


def main(argv: list[str]) -> int:
  load_dotenv(Path(".env"))
  args = parse_args(argv)

  if args.ticket_id_min is not None and args.ticket_id_max is not None and args.ticket_id_min > args.ticket_id_max:
    print("--ticket-id-min cannot be greater than --ticket-id-max.")
    return 1

  supabase_url = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL")
  service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
  openai_api_key = os.environ.get("OPENAI_API_KEY")

  if not supabase_url:
    print("Missing SUPABASE_URL (or VITE_SUPABASE_URL).")
    return 1
  if not service_role_key:
    print("Missing SUPABASE_SERVICE_ROLE_KEY.")
    return 1
  if not args.dry_run and not openai_api_key:
    print("Missing OPENAI_API_KEY.")
    return 1

  client = SupabaseHttpClient(supabase_url, service_role_key)
  counters = {
    "indexed": 0,
    "skipped_unchanged_timestamp": 0,
    "skipped_unchanged_checksum": 0,
    "skipped_legacy_format_summary": 0,
    "skipped_noncanonical_summary": 0,
    "purged_noncanonical_existing": 0,
    "dry_run": 0,
    "errors": 0,
  }

  brand_filter = None if args.brand == "all" else args.brand
  processed = 0
  offset = 0
  page_size = max(1, min(int(args.page_size), 1000))

  while True:
    records = client.list_summarized_tickets(
      brand=brand_filter,
      ticket_id=args.ticket_id,
      ticket_id_min=args.ticket_id_min,
      ticket_id_max=args.ticket_id_max,
      order=args.order,
      limit=page_size,
      offset=offset,
    )
    if not records:
      break

    if args.max_tickets is not None and args.max_tickets >= 0:
      remaining = args.max_tickets - processed
      if remaining <= 0:
        break
      records = records[:remaining]

    print(f"Loaded {len(records)} summarized tickets at offset {offset}.")
    existing_by_id = client.fetch_existing_embeddings([record.ticket_id for record in records])
    to_index: list[TicketSummaryRecord] = []
    index_texts: list[str] = []
    purge_ticket_ids: list[int] = []

    for record in records:
      summary_classification = classify_summary_text(record.summary_text)
      existing_embedding = existing_by_id.get(record.ticket_id)

      if summary_classification != "canonical":
        counter_key = "skipped_legacy_format_summary" if summary_classification == "legacy" else "skipped_noncanonical_summary"
        counters[counter_key] = counters.get(counter_key, 0) + 1

        if args.purge_noncanonical_existing and existing_embedding:
          if args.dry_run:
            counters["dry_run"] += 1
            print(
              f"[DRY-RUN] would purge summary embedding for ticket #{record.ticket_id} "
              f"(classification={summary_classification})"
            )
          else:
            purge_ticket_ids.append(record.ticket_id)
        continue

      content_checksum = compute_checksum(record.summary_text)
      skip_reason = get_skip_reason(
        existing_embedding,
        summary_updated_at=record.summary_updated_at,
        content_checksum=content_checksum,
        force=args.force,
      )
      if skip_reason:
        counters[skip_reason] = counters.get(skip_reason, 0) + 1
        continue

      if args.dry_run:
        counters["dry_run"] += 1
        print(
          f"[DRY-RUN] would index ticket #{record.ticket_id} "
          f"(brand={record.brand}, status={record.status}, checksum={content_checksum[:12]}...)"
        )
        continue

      to_index.append(record)
      index_texts.append(record.summary_text)

    if purge_ticket_ids:
      client.delete_summary_embeddings_for_ticket_ids(purge_ticket_ids)
      counters["purged_noncanonical_existing"] += len(purge_ticket_ids)
      print(f"  -> purged {len(purge_ticket_ids)} noncanonical existing embeddings")

    if to_index:
      assert openai_api_key is not None
      print(f"Embedding {len(to_index)} summarized tickets...")
      vectors = embed_texts(
        openai_api_key,
        args.embedding_model,
        index_texts,
        batch_size=max(1, args.batch_size),
      )
      rows = build_embedding_rows(to_index, vectors)
      for start in range(0, len(rows), 100):
        client.upsert_embedding_rows(rows[start:start + 100])
      counters["indexed"] += len(rows)
      print(f"  -> indexed {len(rows)} tickets")

    processed += len(records)
    if args.ticket_id is not None:
      break
    if len(records) < page_size:
      break
    offset += page_size

  print("\nIndexing summary:")
  print(json.dumps(counters, indent=2))
  return 0 if counters["errors"] == 0 else 2


if __name__ == "__main__":
  raise SystemExit(main(sys.argv[1:]))
