import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeVirtuixRequest, HttpError } from "../_shared/auth.ts";
import { buildModelCandidates, requestChatCompletionWithModelFallback } from "../_shared/openai_chat.ts";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type ChatContext = {
  omni_one_ticket_count?: number;
  omni_arena_ticket_count?: number;
  digest_count?: number;
};

type CopilotCitation = {
  source_type: "document" | "ticket";
  title: string;
  reference: string;
  url?: string | null;
  excerpt?: string | null;
  similarity?: number | null;
  ticket_id?: number | null;
  brand?: string | null;
  status?: string | null;
};

type OpenAiEmbeddingPayload = {
  data?: Array<{
    embedding?: unknown;
  }>;
};

type SupportDocumentChunkMatch = {
  chunk_id: string;
  file_name: string;
  storage_path: string;
  page_number: number | null;
  chunk_text: string;
  similarity: number;
};

type TicketEmbeddingMatch = {
  chunk_id: string;
  ticket_id: number;
  brand: string;
  status: string;
  subject: string;
  ticket_url: string | null;
  zendesk_updated_at: string | null;
  source: string;
  chunk_index: number;
  content_text: string;
  similarity: number;
};

type TicketCandidate = {
  ticket_id: number;
  brand: string;
  status: string;
  subject: string;
  summary_text: string | null;
  zendesk_updated_at: string | null;
  ticket_url: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL");
const OPENAI_MODEL_FALLBACKS = Deno.env.get("OPENAI_MODEL_FALLBACKS");
const OPENAI_EMBEDDING_MODEL = Deno.env.get("OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ACTIVE_TICKET_STATUSES = new Set(["new", "open", "pending"]);
const CANONICAL_TICKET_SUMMARY_MARKERS = ["Issue:", "Troubleshooting:", "Resolution:"];
const LEGACY_TICKET_SUMMARY_MARKERS = ["Ticket Subject:", "Requester:", "Issue Summary:", "Support Actions:", "Recommended Next Step:"];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeRole(value: unknown): ChatMessage["role"] {
  if (value === "assistant" || value === "system" || value === "user") {
    return value;
  }
  return "user";
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item): ChatMessage => {
      const role = normalizeRole(item.role);
      const content = typeof item.content === "string" ? item.content.trim() : "";
      return { role, content };
    })
    .filter((item) => item.content.length > 0)
    .slice(-20);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compactSnippet(value: string | null | undefined, maxLength = 260): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return null;
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function isCanonicalTicketSummaryContent(value: string | null | undefined): boolean {
  if (!value) return false;
  const summary = value.trim();
  if (!summary) return false;
  const hasCanonicalMarkers = CANONICAL_TICKET_SUMMARY_MARKERS.every((marker) => summary.includes(marker));
  const hasLegacyMarkers = LEGACY_TICKET_SUMMARY_MARKERS.some((marker) => summary.includes(marker));
  return hasCanonicalMarkers && !hasLegacyMarkers;
}

function parseLatestUserQuery(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return messages[index].content;
    }
  }
  return "";
}

function queryExplicitlyAsksForActions(query: string): boolean {
  return /\b(next steps?|next actions?|action items?|recommended actions?|recommend(?:ation|ations)?|what should (?:we|i) do|how should (?:we|i) proceed|what now|what's the plan|best actions?)\b/i.test(
    query,
  );
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => value.toFixed(10)).join(",")}]`;
}

async function createQueryEmbedding(query: string): Promise<number[]> {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY secret.");
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

function toDocumentChunkMatch(value: unknown): SupportDocumentChunkMatch | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const chunkId = normalizeOptionalString(row.chunk_id);
  const fileName = normalizeOptionalString(row.file_name);
  const storagePath = normalizeOptionalString(row.storage_path);
  const chunkText = normalizeOptionalString(row.chunk_text);
  const similarity = typeof row.similarity === "number" && Number.isFinite(row.similarity) ? row.similarity : null;
  const pageNumber = typeof row.page_number === "number" && Number.isFinite(row.page_number)
    ? Math.trunc(row.page_number)
    : null;

  if (!chunkId || !fileName || !storagePath || !chunkText || similarity === null) {
    return null;
  }

  return {
    chunk_id: chunkId,
    file_name: fileName,
    storage_path: storagePath,
    page_number: pageNumber,
    chunk_text: chunkText,
    similarity,
  };
}

function toTicketCandidate(value: unknown): TicketCandidate | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const ticketId = typeof row.ticket_id === "number" && Number.isFinite(row.ticket_id) ? Math.trunc(row.ticket_id) : null;
  const brand = normalizeOptionalString(row.brand);
  const status = normalizeOptionalString(row.status);
  const subject = normalizeOptionalString(row.subject);
  const summaryText = normalizeOptionalString(row.summary_text);
  const zendeskUpdatedAt = normalizeOptionalString(row.zendesk_updated_at);
  const ticketUrl = normalizeOptionalString(row.ticket_url);

  if (!ticketId || !brand || !status || !subject) {
    return null;
  }

  return {
    ticket_id: ticketId,
    brand,
    status,
    subject,
    summary_text: summaryText,
    zendesk_updated_at: zendeskUpdatedAt,
    ticket_url: ticketUrl,
  };
}

function toTicketEmbeddingMatch(value: unknown): TicketEmbeddingMatch | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const chunkId = normalizeOptionalString(row.chunk_id);
  const ticketId = typeof row.ticket_id === "number" && Number.isFinite(row.ticket_id) ? Math.trunc(row.ticket_id) : null;
  const brand = normalizeOptionalString(row.brand);
  const status = normalizeOptionalString(row.status);
  const subject = normalizeOptionalString(row.subject);
  const ticketUrl = normalizeOptionalString(row.ticket_url);
  const zendeskUpdatedAt = normalizeOptionalString(row.zendesk_updated_at);
  const source = normalizeOptionalString(row.source);
  const contentText = normalizeOptionalString(row.content_text);
  const chunkIndex = typeof row.chunk_index === "number" && Number.isFinite(row.chunk_index)
    ? Math.trunc(row.chunk_index)
    : null;
  const similarity = typeof row.similarity === "number" && Number.isFinite(row.similarity) ? row.similarity : null;

  if (!chunkId || !ticketId || !brand || !status || !subject || !source || contentText === null || chunkIndex === null || similarity === null) {
    return null;
  }

  return {
    chunk_id: chunkId,
    ticket_id: ticketId,
    brand,
    status,
    subject,
    ticket_url: ticketUrl,
    zendesk_updated_at: zendeskUpdatedAt,
    source,
    chunk_index: chunkIndex,
    content_text: contentText,
    similarity,
  };
}

function parseExplicitTicketId(queryLower: string): number | null {
  const explicitTicketIdMatch = queryLower.match(/(?:^|\s)#?(\d{4,})\b/);
  return explicitTicketIdMatch ? Number.parseInt(explicitTicketIdMatch[1], 10) : null;
}

function parseQueryTokens(queryLower: string): string[] {
  return Array.from(new Set(
    queryLower
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  )).slice(0, 12);
}

function scoreTicket(queryLower: string, tokens: string[], ticket: TicketCandidate, explicitTicketId: number | null): number {
  let score = 0;
  const subjectLower = ticket.subject.toLowerCase();
  const summaryLower = (ticket.summary_text || "").toLowerCase();
  const combined = `${subjectLower}\n${summaryLower}`;

  if (explicitTicketId !== null && ticket.ticket_id === explicitTicketId) {
    score += 100;
  }
  if (subjectLower.includes(queryLower)) {
    score += 18;
  } else if (combined.includes(queryLower)) {
    score += 10;
  }

  for (const token of tokens) {
    if (subjectLower.includes(token)) score += 4;
    if (summaryLower.includes(token)) score += 2;
  }

  if (ACTIVE_TICKET_STATUSES.has(ticket.status.toLowerCase())) {
    score += 2;
  }

  return score;
}

async function fetchDocumentCitations(
  supabaseAdmin: ReturnType<typeof createClient>,
  query: string,
  queryEmbedding: number[] | null,
): Promise<CopilotCitation[]> {
  if (query.trim().length === 0 || !queryEmbedding) return [];

  try {
    const queryEmbeddingLiteral = toVectorLiteral(queryEmbedding);
    const { data, error } = await supabaseAdmin.rpc("match_support_document_chunks", {
      query_embedding: queryEmbeddingLiteral,
      match_count: 4,
      match_brand: null,
      match_top_level_folder: null,
      min_similarity: 0.22,
    });

    if (error) {
      console.warn("Document citation retrieval failed", error.message);
      return [];
    }

    const rawRows = Array.isArray(data) ? data as unknown[] : [];
    const rows = rawRows.map(toDocumentChunkMatch).filter((row): row is SupportDocumentChunkMatch => row !== null);
    return rows.slice(0, 4).map((row: SupportDocumentChunkMatch, index: number) => ({
      source_type: "document" as const,
      title: `Doc ${index + 1}: ${row.file_name}`,
      reference: row.page_number ? `${row.file_name} (p.${row.page_number})` : row.file_name,
      url: null,
      excerpt: compactSnippet(row.chunk_text),
      similarity: Number(row.similarity.toFixed(4)),
      brand: null,
      status: null,
      ticket_id: null,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown document citation retrieval error";
    console.warn("Document citation retrieval failed", message);
    return [];
  }
}

async function fetchSemanticTicketCitations(
  supabaseAdmin: ReturnType<typeof createClient>,
  queryEmbedding: number[] | null,
): Promise<CopilotCitation[]> {
  if (!queryEmbedding) return [];

  try {
    const queryEmbeddingLiteral = toVectorLiteral(queryEmbedding);
    const { data, error } = await supabaseAdmin.rpc("match_ticket_embedding_chunks", {
      query_embedding: queryEmbeddingLiteral,
      match_count: 4,
      match_brand: null,
      match_status: null,
      min_similarity: 0.15,
    });

    if (error) {
      console.warn("Ticket semantic retrieval failed", error.message);
      return [];
    }

    const rawRows = Array.isArray(data) ? data as unknown[] : [];
    const rows = rawRows
      .map(toTicketEmbeddingMatch)
      .filter((row): row is TicketEmbeddingMatch => row !== null)
      .filter((row) => isCanonicalTicketSummaryContent(row.content_text));
    return rows.slice(0, 4).map((row, index) => ({
      source_type: "ticket" as const,
      title: `Ticket ${index + 1}: #${row.ticket_id}`,
      reference: `#${row.ticket_id} • ${row.brand} • ${row.status}`,
      url: row.ticket_url,
      excerpt: compactSnippet(row.content_text),
      similarity: Number(row.similarity.toFixed(4)),
      ticket_id: row.ticket_id,
      brand: row.brand,
      status: row.status,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown ticket semantic retrieval error";
    console.warn("Ticket semantic retrieval failed", message);
    return [];
  }
}

async function fetchLexicalTicketCitations(
  supabaseAdmin: ReturnType<typeof createClient>,
  query: string,
): Promise<CopilotCitation[]> {
  const queryLower = query.trim().toLowerCase();
  if (queryLower.length === 0) return [];

  const explicitTicketId = parseExplicitTicketId(queryLower);
  const tokens = parseQueryTokens(queryLower);

  const { data, error } = await supabaseAdmin
    .from("ticket_cache")
    .select("ticket_id,brand,status,subject,summary_text,zendesk_updated_at,ticket_url")
    .neq("status", "deleted")
    .neq("status", "spam")
    .order("zendesk_updated_at", { ascending: false })
    .limit(350);

  if (error) {
    console.warn("Ticket citation retrieval failed", error.message);
    return [];
  }

  const rows = (data || []).map(toTicketCandidate).filter((row): row is TicketCandidate => row !== null);
  const scored = rows
    .map((ticket) => ({
      ticket,
      score: scoreTicket(queryLower, tokens, ticket, explicitTicketId),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.ticket.zendesk_updated_at || "").localeCompare(a.ticket.zendesk_updated_at || "");
    })
    .slice(0, 4);

  return scored.map((entry, index) => ({
    source_type: "ticket" as const,
    title: `Ticket ${index + 1}: #${entry.ticket.ticket_id}`,
    reference: `#${entry.ticket.ticket_id} • ${entry.ticket.brand} • ${entry.ticket.status}`,
    url: entry.ticket.ticket_url,
    excerpt: compactSnippet(entry.ticket.summary_text || entry.ticket.subject),
    similarity: null,
    ticket_id: entry.ticket.ticket_id,
    brand: entry.ticket.brand,
    status: entry.ticket.status,
  }));
}

function mergeTicketCitations(
  primary: CopilotCitation[],
  secondary: CopilotCitation[],
  maxCount = 4,
): CopilotCitation[] {
  const merged: CopilotCitation[] = [];
  const seen = new Set<string>();

  for (const citation of [...primary, ...secondary]) {
    const key = citation.ticket_id !== null && citation.ticket_id !== undefined
      ? `ticket:${citation.ticket_id}`
      : `${citation.source_type}:${citation.reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(citation);
    if (merged.length >= maxCount) break;
  }

  return merged;
}

async function fetchTicketCitations(
  supabaseAdmin: ReturnType<typeof createClient>,
  query: string,
  queryEmbedding: number[] | null,
): Promise<CopilotCitation[]> {
  const queryLower = query.trim().toLowerCase();
  if (queryLower.length === 0) return [];

  const explicitTicketId = parseExplicitTicketId(queryLower);
  const semantic = await fetchSemanticTicketCitations(supabaseAdmin, queryEmbedding);

  if (explicitTicketId === null && semantic.length >= 4) {
    return semantic;
  }

  const lexical = await fetchLexicalTicketCitations(supabaseAdmin, query);
  return explicitTicketId !== null
    ? mergeTicketCitations(lexical, semantic)
    : mergeTicketCitations(semantic, lexical);
}

function buildEvidenceBlock(documentCitations: CopilotCitation[], ticketCitations: CopilotCitation[]): string {
  const lines: string[] = [];
  if (documentCitations.length > 0) {
    lines.push("Document evidence:");
    documentCitations.forEach((citation, index) => {
      lines.push(`[DOC${index + 1}] ${citation.reference}${citation.excerpt ? ` | ${citation.excerpt}` : ""}`);
    });
  }
  if (ticketCitations.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Ticket evidence:");
    ticketCitations.forEach((citation, index) => {
      lines.push(`[TICKET${index + 1}] ${citation.reference}${citation.excerpt ? ` | ${citation.excerpt}` : ""}`);
    });
  }
  return lines.join("\n");
}

function stripInlineCitationMarkers(value: string): string {
  return value
    .replace(/\s*\[((?:DOC|TICKET)\d+(?:\s*,\s*(?:DOC|TICKET)\d+)*)\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    await authorizeVirtuixRequest(req, { functionName: "copilot_chat" });

    if (!OPENAI_API_KEY) {
      return jsonResponse({ error: "Missing OPENAI_API_KEY secret." }, 500);
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const messages = normalizeMessages(body.messages);
    const context = (typeof body.context === "object" && body.context !== null ? body.context : {}) as ChatContext;

    if (messages.length === 0) {
      return jsonResponse({ error: "messages[] is required." }, 400);
    }

    let supabaseAdmin: ReturnType<typeof createClient> | null = null;
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });
    }

    const latestQuery = parseLatestUserQuery(messages);
    const explicitlyAskedForActions = queryExplicitlyAsksForActions(latestQuery);
    let documentCitations: CopilotCitation[] = [];
    let ticketCitations: CopilotCitation[] = [];
    if (latestQuery.length > 0 && supabaseAdmin) {
      let queryEmbedding: number[] | null = null;
      try {
        queryEmbedding = await createQueryEmbedding(latestQuery);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown query embedding error";
        console.warn("Copilot query embedding failed", message);
      }

      [documentCitations, ticketCitations] = await Promise.all([
        fetchDocumentCitations(supabaseAdmin, latestQuery, queryEmbedding),
        fetchTicketCitations(supabaseAdmin, latestQuery, queryEmbedding),
      ]);
    }
    const citations = [...documentCitations, ...ticketCitations];
    const evidenceBlock = buildEvidenceBlock(documentCitations, ticketCitations);

    const systemPrompt = [
      "You are Virtuix Support Copilot.",
      "Be concise, practical, and grounded in the retrieved evidence.",
      "Answer the user's actual question directly before offering any recommendations.",
      "If evidence is provided, ground your answer in it, but do not include inline citation markers like [DOC1] or [TICKET1] in the user-visible reply.",
      "If evidence is not enough, say exactly what is missing.",
      explicitlyAskedForActions
        ? "The user explicitly asked for recommendations or next steps, so include a short actions section only if it is supported by the evidence."
        : "Do not include a 'next steps', 'next best actions', or recommendation section unless the user explicitly asks for it.",
      "Use short paragraphs by default. Use bullets only when they clearly improve readability.",
      "Do not output bracketed ticket or document citation tags. References are shown separately in the UI citation bubbles.",
      `Current context: omni_one=${context.omni_one_ticket_count ?? "unknown"}, omni_arena=${context.omni_arena_ticket_count ?? "unknown"}, digests=${context.digest_count ?? "unknown"}`,
    ].join(" ");

    const modelCandidates = buildModelCandidates(OPENAI_MODEL, OPENAI_MODEL_FALLBACKS);
    const completion = await requestChatCompletionWithModelFallback({
      apiKey: OPENAI_API_KEY,
      modelCandidates,
      temperature: 0.25,
      messages: [
        { role: "system", content: systemPrompt },
        ...(evidenceBlock.length > 0 ? [{ role: "system" as const, content: `Retrieved evidence:\n${evidenceBlock}` }] : []),
        ...messages,
      ],
    });

    return jsonResponse({
      ok: true,
      reply: stripInlineCitationMarkers(completion.content),
      citations,
      model: completion.model,
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
    const message = error instanceof Error ? error.message : "Unknown copilot error";
    return jsonResponse({ error: message }, 500);
  }
});
