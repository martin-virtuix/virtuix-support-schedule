import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeVirtuixRequest, HttpError } from "../_shared/auth.ts";
import { buildModelCandidates, requestChatCompletionWithModelFallback } from "../_shared/openai_chat.ts";

type TicketRow = {
  ticket_id: number;
  brand: string;
  subject: string;
  status: string;
  priority: string | null;
  requester_name: string | null;
  requester_email: string | null;
  zendesk_created_at: string | null;
  zendesk_updated_at: string | null;
  ticket_url: string | null;
  summary_text: string | null;
  raw_payload: Record<string, unknown> | null;
};

type EnrichedComment = {
  id: number | string | null;
  created_at: string | null;
  public: boolean | null;
  author_id: number | null;
  author_role: "requester" | "support_or_internal" | "unknown";
  body: string;
};

type EnrichedTicket = {
  ticket_id: number;
  brand: string;
  subject: string;
  status: string;
  priority: string;
  requester_name: string;
  requester_email: string;
  requester_phone: string;
  zendesk_created_at: string | null;
  zendesk_updated_at: string | null;
  summary_text: string;
  comments: EnrichedComment[];
};

type DigestFilters = {
  brand?: string;
  status?: string;
  limit?: number;
  search?: string;
};

type GeneratedDigest = {
  markdown: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL");
const OPENAI_MODEL_FALLBACKS = Deno.env.get("OPENAI_MODEL_FALLBACKS");
const ZENDESK_SUBDOMAIN = Deno.env.get("ZENDESK_SUBDOMAIN");
const ZENDESK_EMAIL = Deno.env.get("ZENDESK_EMAIL");
const ZENDESK_API_TOKEN = Deno.env.get("ZENDESK_API_TOKEN");

const DEFAULT_DIGEST_SYSTEM_PROMPT = `You are a Support Operations Digest Analyst.

Your task:
Review all provided open tickets (one at a time), extract the key information from each, and generate a structured digest suitable for internal team meetings.

IMPORTANT RULES:
- Use ONLY the information provided.
- Do NOT invent ticket data.
- Do NOT summarize tickets that are not included.
- Keep summaries concise but informative.
- Focus on: what the issue is and what is being done next.
- Avoid unnecessary narrative text.
- For each ticket, incorporate all available comments:
  - public replies (public=true)
  - internal notes (public=false)

----------------------------------------
STEP 1 -- PER TICKET ANALYSIS
----------------------------------------

For each ticket, extract:

- Ticket ID
- Requester Name
- Requester Email
- Requester Phone (or "Not provided")
- Created At
- Updated At
- Subject
- Short issue summary
- Current status (if provided)
- Current action being taken
- Next action being taken

----------------------------------------
STEP 2 -- OUTPUT FORMAT
----------------------------------------

First, generate a structured table:

| Ticket ID | Requester | Created At | Updated At | Subject |

Requester must be rendered as:
<Name> | <Email> | <Phone>

Then, below the table, create:

----------------------------------------
Open Ticket Summary Overview
----------------------------------------

For each ticket, use this format:

Ticket ID: <ID>
Requester: <Name> | <Email> | <Phone>
Issue: <1-3 concise sentences describing the problem>
Current Action: <What support has done so far>
Next Step: <Clear upcoming action or pending item>

----------------------------------------

Objective:
Provide a clear operational overview for team meetings.
Expose patterns, urgency, and bottlenecks if visible.
Keep it concise.
No fluff.
No repetition of full conversations.

Tone:
Professional.
Operational.
Direct.
Internal-use only.`;

const DIGEST_SYSTEM_PROMPT = (Deno.env.get("DIGEST_SYSTEM_PROMPT") || DEFAULT_DIGEST_SYSTEM_PROMPT).trim();

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeTicketIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "number" ? item : typeof item === "string" ? Number.parseInt(item, 10) : NaN))
        .filter((item) => Number.isFinite(item)),
    ),
  );
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function safeIso(value: string | null): string {
  if (!value) return "Not provided";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function cleanModelContent(rawContent: string): string {
  const trimmed = rawContent.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  if (lines.length < 3) {
    return trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
  }

  const last = lines[lines.length - 1]?.trim();
  if (last !== "```") {
    return trimmed;
  }

  return lines.slice(1, -1).join("\n").trim();
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function getMissingZendeskEnvVars(): string[] {
  const missing: string[] = [];
  if (!ZENDESK_SUBDOMAIN) missing.push("ZENDESK_SUBDOMAIN");
  if (!ZENDESK_EMAIL) missing.push("ZENDESK_EMAIL");
  if (!ZENDESK_API_TOKEN) missing.push("ZENDESK_API_TOKEN");
  return missing;
}

function getRetryAfterMs(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) return null;
  const seconds = Number.parseFloat(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }
  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchZendeskWithRetry(
  url: string,
  authHeader: string,
  options: { allowNotFound?: boolean } = {},
): Promise<Response> {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      return response;
    }

    if (response.status === 404 && options.allowNotFound) {
      return response;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      const bodyText = await response.text();
      throw new Error(`Zendesk API error (${response.status}): ${bodyText}`);
    }

    const retryAfterMs = getRetryAfterMs(response.headers.get("retry-after"));
    const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
    await sleep(retryAfterMs ?? backoffMs);
  }

  throw new Error("Zendesk retry loop exited unexpectedly");
}

function getRequesterFromObject(value: unknown): { name: string | null; email: string | null; phone: string | null } {
  if (!value || typeof value !== "object") {
    return { name: null, email: null, phone: null };
  }

  const requester = value as Record<string, unknown>;
  return {
    name: normalizeString(requester.name),
    email: normalizeString(requester.email),
    phone: normalizeString(requester.phone),
  };
}

function normalizeCommentBody(comment: Record<string, unknown>): string {
  const plainBody = normalizeString(comment.plain_body);
  if (plainBody) return plainBody;

  const body = normalizeString(comment.body);
  if (body) return body;

  return "Not provided";
}

async function fetchZendeskTicketDetails(ticketId: number, authHeader: string): Promise<Record<string, unknown>> {
  const response = await fetchZendeskWithRetry(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`,
    authHeader,
  );

  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!payload.ticket || typeof payload.ticket !== "object") {
    throw new Error(`Zendesk ticket payload missing ticket object for #${ticketId}`);
  }

  return payload.ticket as Record<string, unknown>;
}

async function fetchZendeskUser(userId: number, authHeader: string): Promise<Record<string, unknown> | null> {
  const response = await fetchZendeskWithRetry(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${userId}.json`,
    authHeader,
    { allowNotFound: true },
  );

  if (response.status === 404) {
    return null;
  }

  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!payload.user || typeof payload.user !== "object") {
    return null;
  }

  return payload.user as Record<string, unknown>;
}

async function fetchTicketComments(
  ticketId: number,
  requesterId: number | null,
  authHeader: string,
): Promise<EnrichedComment[]> {
  let nextPage = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/comments.json?sort_order=asc`;
  let page = 0;
  const maxPages = 30;
  const allComments: EnrichedComment[] = [];

  while (nextPage && page < maxPages) {
    const response = await fetchZendeskWithRetry(nextPage, authHeader);
    const payload = await response.json().catch(() => ({} as Record<string, unknown>));

    const comments: unknown[] = Array.isArray(payload.comments) ? payload.comments : [];
    comments.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const comment = item as Record<string, unknown>;
      const authorId = parseOptionalInteger(comment.author_id);
      const publicFlag = typeof comment.public === "boolean" ? comment.public : null;

      let authorRole: EnrichedComment["author_role"] = "unknown";
      if (requesterId !== null && authorId !== null && authorId === requesterId) {
        authorRole = "requester";
      } else if (publicFlag === true || publicFlag === false) {
        authorRole = "support_or_internal";
      }

      allComments.push({
        id: typeof comment.id === "string" || typeof comment.id === "number" ? comment.id : null,
        created_at: normalizeString(comment.created_at),
        public: publicFlag,
        author_id: authorId,
        author_role: authorRole,
        body: normalizeCommentBody(comment),
      });
    });

    nextPage = typeof payload.next_page === "string" ? payload.next_page : "";
    page += 1;
  }

  return allComments;
}

function buildRequesterDisplay(name: string, email: string, phone: string): string {
  return `${name} | ${email} | ${phone}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function enrichTicketForDigest(
  ticket: TicketRow,
  authHeader: string,
  requesterCache: Map<number, Promise<Record<string, unknown> | null>>,
): Promise<EnrichedTicket> {
  const rawPayload = (ticket.raw_payload && typeof ticket.raw_payload === "object")
    ? ticket.raw_payload as Record<string, unknown>
    : {};

  const zendeskTicket = await fetchZendeskTicketDetails(ticket.ticket_id, authHeader);

  const requesterFromRaw = getRequesterFromObject(rawPayload.requester);
  const requesterFromTicketDetails = getRequesterFromObject(zendeskTicket.requester);

  const requesterId = parseOptionalInteger(zendeskTicket.requester_id) ?? parseOptionalInteger(rawPayload.requester_id);

  let requesterUser: Record<string, unknown> | null = null;
  if (requesterId !== null) {
    let existingPromise = requesterCache.get(requesterId);
    if (!existingPromise) {
      existingPromise = fetchZendeskUser(requesterId, authHeader);
      requesterCache.set(requesterId, existingPromise);
    }
    requesterUser = await existingPromise;
  }

  const requesterFromUser = getRequesterFromObject(requesterUser);

  const requesterName = firstNonEmpty([
    normalizeString(ticket.requester_name),
    requesterFromRaw.name,
    requesterFromTicketDetails.name,
    requesterFromUser.name,
  ]) || "Not provided";

  const requesterEmail = firstNonEmpty([
    normalizeString(ticket.requester_email),
    requesterFromRaw.email,
    requesterFromTicketDetails.email,
    requesterFromUser.email,
  ]) || "Not provided";

  const requesterPhone = firstNonEmpty([
    requesterFromRaw.phone,
    requesterFromTicketDetails.phone,
    requesterFromUser.phone,
  ]) || "Not provided";

  const comments = await fetchTicketComments(ticket.ticket_id, requesterId, authHeader);

  return {
    ticket_id: ticket.ticket_id,
    brand: firstNonEmpty([normalizeString(ticket.brand), normalizeString(zendeskTicket.brand)]) || "Not provided",
    subject: firstNonEmpty([normalizeString(ticket.subject), normalizeString(zendeskTicket.subject)]) || "Not provided",
    status: firstNonEmpty([normalizeString(ticket.status), normalizeString(zendeskTicket.status)]) || "Not provided",
    priority: firstNonEmpty([normalizeString(ticket.priority), normalizeString(zendeskTicket.priority)]) || "Not provided",
    requester_name: requesterName,
    requester_email: requesterEmail,
    requester_phone: requesterPhone,
    zendesk_created_at: firstNonEmpty([
      normalizeString(ticket.zendesk_created_at),
      normalizeString(zendeskTicket.created_at),
      normalizeString(rawPayload.created_at),
    ]),
    zendesk_updated_at: firstNonEmpty([
      normalizeString(ticket.zendesk_updated_at),
      normalizeString(zendeskTicket.updated_at),
      normalizeString(rawPayload.updated_at),
    ]),
    summary_text: firstNonEmpty([normalizeString(ticket.summary_text), normalizeString(ticket.subject)]) || "Not provided",
    comments,
  };
}

function compactTicketForPrompt(ticket: EnrichedTicket): Record<string, unknown> {
  return {
    ticket_id: ticket.ticket_id,
    requester_name: ticket.requester_name,
    requester_email: ticket.requester_email,
    requester_phone: ticket.requester_phone,
    requester: buildRequesterDisplay(ticket.requester_name, ticket.requester_email, ticket.requester_phone),
    created_at: safeIso(ticket.zendesk_created_at),
    updated_at: safeIso(ticket.zendesk_updated_at),
    subject: ticket.subject,
    current_status: ticket.status,
    brand: ticket.brand,
    priority: ticket.priority,
    existing_summary: ticket.summary_text,
    comments: ticket.comments,
  };
}

function buildFallbackDigestMarkdown(title: string, tickets: EnrichedTicket[]): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push("| Ticket ID | Requester | Created At | Updated At | Subject |");
  lines.push("|---|---|---|---|---|");

  tickets.forEach((ticket) => {
    const requester = buildRequesterDisplay(ticket.requester_name, ticket.requester_email, ticket.requester_phone);
    lines.push(
      `| ${ticket.ticket_id} | ${escapePipes(requester)} | ${safeIso(ticket.zendesk_created_at)} | ${safeIso(ticket.zendesk_updated_at)} | ${escapePipes(ticket.subject || "Not provided")} |`,
    );
  });

  lines.push("");
  lines.push("Open Ticket Summary Overview");
  lines.push("");

  tickets.forEach((ticket) => {
    const requester = buildRequesterDisplay(ticket.requester_name, ticket.requester_email, ticket.requester_phone);
    const publicCount = ticket.comments.filter((comment) => comment.public === true).length;
    const internalCount = ticket.comments.filter((comment) => comment.public === false).length;

    lines.push(`Ticket ID: ${ticket.ticket_id}`);
    lines.push(`Requester: ${requester}`);
    lines.push(`Issue: ${ticket.summary_text}`);
    lines.push(`Current Action: Status is ${ticket.status}. Comments reviewed: ${ticket.comments.length} total (${publicCount} public, ${internalCount} internal).`);
    lines.push("Next Step: Review latest ticket updates and advance the assigned support action.");
    lines.push("");
  });

  return lines.join("\n").trim();
}

async function generateDigestMarkdown(title: string, tickets: EnrichedTicket[], filters: DigestFilters): Promise<GeneratedDigest> {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing required environment variable: OPENAI_API_KEY");
  }

  const prompt = {
    title,
    generated_at: new Date().toISOString(),
    filters,
    output_constraints: [
      "Return markdown only.",
      "Do not wrap output in markdown code fences.",
      "Use exactly this table header: | Ticket ID | Requester | Created At | Updated At | Subject |",
      "Requester format must be: Name | Email | Phone.",
      "Use only the ticket list provided in this request.",
      "Use all comments provided per ticket, including public replies and internal notes.",
      "If a field is unavailable, use \"Not provided\".",
    ],
    tickets: tickets.map((ticket) => compactTicketForPrompt(ticket)),
  };

  const modelCandidates = buildModelCandidates(OPENAI_MODEL, OPENAI_MODEL_FALLBACKS);
  const completion = await requestChatCompletionWithModelFallback({
    apiKey: OPENAI_API_KEY,
    modelCandidates,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: DIGEST_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: JSON.stringify(prompt),
      },
    ],
  });

  const cleaned = cleanModelContent(completion.content);
  const markdown = cleaned || buildFallbackDigestMarkdown(title, tickets);
  return {
    markdown: markdown.startsWith("#") ? markdown : `# ${title}\n\n${markdown}`,
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
    return jsonResponse({ error: "Missing Supabase service role configuration." }, 500);
  }

  try {
    await authorizeVirtuixRequest(req, { functionName: "create_digest" });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const title = typeof body.title === "string" && body.title.trim().length > 0
      ? body.title.trim()
      : `Support Digest ${new Date().toISOString().slice(0, 10)}`;

    const ticketIds = normalizeTicketIds(body.ticket_ids);
    const filters = (typeof body.filters === "object" && body.filters !== null ? body.filters : {}) as DigestFilters;

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    let query = supabaseAdmin
      .from("ticket_cache")
      .select("ticket_id,brand,subject,status,priority,requester_name,requester_email,zendesk_created_at,zendesk_updated_at,ticket_url,summary_text,raw_payload")
      .order("zendesk_updated_at", { ascending: false });

    if (ticketIds.length > 0) {
      query = query.in("ticket_id", ticketIds);
    } else {
      if (filters.brand && filters.brand !== "all") {
        query = query.eq("brand", filters.brand);
      }
      if (filters.status && filters.status !== "all") {
        query = query.eq("status", filters.status);
      }
      if (filters.search && filters.search.trim().length > 0) {
        query = query.ilike("subject", `%${filters.search.trim()}%`);
      }
      query = query.limit(Math.min(Math.max(filters.limit ?? 20, 1), 100));
    }

    const { data: tickets, error: ticketsError } = await query;
    if (ticketsError) {
      throw new Error(`Failed to load tickets for digest: ${ticketsError.message}`);
    }

    const ticketRows = (tickets ?? []) as TicketRow[];
    if (ticketRows.length === 0) {
      return jsonResponse({ error: "No tickets matched for digest generation." }, 400);
    }

    const missingZendeskEnv = getMissingZendeskEnvVars();
    if (missingZendeskEnv.length > 0) {
      throw new Error(`Missing required Zendesk configuration for digest enrichment: ${missingZendeskEnv.join(", ")}`);
    }

    const authHeader = `Basic ${btoa(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`)}`;
    const requesterCache = new Map<number, Promise<Record<string, unknown> | null>>();

    const enrichedTickets = await mapWithConcurrency(ticketRows, 4, async (ticket) => {
      return await enrichTicketForDigest(ticket, authHeader, requesterCache);
    });

    const generatedDigest = await generateDigestMarkdown(title, enrichedTickets, filters);
    const digestMarkdown = generatedDigest.markdown;

    const digestTable = enrichedTickets.map((ticket) => ({
      ticket_id: ticket.ticket_id,
      requester: buildRequesterDisplay(ticket.requester_name, ticket.requester_email, ticket.requester_phone),
      requester_name: ticket.requester_name,
      requester_email: ticket.requester_email,
      requester_phone: ticket.requester_phone,
      created_at: safeIso(ticket.zendesk_created_at),
      updated_at: safeIso(ticket.zendesk_updated_at),
      subject: ticket.subject,
      status: ticket.status,
      next_action: ticket.summary_text,
      comment_count: ticket.comments.length,
      public_comment_count: ticket.comments.filter((comment) => comment.public === true).length,
      internal_note_count: ticket.comments.filter((comment) => comment.public === false).length,
    }));

    const { data: digest, error: digestInsertError } = await supabaseAdmin
      .from("digests")
      .insert({
        title,
        source: ticketIds.length > 0 ? "selection" : "filters",
        filters,
        ticket_ids: enrichedTickets.map((ticket) => ticket.ticket_id),
        content_markdown: digestMarkdown,
        content_table: digestTable,
      })
      .select("id,title,source,filters,ticket_ids,content_markdown,content_table,created_at")
      .single();

    if (digestInsertError) {
      throw new Error(`Failed to store digest: ${digestInsertError.message}`);
    }

    const digestId = digest.id as string;
    const links = enrichedTickets.map((ticket) => ({
      digest_id: digestId,
      ticket_id: ticket.ticket_id,
    }));

    const { error: linkError } = await supabaseAdmin.from("digest_tickets").insert(links);
    if (linkError) {
      throw new Error(`Failed to map digest tickets: ${linkError.message}`);
    }

    return jsonResponse({
      ok: true,
      digest,
      ticket_count: enrichedTickets.length,
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
    const message = error instanceof Error ? error.message : "Unknown digest error";
    return jsonResponse({ error: message }, 500);
  }
});
