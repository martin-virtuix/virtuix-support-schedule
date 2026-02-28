import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeVirtuixRequest, HttpError } from "../_shared/auth.ts";

type BrandFilter = "all" | "omni_one" | "omni_arena";

type SyncOptions = {
  brand: BrandFilter;
  startTime?: number;
  backfillYear: boolean;
  backfillDays?: number;
  maxPages?: number;
  reconcileActive: boolean;
};

type ZendeskTicket = {
  id: number;
  subject?: string | null;
  status?: string | null;
  priority?: string | null;
  requester_id?: number | null;
  requester?: {
    email?: string | null;
    name?: string | null;
    phone?: string | null;
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

type ZendeskUser = {
  id?: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

type ZendeskIncrementalResponse = {
  tickets?: ZendeskTicket[];
  end_time?: number;
  end_of_stream?: boolean;
  next_page?: string | null;
};

type ZendeskShowManyResponse = {
  tickets?: ZendeskTicket[];
};

type TicketCacheActiveRow = {
  ticket_id: number;
  requester_email?: string | null;
  requester_name?: string | null;
  assignee_email?: string | null;
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

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  return null;
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  const parsed = parseInteger(value);
  if (parsed === null || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
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

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
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

async function fetchZendeskWithRetry(
  url: string,
  authHeader: string,
  options: { allowNotFound?: boolean } = {},
): Promise<Response> {
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

async function fetchZendeskUser(userId: number, authHeader: string): Promise<ZendeskUser | null> {
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

  return payload.user as ZendeskUser;
}

async function fetchZendeskTicketsByIds(ticketIds: number[], authHeader: string): Promise<ZendeskTicket[]> {
  const uniqueIds = Array.from(new Set(ticketIds.filter((id) => Number.isFinite(id) && id > 0)));
  if (uniqueIds.length === 0) {
    return [];
  }

  const idChunks = chunkArray(uniqueIds, 100);
  const fetchedTickets = await mapWithConcurrency(idChunks, 3, async (ids) => {
    const response = await fetchZendeskWithRetry(
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/show_many.json?ids=${ids.join(",")}`,
      authHeader,
    );

    const payload = await response.json().catch(() => ({} as ZendeskShowManyResponse));
    return Array.isArray(payload.tickets) ? payload.tickets : [];
  });

  return fetchedTickets
    .flat()
    .filter((ticket): ticket is ZendeskTicket => typeof ticket?.id === "number");
}

async function getSyncOptions(req: Request): Promise<SyncOptions> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const brand = (url.searchParams.get("brand") ?? "all") as BrandFilter;
    const startTime = parseOptionalPositiveInteger(url.searchParams.get("start_time"));
    const backfillYear = parseBoolean(url.searchParams.get("backfill_year")) === true;
    const backfillDays = parseOptionalPositiveInteger(url.searchParams.get("backfill_days"));
    const maxPages = parseOptionalPositiveInteger(url.searchParams.get("max_pages"));
    const reconcileActive = parseBoolean(url.searchParams.get("reconcile_active")) !== false;
    return {
      brand: brand === "omni_one" || brand === "omni_arena" ? brand : "all",
      startTime,
      backfillYear,
      backfillDays,
      maxPages,
      reconcileActive,
    };
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const requestedBrand = typeof body.brand === "string" ? body.brand : "all";
  const requestedStartTime = parseOptionalPositiveInteger(body.start_time);
  const backfillYear = parseBoolean(body.backfill_year) === true;
  const backfillDays = parseOptionalPositiveInteger(body.backfill_days);
  const maxPages = parseOptionalPositiveInteger(body.max_pages);
  const reconcileActive = parseBoolean(body.reconcile_active) !== false;

  return {
    brand: requestedBrand === "omni_one" || requestedBrand === "omni_arena" ? requestedBrand : "all",
    startTime: requestedStartTime,
    backfillYear,
    backfillDays,
    maxPages,
    reconcileActive,
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

  try {
    await authorizeVirtuixRequest(req, { allowServiceRole: true, functionName: "sync_zendesk" });
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
    const message = error instanceof Error ? error.message : "Auth validation failed.";
    return jsonResponse({ error: message }, 500);
  }

  const supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const options = await getSyncOptions(req);

  let runId: string | null = null;
  let fetchedCount = 0;
  let upsertedCount = 0;
  let reconciledCheckedCount = 0;
  let reconciledUpsertedCount = 0;
  const staleRunThresholdMs = (options.backfillYear ? 120 : 20) * 60 * 1000;
  let lastCursorForError: number | null = null;
  let initialCursor: number | null = null;
  let targetBackfillCursor: number | null = null;

  try {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const defaultCursor = nowEpochSeconds - 60 * 60;
    const minimumBackfillDays = 365;

    let cursor = options.startTime;

    const { data: lastRun, error: cursorError } = await supabaseAdmin
      .from("zendesk_sync_runs")
      .select("cursor")
      .in("status", ["success", "error"])
      .not("cursor", "is", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cursorError) {
      throw new Error(`Failed to fetch previous Zendesk cursor: ${cursorError.message}`);
    }

    const latestKnownCursor = typeof lastRun?.cursor === "number" ? lastRun.cursor : null;

    if (!cursor && options.backfillYear) {
      const backfillDays = Math.max(options.backfillDays ?? minimumBackfillDays, minimumBackfillDays);
      targetBackfillCursor = nowEpochSeconds - backfillDays * 24 * 60 * 60;
      const nearRealtimeThreshold = nowEpochSeconds - 5 * 60;

      // Resume from latest cursor when a prior backfill run likely stopped mid-way.
      if (
        latestKnownCursor !== null &&
        latestKnownCursor >= targetBackfillCursor &&
        latestKnownCursor < nearRealtimeThreshold
      ) {
        cursor = latestKnownCursor;
      } else {
        cursor = targetBackfillCursor;
      }
    }

    if (!cursor) {
      cursor = latestKnownCursor ?? defaultCursor;
    }
    initialCursor = cursor;

    lastCursorForError = cursor;

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
    const enrichRequesterDetails = !options.backfillYear;
    const requesterCache = new Map<number, Promise<ZendeskUser | null>>();
    let nextPageUrl: string | null =
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/incremental/tickets.json?start_time=${cursor}`;
    let lastCursor = cursor;

    const maxPages = Math.max(1, Math.min(options.maxPages ?? (options.backfillYear ? 120 : 20), 500));
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
        const upsertRows = await mapWithConcurrency(filteredTickets, 8, async (ticket) => {
          const embeddedRequesterName = normalizeString(ticket.requester?.name);
          const embeddedRequesterEmail = normalizeString(ticket.requester?.email);
          const requesterId = parseInteger(ticket.requester_id);

          let requesterUser: ZendeskUser | null = null;
          if (enrichRequesterDetails && requesterId !== null && (!embeddedRequesterName || !embeddedRequesterEmail)) {
            let userPromise = requesterCache.get(requesterId);
            if (!userPromise) {
              userPromise = fetchZendeskUser(requesterId, authHeader);
              requesterCache.set(requesterId, userPromise);
            }
            requesterUser = await userPromise;
          }

          const requesterName = firstNonEmpty([
            embeddedRequesterName,
            normalizeString(requesterUser?.name),
          ]);
          const requesterEmail = firstNonEmpty([
            embeddedRequesterEmail,
            normalizeString(requesterUser?.email),
          ]);

          return {
            ticket_id: ticket.id,
            brand: mapBrand(ticket.brand_id),
            subject: ticket.subject ?? "",
            status: ticket.status ?? "new",
            priority: ticket.priority,
            requester_email: requesterEmail,
            requester_name: requesterName,
            assignee_email: ticket.assignee?.email,
            zendesk_created_at: ticket.created_at ?? ticket.updated_at,
            zendesk_updated_at: ticket.updated_at,
            ticket_url: buildTicketUrl(ticket.url, ticket.id),
            raw_payload: ticket,
            synced_at: new Date().toISOString(),
          };
        });

        const { error: upsertError } = await supabaseAdmin
          .from("ticket_cache")
          .upsert(upsertRows, { onConflict: "ticket_id" });

        if (upsertError) {
          throw new Error(`Supabase upsert error: ${upsertError.message}`);
        }

        upsertedCount += upsertRows.length;
      }

      lastCursor = payload.end_time ?? lastCursor;
      lastCursorForError = lastCursor;
      nextPageUrl = payload.end_of_stream ? null : payload.next_page ?? null;
      page += 1;

      // Persist progress periodically so long backfills can safely resume.
      if (runId && page % 5 === 0) {
        const { error: progressError } = await supabaseAdmin
          .from("zendesk_sync_runs")
          .update({
            cursor: lastCursor,
            tickets_fetched: fetchedCount,
            tickets_upserted: upsertedCount,
          })
          .eq("id", runId);

        if (progressError) {
          console.warn("Unable to checkpoint sync progress", progressError.message);
        }
      }
    }

    if (options.reconcileActive) {
      let activeTicketQuery = supabaseAdmin
        .from("ticket_cache")
        .select("ticket_id,requester_email,requester_name,assignee_email")
        .in("status", ["new", "open", "pending"])
        .limit(5000);

      if (options.brand !== "all") {
        activeTicketQuery = activeTicketQuery.eq("brand", options.brand);
      }

      const { data: activeRows, error: activeRowsError } = await activeTicketQuery;
      if (activeRowsError) {
        throw new Error(`Failed to fetch active tickets for status reconciliation: ${activeRowsError.message}`);
      }

      const cachedActiveRows = ((activeRows ?? []) as TicketCacheActiveRow[])
        .filter((row) => typeof row.ticket_id === "number");
      const activeTicketIds = cachedActiveRows.map((row) => row.ticket_id);
      reconciledCheckedCount = activeTicketIds.length;

      if (activeTicketIds.length > 0) {
        const cachedByTicketId = new Map<number, TicketCacheActiveRow>();
        cachedActiveRows.forEach((row) => {
          cachedByTicketId.set(row.ticket_id, row);
        });

        const zendeskTickets = await fetchZendeskTicketsByIds(activeTicketIds, authHeader);
        const syncedAt = new Date().toISOString();
        const reconcileRows = zendeskTickets.map((ticket) => {
          const currentRow = cachedByTicketId.get(ticket.id);
          const embeddedRequesterName = normalizeString(ticket.requester?.name);
          const embeddedRequesterEmail = normalizeString(ticket.requester?.email);

          return {
            ticket_id: ticket.id,
            brand: mapBrand(ticket.brand_id),
            subject: ticket.subject ?? "",
            status: ticket.status ?? "new",
            priority: ticket.priority,
            requester_email: firstNonEmpty([embeddedRequesterEmail, normalizeString(currentRow?.requester_email)]),
            requester_name: firstNonEmpty([embeddedRequesterName, normalizeString(currentRow?.requester_name)]),
            assignee_email: firstNonEmpty([
              normalizeString(ticket.assignee?.email),
              normalizeString(currentRow?.assignee_email),
            ]),
            zendesk_created_at: ticket.created_at ?? ticket.updated_at,
            zendesk_updated_at: ticket.updated_at,
            ticket_url: buildTicketUrl(ticket.url, ticket.id),
            raw_payload: ticket,
            synced_at: syncedAt,
          };
        });

        if (reconcileRows.length > 0) {
          const { error: reconcileError } = await supabaseAdmin
            .from("ticket_cache")
            .upsert(reconcileRows, { onConflict: "ticket_id" });

          if (reconcileError) {
            throw new Error(`Supabase active-status reconcile upsert error: ${reconcileError.message}`);
          }

          reconciledUpsertedCount = reconcileRows.length;
          upsertedCount += reconcileRows.length;
        }
      }
    }

    const hasMore = Boolean(nextPageUrl);
    const { error: runUpdateError } = await supabaseAdmin
      .from("zendesk_sync_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        tickets_fetched: fetchedCount,
        tickets_upserted: upsertedCount,
        cursor: lastCursor,
        error_message: hasMore
          ? "Reached max_pages before end_of_stream. Rerun sync_zendesk to continue historical backfill."
          : null,
      })
      .eq("id", runId);

    if (runUpdateError) {
      throw new Error(`Failed to update sync run record: ${runUpdateError.message}`);
    }

    return jsonResponse({
      ok: true,
      run_id: runId,
      brand: options.brand,
      backfill_year: options.backfillYear,
      reconcile_active: options.reconcileActive,
      tickets_fetched: fetchedCount,
      tickets_upserted: upsertedCount,
      active_reconciliation_checked: reconciledCheckedCount,
      active_reconciliation_upserted: reconciledUpsertedCount,
      cursor: lastCursor,
      max_pages: maxPages,
      pages_processed: page,
      has_more: hasMore,
      end_of_stream_reached: !hasMore,
      start_cursor: initialCursor,
      target_backfill_cursor: targetBackfillCursor,
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
          cursor: lastCursorForError,
          error_message: message,
        })
        .eq("id", runId);
    }

    return jsonResponse({ error: message }, 500);
  }
});
