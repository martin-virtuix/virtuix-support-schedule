import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL");

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

async function postToSlack(text: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    throw new Error("Missing required environment variable: SLACK_WEBHOOK_URL");
  }

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${body}`);
  }
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
    const type = typeof body.type === "string" ? body.type : "";

    if (type === "digest") {
      const digestId =
        typeof body.digest_id === "string" ? body.digest_id : typeof body.digest_id === "number" ? String(body.digest_id) : "";
      if (!digestId) {
        return jsonResponse({ error: "digest_id is required for type=digest." }, 400);
      }

      const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });

      const { data: digest, error: digestError } = await supabaseAdmin
        .from("digests")
        .select("title,content_markdown,created_at")
        .eq("id", digestId)
        .maybeSingle();

      if (digestError) {
        throw new Error(`Failed to load digest: ${digestError.message}`);
      }

      if (!digest) {
        return jsonResponse({ error: "Digest not found." }, 404);
      }

      const text = `*${digest.title}*\nCreated: ${digest.created_at}\n\n${digest.content_markdown}`;
      await postToSlack(text);
      return jsonResponse({ ok: true, type: "digest", digest_id: digestId });
    }

    if (type === "ticket_summary") {
      const ticketId =
        typeof body.ticket_id === "number"
          ? body.ticket_id
          : typeof body.ticket_id === "string"
            ? Number.parseInt(body.ticket_id, 10)
            : NaN;

      if (!Number.isFinite(ticketId)) {
        return jsonResponse({ error: "ticket_id is required for type=ticket_summary." }, 400);
      }

      const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });

      const { data: ticket, error: ticketError } = await supabaseAdmin
        .from("ticket_cache")
        .select("ticket_id,brand,status,subject,summary_text,ticket_url")
        .eq("ticket_id", ticketId)
        .maybeSingle();

      if (ticketError) {
        throw new Error(`Failed to load ticket: ${ticketError.message}`);
      }

      if (!ticket) {
        return jsonResponse({ error: "Ticket not found." }, 404);
      }

      const { data: summary, error: summaryError } = await supabaseAdmin
        .from("ticket_summaries")
        .select("summary_text,key_actions,next_steps")
        .eq("ticket_id", ticketId)
        .maybeSingle();

      if (summaryError) {
        throw new Error(`Failed to load ticket summary: ${summaryError.message}`);
      }

      const summaryText = summary?.summary_text || ticket.summary_text || "Summary not available yet.";
      const keyActions = Array.isArray(summary?.key_actions) ? summary!.key_actions : [];
      const nextSteps = Array.isArray(summary?.next_steps) ? summary!.next_steps : [];

      const messageParts = [
        `*Ticket #${ticket.ticket_id}*`,
        `Brand: ${ticket.brand}`,
        `Status: ${ticket.status}`,
        `Subject: ${ticket.subject}`,
        ticket.ticket_url ? `URL: ${ticket.ticket_url}` : null,
        "",
        `Summary: ${summaryText}`,
        keyActions.length > 0 ? `Key Actions:\n- ${(keyActions as string[]).join("\n- ")}` : null,
        nextSteps.length > 0 ? `Next Steps:\n- ${(nextSteps as string[]).join("\n- ")}` : null,
      ].filter(Boolean);

      await postToSlack(messageParts.join("\n"));
      return jsonResponse({ ok: true, type: "ticket_summary", ticket_id: ticketId });
    }

    if (typeof body.text === "string" && body.text.trim().length > 0) {
      await postToSlack(body.text.trim());
      return jsonResponse({ ok: true, type: "plain_text" });
    }

    return jsonResponse({ error: "Unsupported payload. Provide type=digest or type=ticket_summary." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Slack send error";
    return jsonResponse({ error: message }, 500);
  }
});
