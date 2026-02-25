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
const DEFAULT_SUMMARY_SYSTEM_PROMPT = `You are a Technical Support Ticket Summary Specialist.

Your task:
Analyze a single support ticket, including ALL internal comments and public replies, and generate a structured summary.

IMPORTANT RULES:
- Use ONLY the content provided in the ticket.
- Do NOT invent missing information.
- If any required field is missing (email, phone, etc.), explicitly state: "Not provided".
- Be concise, structured, and factual.
- Do NOT add opinions.
- Do NOT repeat the full conversation.
- Extract key points only.

You must clearly distinguish between:
- What the customer reported
- What the support team replied or recommended

----------------------------------------
OUTPUT FORMAT (STRICT -- FOLLOW EXACTLY)
----------------------------------------

Ticket Subject:
<Insert subject>

Requester:
<Name> | <Email> | <Phone if available, otherwise "Not provided">

Issues Reported:
- Bullet points summarizing customer complaints, symptoms, or requests
- Include timeline context if relevant
- Keep it concise

Actions Taken / Recommendations Provided:
- Bullet points summarizing what support has replied
- Include troubleshooting steps suggested
- Include clarifications given
- Include any escalations

Recommended Next Step:
- Clear and actionable next step
- If waiting on customer -> state it
- If escalation needed -> state it
- If resolved -> state resolution confirmation step

----------------------------------------

Tone:
Professional, neutral, structured.
Internal-use summary (not customer-facing).
Avoid fluff.
Accuracy over speed.`;
const SUMMARY_SYSTEM_PROMPT = (Deno.env.get("SUMMARY_SYSTEM_PROMPT") || DEFAULT_SUMMARY_SYSTEM_PROMPT).trim();

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

    const comments = Array.isArray(payload.comments) ? payload.comments : [];
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

function parseSummaryAsJson(rawContent: string): SummaryPayload | null {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string"
      ? parsed.summary.trim()
      : typeof parsed.summary_text === "string"
        ? parsed.summary_text.trim()
        : "";

    if (!summary && !Array.isArray(parsed.key_actions) && !Array.isArray(parsed.next_steps)) {
      return null;
    }

    return {
      summary: summary || "No summary generated.",
      key_actions: sanitizeStringArray(parsed.key_actions),
      next_steps: sanitizeStringArray(parsed.next_steps),
    };
  } catch {
    return null;
  }
}

function parseStructuredSummary(rawContent: string): SummaryPayload {
  const keyActions: string[] = [];
  const nextSteps: string[] = [];
  let section: "actions" | "next_steps" | null = null;

  rawContent.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (/^actions taken\s*\/\s*recommendations provided\s*:/i.test(trimmed)) {
      section = "actions";
      const inline = stripListPrefix(trimmed.replace(/^actions taken\s*\/\s*recommendations provided\s*:/i, "").trim());
      if (inline) {
        keyActions.push(inline);
      }
      return;
    }

    if (/^recommended next step\s*:/i.test(trimmed)) {
      section = "next_steps";
      const inline = stripListPrefix(trimmed.replace(/^recommended next step\s*:/i, "").trim());
      if (inline) {
        nextSteps.push(inline);
      }
      return;
    }

    if (/^[a-z].*:\s*$/i.test(trimmed)) {
      section = null;
      return;
    }

    if (section === "actions") {
      const value = stripListPrefix(trimmed);
      if (value) {
        keyActions.push(value);
      }
      return;
    }

    if (section === "next_steps") {
      const value = stripListPrefix(trimmed);
      if (value) {
        nextSteps.push(value);
      }
    }
  });

  if (keyActions.length === 0 && nextSteps.length === 0) {
    const lines = rawContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return {
      summary: rawContent || "No summary generated.",
      key_actions: lines.slice(0, 3),
      next_steps: lines.slice(3, 6),
    };
  }

  return {
    summary: rawContent || "No summary generated.",
    key_actions: keyActions.slice(0, 6),
    next_steps: nextSteps.slice(0, 6),
  };
}

function parseSummary(rawContent: string): SummaryPayload {
  const cleaned = cleanModelContent(rawContent);
  const parsedJson = parseSummaryAsJson(cleaned);
  if (parsedJson) {
    return parsedJson;
  }
  return parseStructuredSummary(cleaned);
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

  const parsed = parseSummary(completion.content);
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
