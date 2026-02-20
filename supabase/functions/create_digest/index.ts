import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type TicketRow = {
  ticket_id: number;
  brand: string;
  subject: string;
  status: string;
  priority: string | null;
  requester_name: string | null;
  requester_email: string | null;
  zendesk_updated_at: string | null;
  summary_text: string | null;
};

type DigestFilters = {
  brand?: string;
  status?: string;
  limit?: number;
  search?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

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

function safeIso(value: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function buildDigestMarkdown(title: string, tickets: TicketRow[], filters: DigestFilters): string {
  const statusCounts = tickets.reduce<Record<string, number>>((acc, ticket) => {
    acc[ticket.status] = (acc[ticket.status] ?? 0) + 1;
    return acc;
  }, {});

  const brandCounts = tickets.reduce<Record<string, number>>((acc, ticket) => {
    acc[ticket.brand] = (acc[ticket.brand] ?? 0) + 1;
    return acc;
  }, {});

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Tickets: ${tickets.length}`);
  lines.push("");
  lines.push("## Filters");
  lines.push(`- Brand: ${filters.brand ?? "all"}`);
  lines.push(`- Status: ${filters.status ?? "all"}`);
  lines.push(`- Search: ${filters.search ?? "none"}`);
  lines.push("");
  lines.push("## By Status");
  Object.entries(statusCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([status, count]) => lines.push(`- ${status}: ${count}`));
  lines.push("");
  lines.push("## By Brand");
  Object.entries(brandCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([brand, count]) => lines.push(`- ${brand}: ${count}`));
  lines.push("");
  lines.push("## Action Queue");

  tickets.slice(0, 30).forEach((ticket) => {
    const summary = ticket.summary_text?.trim() || ticket.subject;
    lines.push(`- #${ticket.ticket_id} [${ticket.brand}/${ticket.status}] ${summary}`);
  });

  lines.push("");
  lines.push("## Ticket Table");
  lines.push("| Ticket | Brand | Status | Priority | Requester | Updated | Subject |\n|---|---|---|---|---|---|---|");
  tickets.slice(0, 50).forEach((ticket) => {
    const requester = ticket.requester_name || ticket.requester_email || "n/a";
    const priority = ticket.priority || "n/a";
    const updated = safeIso(ticket.zendesk_updated_at);
    const subject = (ticket.subject || "").replace(/\|/g, "\\|");
    lines.push(`| #${ticket.ticket_id} | ${ticket.brand} | ${ticket.status} | ${priority} | ${requester} | ${updated} | ${subject} |`);
  });

  return lines.join("\n");
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
      .select("ticket_id,brand,subject,status,priority,requester_name,requester_email,zendesk_updated_at,summary_text")
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

    const digestMarkdown = buildDigestMarkdown(title, ticketRows, filters);

    const digestTable = ticketRows.map((ticket) => ({
      ticket_id: ticket.ticket_id,
      brand: ticket.brand,
      status: ticket.status,
      priority: ticket.priority,
      requester: ticket.requester_name || ticket.requester_email || "n/a",
      updated_at: ticket.zendesk_updated_at,
      subject: ticket.subject,
      summary: ticket.summary_text,
    }));

    const { data: digest, error: digestInsertError } = await supabaseAdmin
      .from("digests")
      .insert({
        title,
        source: ticketIds.length > 0 ? "selection" : "filters",
        filters,
        ticket_ids: ticketRows.map((ticket) => ticket.ticket_id),
        content_markdown: digestMarkdown,
        content_table: digestTable,
      })
      .select("id,title,source,filters,ticket_ids,content_markdown,content_table,created_at")
      .single();

    if (digestInsertError) {
      throw new Error(`Failed to store digest: ${digestInsertError.message}`);
    }

    const digestId = digest.id as string;
    const links = ticketRows.map((ticket) => ({
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
      ticket_count: ticketRows.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown digest error";
    return jsonResponse({ error: message }, 500);
  }
});
