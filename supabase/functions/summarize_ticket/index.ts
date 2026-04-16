import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeVirtuixRequest, HttpError } from "../_shared/auth.ts";
import { buildModelCandidates, requestChatCompletionWithModelFallback } from "../_shared/openai_chat.ts";

type SummaryPayload = {
  summary: string;
  key_actions: string[];
  next_steps: string[];
};

type GeneratedSummary = SummaryPayload & {
  model: string;
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
const DEFAULT_SUMMARY_SYSTEM_PROMPT = `You are a Technical Support Ticket Embedding Summary Specialist.

Your task:
Read the full ticket conversation (including internal notes and public replies) and produce a SHORT retrieval-oriented summary.

The goal is to help semantic search and embeddings capture the real support signal from the ticket.

----------------------------------------
CRITICAL RULES
----------------------------------------

- Compress information aggressively.
- Include only:
  1. the customer issue,
  2. the troubleshooting already performed,
  3. the current resolution outcome.
- Focus on the technical situation and meaningful support work, not the full history.
- Summarize real troubleshooting and outcome rather than listing every message.
- If the ticket conversation is written fully or partially in a language other than English, translate the relevant content into English in the final summary.
- Do NOT include requester identity details such as name, email, or phone.
- Do NOT include ticket subject, greetings, apologies, scheduling chatter, handoff chatter, shipping/admin noise, or generic support phrasing unless essential to the technical issue.
- Do NOT include recommended next steps, future follow-up plans, or what support "should" do next.
- Do NOT repeat the conversation timeline.
- Keep troubleshooting focused on meaningful steps already taken or confirmed.
- The entire summary should remain compact and easy to read.
- State clearly whether the issue is solved, not solved, pending customer, or unknown.

----------------------------------------
OUTPUT FORMAT (FOLLOW EXACTLY)
----------------------------------------

Issue:
Write 2-3 concise sentences explaining the customer's problem and impact.

Troubleshooting:
- Write 1-5 short bullets describing meaningful troubleshooting, validation, replacement, reset, configuration, or analysis steps already performed.
- Do not include speculative future actions.

Resolution Status:
Write exactly one of: Solved, Not solved, Pending customer, Unknown

Resolution Details:
Write 1 concise sentence describing the current outcome only.

----------------------------------------
STYLE GUIDELINES
----------------------------------------

- Be concise and direct.
- Write the final summary in English only.
- Prioritize clarity over detail.
- Avoid repeating minor troubleshooting steps.
- Focus on the technical signal that would help retrieve similar tickets later.

The summary should be readable in **under 10 seconds**.`;
const SUMMARY_SYSTEM_PROMPT = (Deno.env.get("SUMMARY_SYSTEM_PROMPT") || DEFAULT_SUMMARY_SYSTEM_PROMPT).trim();

type ParsedSummarySections = {
  fallbackSummary: string | null;
  issue: string | null;
  troubleshooting: string[];
  resolutionStatus: string | null;
  resolutionDetails: string | null;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 6);
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

async function fetchZendeskWithRetry(url: string, authHeader: string): Promise<Response> {
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

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      const bodyText = await response.text();
      throw new Error(`Zendesk API error (${response.status}): ${bodyText}`);
    }

    const retryAfterMs = getRetryAfterMs(response.headers.get("retry-after"));
    const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs ?? backoffMs));
  }

  throw new Error("Zendesk retry loop exited unexpectedly");
}

function normalizeCommentBody(comment: Record<string, unknown>): string {
  const plainBody = typeof comment.plain_body === "string" ? comment.plain_body.trim() : "";
  if (plainBody) return plainBody;

  const body = typeof comment.body === "string" ? comment.body.trim() : "";
  if (body) return body;

  return "Not provided";
}

async function fetchTicketComments(ticketId: number): Promise<Array<Record<string, unknown>>> {
  const missing = getMissingZendeskEnvVars();
  if (missing.length > 0) {
    throw new Error(`Missing required Zendesk configuration for comments: ${missing.join(", ")}`);
  }

  const authHeader = `Basic ${btoa(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`)}`;
  let nextPage = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/comments.json?sort_order=asc`;
  let page = 0;
  const maxPages = 30;
  const allComments: Array<Record<string, unknown>> = [];

  while (nextPage && page < maxPages) {
    const response = await fetchZendeskWithRetry(nextPage, authHeader);
    const payload = await response.json().catch(() => ({} as Record<string, unknown>));

    const comments: unknown[] = Array.isArray(payload.comments) ? payload.comments : [];
    comments.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const comment = item as Record<string, unknown>;
      allComments.push({
        id: comment.id,
        created_at: comment.created_at,
        public: comment.public,
        author_id: comment.author_id,
        body: normalizeCommentBody(comment),
      });
    });

    nextPage = typeof payload.next_page === "string" ? payload.next_page : "";
    page += 1;
  }

  return allComments;
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

function stripListPrefix(value: string): string {
  return value.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
}

function normalizeInlineText(value: string): string {
  return stripListPrefix(value).replace(/\s+/g, " ").trim();
}

function appendUniqueLine(target: string[], value: string): void {
  const normalized = normalizeInlineText(value);
  if (!normalized) return;
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function joinLines(lines: string[]): string | null {
  const value = lines.map(normalizeInlineText).filter((entry) => entry.length > 0).join(" ").trim();
  return value.length > 0 ? value : null;
}

function normalizeResolutionStatus(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (
    normalized === "not solved" ||
    normalized === "not resolved" ||
    normalized === "unsolved" ||
    normalized === "unresolved" ||
    normalized.includes("not solved") ||
    normalized.includes("not resolved") ||
    normalized.includes("unresolved")
  ) {
    return "Not solved";
  }
  if (
    normalized === "pending customer" ||
    normalized.includes("waiting on customer") ||
    normalized.includes("pending customer")
  ) {
    return "Pending customer";
  }
  if (normalized === "unknown" || normalized.includes("unknown")) {
    return "Unknown";
  }
  if (normalized === "solved" || normalized === "closed" || normalized.includes("resolved")) {
    return "Solved";
  }

  return value.trim();
}

function mapTicketStatusToResolutionStatus(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["solved", "closed"].includes(normalized)) return "Solved";
  if (["pending", "hold", "on-hold"].includes(normalized)) return "Pending customer";
  if (["new", "open"].includes(normalized)) return "Not solved";
  return "Unknown";
}

function parseSummaryAsJson(rawContent: string): ParsedSummarySections | null {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string"
      ? parsed.summary.trim()
      : typeof parsed.summary_text === "string"
        ? parsed.summary_text.trim()
        : "";

    const issue = typeof parsed.issue === "string"
      ? parsed.issue.trim()
      : typeof parsed.issue_summary === "string"
        ? parsed.issue_summary.trim()
        : typeof parsed.issueSummary === "string"
          ? parsed.issueSummary.trim()
          : "";

    const troubleshooting = sanitizeStringArray(
      parsed.troubleshooting_steps ?? parsed.troubleshooting ?? parsed.key_actions,
    );
    const resolutionStatus = normalizeResolutionStatus(
      typeof parsed.resolution_status === "string"
        ? parsed.resolution_status
        : typeof parsed.resolutionStatus === "string"
          ? parsed.resolutionStatus
          : typeof parsed.outcome === "string"
            ? parsed.outcome
            : typeof parsed.status === "string"
              ? parsed.status
              : null,
    );
    const resolutionDetails = typeof parsed.resolution_details === "string"
      ? parsed.resolution_details.trim()
      : typeof parsed.resolutionDetails === "string"
        ? parsed.resolutionDetails.trim()
        : "";

    if (!summary && !issue && troubleshooting.length === 0 && !resolutionStatus && !resolutionDetails) {
      return null;
    }

    return {
      fallbackSummary: summary || null,
      issue: issue || null,
      troubleshooting,
      resolutionStatus,
      resolutionDetails: resolutionDetails || null,
    };
  } catch {
    return null;
  }
}

function normalizeSectionName(value: string): "issue" | "troubleshooting" | "resolution_status" | "resolution_details" | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "issue" || normalized === "issue summary") {
    return "issue";
  }
  if (
    normalized === "troubleshooting" ||
    normalized === "support actions" ||
    normalized === "actions taken / recommendations provided" ||
    normalized === "actions taken/recommendations provided"
  ) {
    return "troubleshooting";
  }
  if (normalized === "resolution status") {
    return "resolution_status";
  }
  if (
    normalized === "resolution details" ||
    normalized === "resolution" ||
    normalized === "outcome" ||
    normalized === "current outcome"
  ) {
    return "resolution_details";
  }
  return null;
}

function parseStructuredSummary(rawContent: string): ParsedSummarySections {
  const issueLines: string[] = [];
  const troubleshootingLines: string[] = [];
  const resolutionStatusLines: string[] = [];
  const resolutionDetailLines: string[] = [];
  let section: ReturnType<typeof normalizeSectionName> = null;

  rawContent.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const headerMatch = trimmed.match(/^([A-Za-z][A-Za-z /_-]+):\s*(.*)$/);
    if (headerMatch) {
      section = normalizeSectionName(headerMatch[1]);
      const inline = headerMatch[2]?.trim();
      if (!section || !inline) {
        return;
      }

      if (section === "issue") {
        appendUniqueLine(issueLines, inline);
      } else if (section === "troubleshooting") {
        appendUniqueLine(troubleshootingLines, inline);
      } else if (section === "resolution_status") {
        appendUniqueLine(resolutionStatusLines, inline);
      } else if (section === "resolution_details") {
        appendUniqueLine(resolutionDetailLines, inline);
      }
      return;
    }

    if (section === "issue") {
      appendUniqueLine(issueLines, trimmed);
    } else if (section === "troubleshooting") {
      appendUniqueLine(troubleshootingLines, trimmed);
    } else if (section === "resolution_status") {
      appendUniqueLine(resolutionStatusLines, trimmed);
    } else if (section === "resolution_details") {
      appendUniqueLine(resolutionDetailLines, trimmed);
    }
  });

  return {
    fallbackSummary: rawContent || null,
    issue: joinLines(issueLines),
    troubleshooting: troubleshootingLines.slice(0, 6),
    resolutionStatus: normalizeResolutionStatus(joinLines(resolutionStatusLines)),
    resolutionDetails: joinLines(resolutionDetailLines),
  };
}

function buildCanonicalSummary(
  sections: ParsedSummarySections,
  fallbackTicketStatus: unknown,
): SummaryPayload {
  const troubleshooting = sections.troubleshooting
    .map(normalizeInlineText)
    .filter((entry, index, array) => entry.length > 0 && array.indexOf(entry) === index)
    .slice(0, 6);
  const resolutionStatus = sections.resolutionStatus ?? mapTicketStatusToResolutionStatus(fallbackTicketStatus);
  const resolutionDetails = sections.resolutionDetails ? normalizeInlineText(sections.resolutionDetails) : null;

  const parts: string[] = [];
  if (sections.issue) {
    parts.push(`Issue:\n${sections.issue}`);
  }
  if (troubleshooting.length > 0) {
    parts.push(`Troubleshooting:\n${troubleshooting.map((step) => `- ${step}`).join("\n")}`);
  }
  if (resolutionStatus || resolutionDetails) {
    const resolutionLine =
      resolutionStatus && resolutionDetails
        ? resolutionDetails.toLowerCase().startsWith(resolutionStatus.toLowerCase())
          ? resolutionDetails
          : `${resolutionStatus}. ${resolutionDetails}`
        : resolutionStatus ?? resolutionDetails ?? "";
    parts.push(`Resolution:\n${resolutionLine}`);
  }

  return {
    summary: parts.join("\n\n").trim() || sections.fallbackSummary || "No summary generated.",
    key_actions: troubleshooting,
    next_steps: [],
  };
}

function parseSummary(rawContent: string, fallbackTicketStatus: unknown): SummaryPayload {
  const cleaned = cleanModelContent(rawContent);
  const parsedJson = parseSummaryAsJson(cleaned);
  const parsedSections = parsedJson ?? parseStructuredSummary(cleaned);
  return buildCanonicalSummary(parsedSections, fallbackTicketStatus);
}

function compactTicketForPrompt(ticket: Record<string, unknown>): Record<string, unknown> {
  const rawPayload = (ticket.raw_payload && typeof ticket.raw_payload === "object")
    ? ticket.raw_payload as Record<string, unknown>
    : {};

  return {
    ticket_id: ticket.ticket_id,
    brand: ticket.brand,
    status: ticket.status,
    priority: ticket.priority,
    subject: ticket.subject,
    requester_email: ticket.requester_email,
    requester_name: ticket.requester_name,
    requester_phone: rawPayload.requester && typeof rawPayload.requester === "object"
      ? (rawPayload.requester as Record<string, unknown>).phone ?? null
      : null,
    assignee_email: ticket.assignee_email,
    zendesk_created_at: ticket.zendesk_created_at,
    zendesk_updated_at: ticket.zendesk_updated_at,
    ticket_url: ticket.ticket_url,
    raw_payload: ticket.raw_payload,
  };
}

async function generateSummary(ticket: Record<string, unknown>, comments: Array<Record<string, unknown>>): Promise<GeneratedSummary> {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing required environment variable: OPENAI_API_KEY");
  }

  const prompt = {
    task: "Analyze the provided support ticket and return the summary exactly in the format requested by the system prompt.",
    output_constraints: [
      "Return plain text only.",
      "Do not wrap the output in markdown code fences.",
      "Use \"Not provided\" for any missing fields.",
      "Consider all comments, including internal notes (public=false) and public replies (public=true).",
    ],
    ticket: compactTicketForPrompt(ticket),
    comments,
  };

  const modelCandidates = buildModelCandidates(OPENAI_MODEL, OPENAI_MODEL_FALLBACKS);
  const completion = await requestChatCompletionWithModelFallback({
    apiKey: OPENAI_API_KEY,
    modelCandidates,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: SUMMARY_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: JSON.stringify(prompt),
      },
    ],
  });

  const parsed = parseSummary(completion.content, ticket.status);
  return {
    ...parsed,
    model: completion.model,
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
    await authorizeVirtuixRequest(req, { functionName: "summarize_ticket" });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const ticketId =
      typeof body.ticket_id === "number"
        ? body.ticket_id
        : typeof body.ticket_id === "string"
          ? Number.parseInt(body.ticket_id, 10)
          : NaN;
    const refresh = body.refresh === true;

    if (!Number.isFinite(ticketId)) {
      return jsonResponse({ error: "ticket_id is required." }, 400);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { data: ticket, error: ticketError } = await supabaseAdmin
      .from("ticket_cache")
      .select("ticket_id,brand,status,priority,subject,requester_email,requester_name,assignee_email,zendesk_created_at,zendesk_updated_at,ticket_url,raw_payload")
      .eq("ticket_id", ticketId)
      .maybeSingle();

    if (ticketError) {
      throw new Error(`Failed to fetch ticket: ${ticketError.message}`);
    }

    if (!ticket) {
      return jsonResponse({ error: "Ticket not found in ticket_cache." }, 404);
    }

    const { data: cachedSummary, error: summaryReadError } = await supabaseAdmin
      .from("ticket_summaries")
      .select("summary_text,key_actions,next_steps,updated_at,model")
      .eq("ticket_id", ticketId)
      .maybeSingle();

    if (summaryReadError) {
      throw new Error(`Failed to fetch ticket summary: ${summaryReadError.message}`);
    }

    if (!refresh && cachedSummary?.summary_text) {
      return jsonResponse({
        ok: true,
        cached: true,
        ticket_id: ticketId,
        summary_text: cachedSummary.summary_text,
        key_actions: cachedSummary.key_actions ?? [],
        next_steps: cachedSummary.next_steps ?? [],
        updated_at: cachedSummary.updated_at,
        model: cachedSummary.model ?? null,
      });
    }

    const comments = await fetchTicketComments(ticketId);
    const generated = await generateSummary(ticket as Record<string, unknown>, comments);
    const nowIso = new Date().toISOString();

    const { error: summaryUpsertError } = await supabaseAdmin
      .from("ticket_summaries")
      .upsert(
        {
          ticket_id: ticketId,
          summary_text: generated.summary,
          key_actions: generated.key_actions,
          next_steps: generated.next_steps,
          model: generated.model,
          updated_at: nowIso,
        },
        { onConflict: "ticket_id" },
      );

    if (summaryUpsertError) {
      throw new Error(`Failed to store ticket summary: ${summaryUpsertError.message}`);
    }

    const { error: cacheUpdateError } = await supabaseAdmin
      .from("ticket_cache")
      .update({
        summary_text: generated.summary,
        summary_updated_at: nowIso,
      })
      .eq("ticket_id", ticketId);

    if (cacheUpdateError) {
      throw new Error(`Failed to update ticket cache summary pointer: ${cacheUpdateError.message}`);
    }

    return jsonResponse({
      ok: true,
      cached: false,
      ticket_id: ticketId,
      summary_text: generated.summary,
      key_actions: generated.key_actions,
      next_steps: generated.next_steps,
      updated_at: nowIso,
      model: generated.model,
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
    const message = error instanceof Error ? error.message : "Unknown summary error";
    return jsonResponse({ error: message }, 500);
  }
});
