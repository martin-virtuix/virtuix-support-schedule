#!/usr/bin/env python3
"""
Index Support Hub knowledge-base PDFs into semantic-search tables.

Targets:
  - support-documents/omni_one/knowledge_base/**
  - support-documents/omni_arena/knowledge_base/**

Requirements:
  - Python packages: requests, pypdf
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
import re
import sys
import time
from collections import deque
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import quote

try:
  import requests
except Exception:  # pragma: no cover - import guard for runtime clarity
  print("Missing dependency: requests. Install with `python3 -m pip install requests`.")
  raise

try:
  from pypdf import PdfReader
except Exception:  # pragma: no cover - import guard for runtime clarity
  print("Missing dependency: pypdf. Install with `python3 -m pip install pypdf`.")
  raise


DEFAULT_BUCKET = "support-documents"
BRANDS = ("omni_one", "omni_arena")
KB_ROOT = "knowledge_base"
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
DEFAULT_CHUNK_SIZE = 1200
DEFAULT_CHUNK_OVERLAP = 200
DEFAULT_BATCH_SIZE = 64
REQUEST_TIMEOUT = 90


@dataclass
class DocumentObject:
  brand: str
  storage_path: str
  file_name: str
  top_level_folder: str
  size_bytes: int | None
  updated_at: str | None


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


def normalize_path(path: str) -> str:
  path = path.strip().lstrip("/")
  path = re.sub(r"/{2,}", "/", path)
  return path.rstrip("/")


def resolve_storage_item_path(folder: str, item_name: str, brand: str) -> str:
  name = item_name.lstrip("/")
  if name.startswith(f"{brand}/"):
    return normalize_path(name)
  return normalize_path(f"{folder}/{name}")


def parse_size_bytes(item: dict[str, Any]) -> int | None:
  metadata = item.get("metadata")
  if isinstance(metadata, dict):
    size = metadata.get("size")
    if isinstance(size, int):
      return size
    if isinstance(size, str) and size.isdigit():
      return int(size)
  return None


def clean_text(text: str) -> str:
  text = text.replace("\x00", " ")
  text = re.sub(r"\s+", " ", text)
  return text.strip()


def extract_top_level_folder(storage_path: str, brand: str) -> str:
  normalized = normalize_path(storage_path)
  prefix = f"{brand}/{KB_ROOT}/"
  if not normalized.startswith(prefix):
    return KB_ROOT

  relative = normalized[len(prefix):]
  if "/" not in relative:
    return KB_ROOT

  first_segment = relative.split("/", 1)[0].strip()
  return first_segment or KB_ROOT


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
  if not text:
    return []
  if chunk_size <= 0:
    raise ValueError("chunk_size must be > 0")
  if overlap < 0:
    raise ValueError("chunk_overlap must be >= 0")
  if overlap >= chunk_size:
    raise ValueError("chunk_overlap must be smaller than chunk_size")

  chunks: list[str] = []
  cursor = 0
  step = chunk_size - overlap

  while cursor < len(text):
    window = text[cursor:cursor + chunk_size].strip()
    if window:
      chunks.append(window)
    cursor += step

  return chunks


def vector_literal(values: list[float]) -> str:
  return "[" + ",".join(f"{value:.10f}" for value in values) + "]"


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

  def list_objects(self, bucket: str, folder: str, *, limit: int, offset: int) -> list[dict[str, Any]]:
    data = self._request(
      "POST",
      f"/storage/v1/object/list/{quote(bucket, safe='')}",
      json_payload={
        "prefix": folder,
        "limit": limit,
        "offset": offset,
        "sortBy": {"column": "name", "order": "asc"},
      },
    )
    if not isinstance(data, list):
      return []
    return [item for item in data if isinstance(item, dict)]

  def download_object(self, bucket: str, storage_path: str) -> bytes:
    path = f"/storage/v1/object/{quote(bucket, safe='')}/{quote(storage_path, safe='/')}"
    data = self._request("GET", path, timeout=max(REQUEST_TIMEOUT, 180))
    if isinstance(data, bytes):
      return data
    raise RuntimeError(f"Unexpected non-bytes response while downloading {storage_path}")

  def fetch_existing_file(self, bucket: str, storage_path: str) -> dict[str, Any] | None:
    data = self._request(
      "GET",
      "/rest/v1/support_document_files",
      params={
        "select": "id,storage_updated_at,content_checksum",
        "bucket": f"eq.{bucket}",
        "storage_path": f"eq.{storage_path}",
        "limit": 1,
      },
      extra_headers={"Accept-Profile": "public"},
    )
    if isinstance(data, list) and data:
      first = data[0]
      if isinstance(first, dict):
        return first
    return None

  def upsert_file(self, row: dict[str, Any]) -> dict[str, Any]:
    data = self._request(
      "POST",
      "/rest/v1/support_document_files",
      params={"on_conflict": "bucket,storage_path"},
      json_payload=row,
      extra_headers={
        "Accept-Profile": "public",
        "Prefer": "resolution=merge-duplicates,return=representation",
      },
    )
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
      raise RuntimeError("support_document_files upsert returned no row")
    return data[0]

  def delete_chunks_for_file(self, file_id: str) -> None:
    self._request(
      "DELETE",
      "/rest/v1/support_document_chunks",
      params={"file_id": f"eq.{file_id}"},
      extra_headers={"Accept-Profile": "public"},
    )

  def insert_chunks(self, chunk_rows: list[dict[str, Any]]) -> None:
    if not chunk_rows:
      return
    self._request(
      "POST",
      "/rest/v1/support_document_chunks",
      json_payload=chunk_rows,
      extra_headers={
        "Accept-Profile": "public",
        "Prefer": "return=minimal",
      },
      timeout=max(REQUEST_TIMEOUT, 180),
    )


def list_pdf_documents_for_brand(client: SupabaseHttpClient, bucket: str, brand: str) -> list[DocumentObject]:
  root = f"{brand}/{KB_ROOT}"
  queue: deque[str] = deque([root, f"{root}/"])
  visited_folders: set[str] = set()
  queued_folders: set[str] = {normalize_path(path) for path in queue}
  seen_paths: set[str] = set()
  discovered: list[DocumentObject] = []

  while queue:
    folder = normalize_path(queue.popleft())
    queued_folders.discard(folder)
    if not folder or folder in visited_folders:
      continue

    visited_folders.add(folder)
    offset = 0
    while True:
      page = client.list_objects(bucket, folder, limit=100, offset=offset)
      for item in page:
        name = str(item.get("name", "")).strip()
        if not name:
          continue

        full_path = resolve_storage_item_path(folder, name, brand)
        is_pdf = name.lower().endswith(".pdf")
        item_id = item.get("id")
        size_bytes = parse_size_bytes(item)
        updated_at = item.get("updated_at")
        known_file = bool(item_id) or size_bytes is not None or isinstance(updated_at, str)
        looks_like_folder = (
          not is_pdf
          and (name.strip() == "" or (not known_file and "." not in name))
        )

        if looks_like_folder:
          child = normalize_path(full_path)
          if child and child not in visited_folders and child not in queued_folders:
            queue.append(child)
            queued_folders.add(child)
          continue

        if not is_pdf:
          continue

        normalized = normalize_path(full_path)
        if normalized in seen_paths:
          continue
        if not normalized.startswith(f"{brand}/{KB_ROOT}/"):
          continue

        seen_paths.add(normalized)
        discovered.append(
          DocumentObject(
            brand=brand,
            storage_path=normalized,
            file_name=Path(normalized).name,
            top_level_folder=extract_top_level_folder(normalized, brand),
            size_bytes=size_bytes,
            updated_at=updated_at if isinstance(updated_at, str) else None,
          ),
        )

      if len(page) < 100:
        break
      offset += 100

  discovered.sort(key=lambda item: item.storage_path)
  return discovered


def extract_page_chunks(
  pdf_bytes: bytes,
  *,
  chunk_size: int,
  chunk_overlap: int,
) -> tuple[list[dict[str, Any]], int, str]:
  reader = PdfReader(BytesIO(pdf_bytes))
  page_chunks: list[dict[str, Any]] = []
  checksum_parts: list[str] = []
  chunk_index = 0

  for page_number, page in enumerate(reader.pages, start=1):
    raw = page.extract_text() or ""
    text = clean_text(raw)
    if not text:
      continue

    checksum_parts.append(text)
    for chunk in chunk_text(text, chunk_size, chunk_overlap):
      page_chunks.append(
        {
          "chunk_index": chunk_index,
          "page_number": page_number,
          "chunk_text": chunk,
          "token_count": len(chunk.split()),
        },
      )
      chunk_index += 1

  checksum_payload = "\n".join(checksum_parts).encode("utf-8")
  checksum = hashlib.sha256(checksum_payload).hexdigest()
  return page_chunks, len(reader.pages), checksum


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


def should_skip_reindex(
  existing: dict[str, Any] | None,
  *,
  storage_updated_at: str | None,
  content_checksum: str | None,
  force: bool,
) -> bool:
  if force or not existing:
    return False

  existing_updated_at = existing.get("storage_updated_at")
  if isinstance(existing_updated_at, str) and storage_updated_at and existing_updated_at == storage_updated_at:
    return True

  existing_checksum = existing.get("content_checksum")
  if isinstance(existing_checksum, str) and content_checksum and existing_checksum == content_checksum:
    return True

  return False


def index_single_document(
  client: SupabaseHttpClient,
  *,
  bucket: str,
  document: DocumentObject,
  openai_api_key: str | None,
  embedding_model: str,
  chunk_size: int,
  chunk_overlap: int,
  dry_run: bool,
  force: bool,
) -> str:
  existing = client.fetch_existing_file(bucket, document.storage_path)

  if should_skip_reindex(existing, storage_updated_at=document.updated_at, content_checksum=None, force=force):
    return "skipped_unchanged_timestamp"

  pdf_bytes = client.download_object(bucket, document.storage_path)
  chunks, page_count, checksum = extract_page_chunks(
    pdf_bytes,
    chunk_size=chunk_size,
    chunk_overlap=chunk_overlap,
  )

  if should_skip_reindex(existing, storage_updated_at=document.updated_at, content_checksum=checksum, force=force):
    return "skipped_unchanged_checksum"

  if dry_run:
    print(
      f"[DRY-RUN] would index {document.storage_path} "
      f"(pages={page_count}, chunks={len(chunks)}, checksum={checksum[:12]}...)"
    )
    return "dry_run"

  if not openai_api_key:
    raise RuntimeError("OPENAI_API_KEY is required unless --dry-run is used")

  file_row = client.upsert_file(
    {
      "bucket": bucket,
      "brand": document.brand,
      "storage_path": document.storage_path,
      "file_name": document.file_name,
      "top_level_folder": document.top_level_folder,
      "size_bytes": document.size_bytes,
      "storage_updated_at": document.updated_at,
      "page_count": page_count,
      "content_checksum": checksum,
      "indexed_at": now_iso(),
    },
  )

  file_id = file_row.get("id")
  if not isinstance(file_id, str) or not file_id:
    raise RuntimeError(f"Upserted file row missing id for {document.storage_path}")

  client.delete_chunks_for_file(file_id)
  if not chunks:
    return "indexed_empty_text"

  texts = [item["chunk_text"] for item in chunks]
  vectors = embed_texts(openai_api_key, embedding_model, texts)

  rows: list[dict[str, Any]] = []
  for chunk, vector in zip(chunks, vectors):
    rows.append(
      {
        "file_id": file_id,
        "brand": document.brand,
        "storage_path": document.storage_path,
        "top_level_folder": document.top_level_folder,
        "chunk_index": chunk["chunk_index"],
        "page_number": chunk["page_number"],
        "chunk_text": chunk["chunk_text"],
        "token_count": chunk["token_count"],
        "embedding": vector_literal(vector),
      },
    )

  for start in range(0, len(rows), 100):
    client.insert_chunks(rows[start:start + 100])

  return "indexed"


def parse_args(argv: list[str]) -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Index support KB PDFs for semantic search.")
  parser.add_argument("--bucket", default=os.environ.get("VITE_SUPPORT_DOCUMENTS_BUCKET", DEFAULT_BUCKET))
  parser.add_argument("--brand", choices=["all", "omni_one", "omni_arena"], default="all")
  parser.add_argument("--max-files", type=int, default=None)
  parser.add_argument("--force", action="store_true", help="Reindex all documents even if unchanged.")
  parser.add_argument("--dry-run", action="store_true", help="Parse and chunk without writing DB rows.")
  parser.add_argument("--embedding-model", default=os.environ.get("OPENAI_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL))
  parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE)
  parser.add_argument("--chunk-overlap", type=int, default=DEFAULT_CHUNK_OVERLAP)
  return parser.parse_args(argv)


def main(argv: list[str]) -> int:
  load_dotenv(Path(".env"))
  args = parse_args(argv)

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
  brands = BRANDS if args.brand == "all" else (args.brand,)

  all_docs: list[DocumentObject] = []
  for brand in brands:
    docs = list_pdf_documents_for_brand(client, args.bucket, brand)
    print(f"Discovered {len(docs)} PDFs for {brand}.")
    all_docs.extend(docs)

  if args.max_files is not None and args.max_files >= 0:
    all_docs = all_docs[:args.max_files]

  counters = {
    "indexed": 0,
    "indexed_empty_text": 0,
    "skipped_unchanged_timestamp": 0,
    "skipped_unchanged_checksum": 0,
    "dry_run": 0,
    "errors": 0,
  }

  for idx, document in enumerate(all_docs, start=1):
    print(f"[{idx}/{len(all_docs)}] Processing {document.storage_path}")
    try:
      result = index_single_document(
        client,
        bucket=args.bucket,
        document=document,
        openai_api_key=openai_api_key,
        embedding_model=args.embedding_model,
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
        dry_run=args.dry_run,
        force=args.force,
      )
      counters[result] = counters.get(result, 0) + 1
      print(f"  -> {result}")
    except Exception as error:
      counters["errors"] += 1
      print(f"  -> error: {error}")

  print("\nIndexing summary:")
  print(json.dumps(counters, indent=2))
  return 0 if counters["errors"] == 0 else 2


if __name__ == "__main__":
  raise SystemExit(main(sys.argv[1:]))
