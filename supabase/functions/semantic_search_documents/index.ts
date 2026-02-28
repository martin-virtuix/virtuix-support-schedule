import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeVirtuixRequest, HttpError } from "../_shared/auth.ts";

type BrandFilter = "omni_one" | "omni_arena" | null;

type SearchBody = {
  query: string;
  brand: BrandFilter;
  topLevelFolder: string | null;
  topK: number;
  minSimilarity: number;
};

type OpenAiEmbeddingPayload = {
  data?: Array<{
    embedding?: unknown;
  }>;
  error?: {
    message?: unknown;
  };
};

type MatchChunkRow = {
  chunk_id: string;
  file_id: string;
  brand: string;
  storage_path: string;
  file_name: string;
  top_level_folder: string | null;
  page_number: number | null;
  chunk_text: string;
  similarity: number;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_EMBEDDING_MODEL = Deno.env.get("OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBrandFilter(value: unknown): BrandFilter {
  if (value === "omni_one" || value === "omni_arena") {
    return value;
  }
  return null;
}

function parseTopK(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(20, Math.trunc(value)));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(20, parsed));
    }
  }
  return 8;
}

function parseMinSimilarity(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(-1, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.max(-1, Math.min(1, parsed));
    }
  }
  return 0.2;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => value.toFixed(10)).join(",")}]`;
}

function parseBody(raw: unknown): SearchBody {
  const body = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const query = normalizeOptionalString(body.query);
  if (!query) {
    throw new HttpError(400, "query is required.", "validation_query_required");
  }
  if (query.length > 4000) {
    throw new HttpError(400, "query is too long (max 4000 characters).", "validation_query_too_long");
  }

  return {
    query,
    brand: parseBrandFilter(body.brand),
    topLevelFolder: normalizeOptionalString(body.top_level_folder),
    topK: parseTopK(body.top_k),
    minSimilarity: parseMinSimilarity(body.min_similarity),
  };
}

async function createQueryEmbedding(query: string): Promise<number[]> {
  if (!OPENAI_API_KEY) {
    throw new HttpError(500, "Missing OPENAI_API_KEY secret.", "embedding_api_key_missing");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: query,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI embeddings request failed (${response.status}): ${text}`);
  }

  let payload: OpenAiEmbeddingPayload;
  try {
    payload = JSON.parse(text) as OpenAiEmbeddingPayload;
  } catch {
    throw new Error("OpenAI embeddings returned malformed JSON.");
  }

  const embeddingValue = payload.data?.[0]?.embedding;
  if (!Array.isArray(embeddingValue) || embeddingValue.length === 0) {
    throw new Error("OpenAI embeddings response missing embedding data.");
  }

  const embedding: number[] = embeddingValue.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("OpenAI embeddings response contains invalid vector value.");
    }
    return value;
  });

  return embedding;
}

function compactSnippet(chunkText: string, maxLength = 320): string {
  const compact = chunkText.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function toMatchRow(value: unknown): MatchChunkRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const chunkId = normalizeOptionalString(row.chunk_id);
  const fileId = normalizeOptionalString(row.file_id);
  const brand = normalizeOptionalString(row.brand);
  const storagePath = normalizeOptionalString(row.storage_path);
  const fileName = normalizeOptionalString(row.file_name);
  const chunkText = normalizeOptionalString(row.chunk_text);
  const topLevelFolder = normalizeOptionalString(row.top_level_folder);
  const pageNumber = typeof row.page_number === "number" && Number.isFinite(row.page_number)
    ? Math.trunc(row.page_number)
    : null;
  const similarity = typeof row.similarity === "number" && Number.isFinite(row.similarity) ? row.similarity : null;

  if (!chunkId || !fileId || !brand || !storagePath || !fileName || !chunkText || similarity === null) {
    return null;
  }

  return {
    chunk_id: chunkId,
    file_id: fileId,
    brand,
    storage_path: storagePath,
    file_name: fileName,
    top_level_folder: topLevelFolder,
    page_number: pageNumber,
    chunk_text: chunkText,
    similarity,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Missing Supabase configuration for semantic search." }, 500);
  }

  try {
    await authorizeVirtuixRequest(req, { functionName: "semantic_search_documents" });

    const body = parseBody(await req.json().catch(() => ({})));
    const embedding = await createQueryEmbedding(body.query);
    const queryEmbedding = toVectorLiteral(embedding);

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabaseAdmin.rpc("match_support_document_chunks", {
      query_embedding: queryEmbedding,
      match_count: body.topK,
      match_brand: body.brand,
      match_top_level_folder: body.topLevelFolder,
      min_similarity: body.minSimilarity,
    });

    if (error) {
      throw new Error(`Document semantic search failed: ${error.message}`);
    }

    const rows = Array.isArray(data) ? data.map(toMatchRow).filter((row): row is MatchChunkRow => row !== null) : [];
    const results = rows.map((row) => ({
      chunk_id: row.chunk_id,
      file_id: row.file_id,
      brand: row.brand,
      storage_path: row.storage_path,
      file_name: row.file_name,
      top_level_folder: row.top_level_folder,
      page_number: row.page_number,
      similarity: Number(row.similarity.toFixed(4)),
      snippet: compactSnippet(row.chunk_text),
    }));

    return jsonResponse({
      ok: true,
      query: body.query,
      model: OPENAI_EMBEDDING_MODEL,
      count: results.length,
      results,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(
        {
          error: error.message,
          code: error.code,
          ...(error.publicDetails ?? {}),
        },
        error.status,
      );
    }

    const message = error instanceof Error ? error.message : "Unknown semantic search error";
    return jsonResponse({ error: message }, 500);
  }
});
