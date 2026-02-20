import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type BrandFilter = "all" | "omni_one" | "omni_arena";

type SyncOptions = {
  brand: BrandFilter;
  startTime?: number;
};

type ZendeskTicket = {
  id: number;
  subject?: string | null;
  status?: string | null;
  priority?: string | null;
  requester?: {
    email?: string | null;
    name?: string | null;
  } | null;
  assignee?: {
    email?: string | null;
  } | null;
  brand_id?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  url?: string | null;
  [key: string]: unknown;
};

type ZendeskIncrementalResponse = {
  tickets?: ZendeskTicket[];
  end_time?: number;
  end_of_stream?: boolean;
  next_page?: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const ZENDESK_SUBDOMAIN = Deno.env.get("ZENDESK_SUBDOMAIN");
const ZENDESK_EMAIL = Deno.env.get("ZENDESK_EMAIL");
const ZENDESK_API_TOKEN = Deno.env.get("ZENDESK_API_TOKEN");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const OMNI_ONE_BRAND_ID = parseOptionalInteger(Deno.env.get("ZENDESK_OMNI_ONE_BRAND_ID"));
const OMNI_ARENA_BRAND_ID = parseOptionalInteger(Deno.env.get("ZENDESK_OMNI_ARENA_BRAND_ID"));

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function mapBrand(brandId: number | null | undefined): BrandFilter | "unknown" {
  if (typeof brandId !== "number") return "unknown";
  if (typeof OMNI_ONE_BRAND_ID === "number" && brandId === OMNI_ONE_BRAND_ID) return "omni_one";
  if (typeof OMNI_ARENA_BRAND_ID === "number" && brandId === OMNI_ARENA_BRAND_ID) return "omni_arena";
  return "unknown";
}

function getMissingEnvVars(): string[] {
  const missing: string[] = [];
  if (!ZENDESK_SUBDOMAIN) missing.push("ZENDESK_SUBDOMAIN");
  if (!ZENDESK_EMAIL) missing.push("ZENDESK_EMAIL");
  if (!ZENDESK_API_TOKEN) missing.push("ZENDESK_API_TOKEN");
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
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

function buildTicketUrl(apiUrl: string | null | undefined, ticketNumber: number): string | null {
  if (!apiUrl) return null;
  try {
    const parsed = new URL(apiUrl);
    return `${parsed.protocol}//${parsed.host}/agent/tickets/${ticketNumber}`;
  } catch {
    return null;
  }
}

async function fetchZendeskWithRetry(url: string, authHeader: string): Promise<Response> {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
    await sleep(retryAfterMs ?? backoffMs);
  }

  throw new Error("Zendesk retry loop exited unexpectedly");
}

async function getSyncOptions(req: Request): Promise<SyncOptions> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const brand = (url.searchParams.get("brand") ?? "all") as BrandFilter;
    const startTimeRaw = url.searchParams.get("start_time");
    const startTime = startTimeRaw ? Number.parseInt(startTimeRaw, 10) : undefined;
    return {
      brand: brand === "omni_one" || brand === "omni_arena" ? brand : "all",
      startTime: Number.isFinite(startTime) ? startTime : undefined,
    };
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const requestedBrand = typeof body.brand === "string" ? body.brand : "all";
  const requestedStartTime =
    typeof body.start_time === "number"
      ? body.start_time
      : typeof body.start_time === "string"
        ? Number.parseInt(body.start_time, 10)
        : undefined;

  return {
    brand: requestedBrand === "omni_one" || requestedBrand === "omni_arena" ? requestedBrand : "all",
    startTime: Number.isFinite(requestedStartTime) ? requestedStartTime : undefined,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (![
    "GET",
    "POST",
  ].includes(req.method)) {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const missingEnv = getMissingEnvVars();
  if (missingEnv.length > 0) {
    return jsonResponse({ error: `Missing required environment variables: ${missingEnv.join(", ")}` }, 500);
  }

  const supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const options = await getSyncOptions(req);

  let runId: string | null = null;
  let fetchedCount = 0;
  let upsertedCount = 0;
  const staleRunThresholdMs = 20 * 60 * 1000;

  try {
    let cursor = options.startTime;

    if (!cursor) {
      const { data: lastRun, error: cursorError } = await supabaseAdmin
        .from("zendesk_sync_runs")
        .select("cursor")
        .eq("status", "success")
        .not("cursor", "is", null)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cursorError) {
        throw new Error(`Failed to fetch previous Zendesk cursor: ${cursorError.message}`);
      }

      cursor = lastRun?.cursor ?? Math.floor(Date.now() / 1000) - 60 * 60;
    }

    const { data: runningRun, error: runningRunError } = await supabaseAdmin
      .from("zendesk_sync_runs")
      .select("id,started_at")
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runningRunError) {
      throw new Error(`Failed to check existing running sync: ${runningRunError.message}`);
    }

    if (runningRun?.id) {
      const startedAt = new Date(runningRun.started_at);
      const ageMs = Number.isNaN(startedAt.getTime()) ? 0 : Date.now() - startedAt.getTime();

      if (ageMs > staleRunThresholdMs) {
        const { error: staleUpdateError } = await supabaseAdmin
          .from("zendesk_sync_runs")
          .update({
            status: "error",
            finished_at: new Date().toISOString(),
            error_message: "Recovered stale running lock before starting new sync_zendesk run.",
          })
          .eq("id", runningRun.id);

        if (staleUpdateError) {
          throw new Error(`Failed to recover stale running sync: ${staleUpdateError.message}`);
        }
      } else {
        return jsonResponse({
          ok: true,
          skipped: true,
          reason: "A sync_zendesk run is already in progress.",
        });
      }
    }

    const { data: runData, error: runInsertError } = await supabaseAdmin
      .from("zendesk_sync_runs")
      .insert({
        status: "running",
        started_at: new Date().toISOString(),
        cursor,
      })
      .select("id")
      .single();

    if (runInsertError) {
      if (runInsertError.code === "23505") {
        return jsonResponse({
          ok: true,
          skipped: true,
          reason: "A sync_zendesk run is already in progress.",
        });
      }
      throw new Error(`Failed to create sync run record: ${runInsertError.message}`);
    }

    if (!runData?.id) {
      throw new Error("Failed to create sync run record: no run id returned");
    }

    runId = runData.id as string;

    const authHeader = `Basic ${btoa(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`)}`;
    let nextPageUrl = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/incremental/tickets.json?start_time=${cursor}`;
    let lastCursor = cursor;

    const maxPages = 20;
    let page = 0;

    while (nextPageUrl && page < maxPages) {
      const zendeskResponse = await fetchZendeskWithRetry(nextPageUrl, authHeader);

      const payload = (await zendeskResponse.json()) as ZendeskIncrementalResponse;
      const tickets = payload.tickets ?? [];

      const filteredTickets = tickets.filter((ticket) => {
        const mappedBrand = mapBrand(ticket.brand_id);
        if (options.brand === "all") return true;
        return mappedBrand === options.brand;
      });

      fetchedCount += filteredTickets.length;

      if (filteredTickets.length > 0) {
        const upsertRows = filteredTickets.map((ticket) => ({
          ticket_id: ticket.id,
          brand: mapBrand(ticket.brand_id),
          subject: ticket.subject ?? "",
          status: ticket.status ?? "new",
          priority: ticket.priority,
          requester_email: ticket.requester?.email,
          requester_name: ticket.requester?.name,
          assignee_email: ticket.assignee?.email,
          zendesk_created_at: ticket.created_at,
          zendesk_updated_at: ticket.updated_at,
          ticket_url: buildTicketUrl(ticket.url, ticket.id),
          raw_payload: ticket,
          synced_at: new Date().toISOString(),
        }));

        const { error: upsertError } = await supabaseAdmin
          .from("ticket_cache")
          .upsert(upsertRows, { onConflict: "ticket_id" });

        if (upsertError) {
          throw new Error(`Supabase upsert error: ${upsertError.message}`);
        }

        upsertedCount += upsertRows.length;
      }

      lastCursor = payload.end_time ?? lastCursor;
      nextPageUrl = payload.end_of_stream ? null : payload.next_page ?? null;
      page += 1;
    }

    const { error: runUpdateError } = await supabaseAdmin
      .from("zendesk_sync_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        tickets_fetched: fetchedCount,
        tickets_upserted: upsertedCount,
        cursor: lastCursor,
      })
      .eq("id", runId);

    if (runUpdateError) {
      throw new Error(`Failed to update sync run record: ${runUpdateError.message}`);
    }

    return jsonResponse({
      ok: true,
      run_id: runId,
      brand: options.brand,
      tickets_fetched: fetchedCount,
      tickets_upserted: upsertedCount,
      cursor: lastCursor,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Zendesk sync error";

    if (runId) {
      await supabaseAdmin
        .from("zendesk_sync_runs")
        .update({
          status: "error",
          finished_at: new Date().toISOString(),
          tickets_fetched: fetchedCount,
          tickets_upserted: upsertedCount,
          error_message: message,
        })
        .eq("id", runId);
    }

    return jsonResponse({ error: message }, 500);
  }
});
