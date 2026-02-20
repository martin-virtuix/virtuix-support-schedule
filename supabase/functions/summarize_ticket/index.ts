import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type SummaryPayload = {
  summary: string;
  key_actions: string[];
  next_steps: string[];
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";

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

function parseSummary(rawContent: string): SummaryPayload {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    return {
      summary: summary || "No summary generated.",
      key_actions: sanitizeStringArray(parsed.key_actions),
      next_steps: sanitizeStringArray(parsed.next_steps),
    };
  } catch {
    const lines = rawContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return {
      summary: lines[0] ?? "No summary generated.",
      key_actions: lines.slice(1, 4),
      next_steps: lines.slice(4, 7),
    };
  }
}

function compactTicketForPrompt(ticket: Record<string, unknown>): Record<string, unknown> {
  return {
    ticket_id: ticket.ticket_id,
    brand: ticket.brand,
    status: ticket.status,
    priority: ticket.priority,
    subject: ticket.subject,
    requester_email: ticket.requester_email,
    requester_name: ticket.requester_name,
    assignee_email: ticket.assignee_email,
    zendesk_updated_at: ticket.zendesk_updated_at,
    raw_payload: ticket.raw_payload,
  };
}

async function generateSummary(ticket: Record<string, unknown>): Promise<SummaryPayload> {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing required environment variable: OPENAI_API_KEY");
  }

  const prompt = {
    task: "Create an action-oriented support summary for the ticket.",
    output_format: {
      summary: "one concise paragraph",
      key_actions: ["array of 2-5 imperative bullet items"],
      next_steps: ["array of 2-5 practical next steps"],
    },
    constraints: [
      "Reference ticket status and requester intent",
      "Prioritize actions that unblock support execution",
      "Do not include markdown code fences",
      "Return JSON only",
    ],
    ticket: compactTicketForPrompt(ticket),
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You are a senior support lead. Produce concise operational summaries in strict JSON.",
        },
        {
          role: "user",
          content: JSON.stringify(prompt),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${text}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };

  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenAI returned an empty summary response.");
  }

  return parseSummary(content);
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
      .select("ticket_id,brand,status,priority,subject,requester_email,requester_name,assignee_email,zendesk_updated_at,raw_payload")
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
      .select("summary_text,key_actions,next_steps,updated_at")
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
      });
    }

    const generated = await generateSummary(ticket as Record<string, unknown>);
    const nowIso = new Date().toISOString();

    const { error: summaryUpsertError } = await supabaseAdmin
      .from("ticket_summaries")
      .upsert(
        {
          ticket_id: ticketId,
          summary_text: generated.summary,
          key_actions: generated.key_actions,
          next_steps: generated.next_steps,
          model: OPENAI_MODEL,
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
      model: OPENAI_MODEL,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown summary error";
    return jsonResponse({ error: message }, 500);
  }
});
