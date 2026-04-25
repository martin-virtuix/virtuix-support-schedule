import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeVirtuixRequest, HttpError } from "../_shared/auth.ts";

type WeeklyTicketReportRow = {
  period_start_date: string;
  period_end_date: string;
  brand: string;
  received_count: number;
  solved_closed_count: number;
  still_open_count: number;
  resolution_rate: number;
};

type TicketReceivedRollupRow = {
  period_type: string;
  period_start_date: string;
  period_end_date: string;
  brand: string;
  received_count: number;
  previous_period_start_date: string;
  previous_period_end_date: string;
  previous_received_count: number;
  delta: number;
  delta_pct: number | null;
};

type TicketDataCoverageRow = {
  earliest_created_at: string | null;
  latest_created_at: string | null;
  total_tickets: number;
  tickets_with_created_at: number;
  tickets_missing_created_at: number;
  latest_sync_started_at: string | null;
  latest_sync_finished_at: string | null;
  latest_sync_status: string | null;
  latest_sync_cursor: number | null;
  latest_sync_error: string | null;
};

type SyncZendeskResponse = {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  run_id?: string;
  tickets_fetched?: number;
  tickets_upserted?: number;
  cursor?: number;
  error?: string;
};

type SyncRunRow = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  tickets_fetched: number | null;
  tickets_upserted: number | null;
  error_message: string | null;
  cursor: number | null;
};

type DispatchRequest = {
  week_start_date?: string;
  reference_date?: string;
  skip_sync?: boolean;
  dry_run?: boolean;
};

type SupabaseRpcError = {
  message?: string;
};

type SyncRunsQuery = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  tickets_fetched: number | null;
  tickets_upserted: number | null;
  error_message: string | null;
  cursor: number | null;
};

type SyncRunIdQuery = {
  id: string;
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL") ?? Deno.env.get("SLACk_WEBHOOK_URL");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const REPORT_EMAIL_FROM = Deno.env.get("REPORT_EMAIL_FROM");
const REPORT_EMAIL_TO = parseEmailList(Deno.env.get("REPORT_EMAIL_TO"));
const REPORT_EMAIL_CC = parseEmailList(Deno.env.get("REPORT_EMAIL_CC"));
const REPORT_EMAIL_BCC = parseEmailList(Deno.env.get("REPORT_EMAIL_BCC"));

const CENTRAL_TIMEZONE = "America/Chicago";
const BRAND_LABELS: Record<string, string> = {
  total: "Total",
  omni_one: "Omni One",
  omni_arena: "Omni Arena",
  other: "Other Brands",
};
const PERIOD_LABELS: Record<string, string> = {
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseEmailList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

function getMissingEnvVars(): string[] {
  const missing: string[] = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!SLACK_WEBHOOK_URL) missing.push("SLACK_WEBHOOK_URL");
  if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!REPORT_EMAIL_FROM) missing.push("REPORT_EMAIL_FROM");
  if (REPORT_EMAIL_TO.length === 0) missing.push("REPORT_EMAIL_TO");
  return missing;
}

function toIsoDateOnly(value: Date): string {
  const year = value.getUTCFullYear();
  const month = `${value.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${value.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function shiftIsoDate(value: string, days: number): string {
  const date = parseIsoDate(value);
  if (!date) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDateOnly(date);
}

function formatDateInTimeZone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function getCurrentWeekStartDateISOInTimezone(timezone: string): string {
  const localDate = formatDateInTimeZone(new Date(), timezone);
  const parsed = parseIsoDate(localDate);
  if (!parsed) {
    throw new Error(`Failed to compute local date in timezone: ${timezone}`);
  }
  const day = parsed.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  parsed.setUTCDate(parsed.getUTCDate() + mondayOffset);
  return toIsoDateOnly(parsed);
}

function formatDateShort(value: string): string {
  const date = parseIsoDate(value);
  if (!date) return value;
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    timeZone: CENTRAL_TIMEZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatSignedIntDelta(value: number): string {
  const rounded = Math.round(value);
  if (rounded > 0) return `+${rounded}`;
  return `${rounded}`;
}

function formatSignedRateDelta(value: number): string {
  const points = value * 100;
  const normalized = Math.abs(points) < 0.05 ? 0 : Number(points.toFixed(1));
  if (normalized > 0) return `+${normalized.toFixed(1)}pp`;
  return `${normalized.toFixed(1)}pp`;
}

function formatPercentDelta(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "n/a";
  const percent = value * 100;
  const normalized = Math.abs(percent) < 0.05 ? 0 : Number(percent.toFixed(1));
  if (normalized > 0) return `+${normalized.toFixed(1)}%`;
  return `${normalized.toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeWeeklyRows(rows: unknown): WeeklyTicketReportRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      period_start_date: String(record.period_start_date ?? ""),
      period_end_date: String(record.period_end_date ?? ""),
      brand: String(record.brand ?? "other"),
      received_count: toNumber(record.received_count),
      solved_closed_count: toNumber(record.solved_closed_count),
      still_open_count: toNumber(record.still_open_count),
      resolution_rate: toNumber(record.resolution_rate),
    };
  });
}

function normalizeRollupRows(rows: unknown): TicketReceivedRollupRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    const deltaPctRaw = record.delta_pct;
    return {
      period_type: String(record.period_type ?? ""),
      period_start_date: String(record.period_start_date ?? ""),
      period_end_date: String(record.period_end_date ?? ""),
      brand: String(record.brand ?? "other"),
      received_count: toNumber(record.received_count),
      previous_period_start_date: String(record.previous_period_start_date ?? ""),
      previous_period_end_date: String(record.previous_period_end_date ?? ""),
      previous_received_count: toNumber(record.previous_received_count),
      delta: toNumber(record.delta),
      delta_pct: deltaPctRaw === null || deltaPctRaw === undefined ? null : toNumber(deltaPctRaw),
    };
  });
}

function normalizeCoverageRow(rows: unknown): TicketDataCoverageRow | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const record = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    earliest_created_at: typeof record.earliest_created_at === "string" ? record.earliest_created_at : null,
    latest_created_at: typeof record.latest_created_at === "string" ? record.latest_created_at : null,
    total_tickets: toNumber(record.total_tickets),
    tickets_with_created_at: toNumber(record.tickets_with_created_at),
    tickets_missing_created_at: toNumber(record.tickets_missing_created_at),
    latest_sync_started_at: typeof record.latest_sync_started_at === "string" ? record.latest_sync_started_at : null,
    latest_sync_finished_at: typeof record.latest_sync_finished_at === "string" ? record.latest_sync_finished_at : null,
    latest_sync_status: typeof record.latest_sync_status === "string" ? record.latest_sync_status : null,
    latest_sync_cursor: record.latest_sync_cursor === null || record.latest_sync_cursor === undefined
      ? null
      : toNumber(record.latest_sync_cursor),
    latest_sync_error: typeof record.latest_sync_error === "string" ? record.latest_sync_error : null,
  };
}

async function invokeSyncZendesk(): Promise<SyncZendeskResponse> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/sync_zendesk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ brand: "all" }),
  });

  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    const errorMessage = typeof payload.error === "string"
      ? payload.error
      : `sync_zendesk failed with status ${response.status}.`;
    throw new Error(errorMessage);
  }
  return payload as SyncZendeskResponse;
}

async function fetchSyncRunById(
  supabaseAdmin: ReturnType<typeof createClient>,
  runId: string,
): Promise<SyncRunRow | null> {
  const { data, error } = await supabaseAdmin
    .from("zendesk_sync_runs")
    .select("id,started_at,finished_at,status,tickets_fetched,tickets_upserted,error_message,cursor")
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load sync run ${runId}: ${error.message}`);
  }
  return (data as SyncRunsQuery | null) ?? null;
}

async function fetchLatestSyncRun(supabaseAdmin: ReturnType<typeof createClient>): Promise<SyncRunRow | null> {
  const { data, error } = await supabaseAdmin
    .from("zendesk_sync_runs")
    .select("id,started_at,finished_at,status,tickets_fetched,tickets_upserted,error_message,cursor")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load latest sync run: ${error.message}`);
  }
  return (data as SyncRunsQuery | null) ?? null;
}

async function waitForRunningSyncToFinish(supabaseAdmin: ReturnType<typeof createClient>): Promise<SyncRunRow | null> {
  const { data: runningRow, error: runningError } = await supabaseAdmin
    .from("zendesk_sync_runs")
    .select("id")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runningError) {
    throw new Error(`Failed to inspect running sync: ${runningError.message}`);
  }

  const running = (runningRow as SyncRunIdQuery | null) ?? null;
  if (!running?.id) {
    return fetchLatestSyncRun(supabaseAdmin);
  }

  const started = Date.now();
  const timeoutMs = 15 * 60 * 1000;
  while (Date.now() - started < timeoutMs) {
    const run = await fetchSyncRunById(supabaseAdmin, running.id);
    if (!run) {
      return fetchLatestSyncRun(supabaseAdmin);
    }
    if (run.status !== "running") {
      return run;
    }
    await sleep(10_000);
  }

  throw new Error("Timed out waiting for running Zendesk sync job to complete.");
}

function buildWeeklySummaryText(
  weeklyRows: WeeklyTicketReportRow[],
  previousWeeklyRows: WeeklyTicketReportRow[],
  weekStartDate: string,
): string {
  if (weeklyRows.length === 0) {
    return "Weekly Summary: no report rows returned.";
  }

  const orderedBrands = ["total", "omni_one", "omni_arena", "other"];
  const currentByBrand = new Map(weeklyRows.map((row) => [row.brand, row]));
  const previousByBrand = new Map(previousWeeklyRows.map((row) => [row.brand, row]));
  const totalRow = currentByBrand.get("total") || weeklyRows[0];
  const currentStart = totalRow?.period_start_date || weekStartDate;
  const currentEnd = totalRow?.period_end_date || shiftIsoDate(currentStart, 6);
  const previousTotal = previousByBrand.get("total") || null;

  const lines: string[] = [
    `Weekly Ticket Report (${formatDateShort(currentStart)} - ${formatDateShort(currentEnd)})`,
  ];

  if (previousTotal) {
    lines.push(
      `Compared to previous week (${formatDateShort(previousTotal.period_start_date)} - ${formatDateShort(previousTotal.period_end_date)}).`,
    );
  }
  lines.push("Spam/deleted tickets excluded.");
  lines.push("");

  orderedBrands.forEach((brand) => {
    const current = currentByBrand.get(brand);
    if (!current) return;
    const previous = previousByBrand.get(brand);
    const receivedDelta = previous ? formatSignedIntDelta(current.received_count - previous.received_count) : "n/a";
    const solvedDelta = previous ? formatSignedIntDelta(current.solved_closed_count - previous.solved_closed_count) : "n/a";
    const openDelta = previous ? formatSignedIntDelta(current.still_open_count - previous.still_open_count) : "n/a";
    const rateDelta = previous ? formatSignedRateDelta(current.resolution_rate - previous.resolution_rate) : "n/a";
    lines.push(
      `${BRAND_LABELS[brand] ?? brand}: received ${current.received_count} (WoW ${receivedDelta}), solved/closed ${current.solved_closed_count} (WoW ${solvedDelta}), still open ${current.still_open_count} (WoW ${openDelta}), resolution ${(current.resolution_rate * 100).toFixed(1)}% (WoW ${rateDelta}).`,
    );
  });

  return lines.join("\n");
}

function buildRollupSummaryText(rollupRows: TicketReceivedRollupRow[], referenceDate: string): string {
  if (rollupRows.length === 0) {
    return "Ticket Intake Search Summary: no rollup rows returned.";
  }

  const orderedPeriods = ["month", "quarter", "year"];
  const orderedBrands = ["total", "omni_one", "omni_arena", "other"];
  const byKey = new Map(rollupRows.map((row) => [`${row.period_type}:${row.brand}`, row]));

  const lines: string[] = [
    `Ticket Intake Search Summary (reference date: ${formatDateShort(referenceDate)})`,
    "Spam/deleted tickets excluded.",
    "",
  ];

  orderedPeriods.forEach((period) => {
    const total = byKey.get(`${period}:total`);
    if (!total) return;
    lines.push(
      `${PERIOD_LABELS[period] ?? period} (${formatDateShort(total.period_start_date)} - ${formatDateShort(total.period_end_date)}): ${total.received_count} received, previous ${total.previous_received_count}, delta ${formatSignedIntDelta(total.delta)} (${formatPercentDelta(total.delta_pct)}).`,
    );
    orderedBrands.filter((brand) => brand !== "total").forEach((brand) => {
      const row = byKey.get(`${period}:${brand}`);
      if (!row) return;
      lines.push(
        `- ${BRAND_LABELS[brand] ?? brand}: ${row.received_count} (prev ${row.previous_received_count}, delta ${formatSignedIntDelta(row.delta)} / ${formatPercentDelta(row.delta_pct)})`,
      );
    });
    lines.push("");
  });

  return lines.join("\n").trim();
}

function buildWeeklySummaryHtml(weeklyRows: WeeklyTicketReportRow[], previousWeeklyRows: WeeklyTicketReportRow[]): string {
  if (weeklyRows.length === 0) {
    return "<p>No weekly report rows returned.</p>";
  }

  const orderedBrands = ["total", "omni_one", "omni_arena", "other"];
  const currentByBrand = new Map(weeklyRows.map((row) => [row.brand, row]));
  const previousByBrand = new Map(previousWeeklyRows.map((row) => [row.brand, row]));

  const bodyRows = orderedBrands
    .map((brand) => {
      const current = currentByBrand.get(brand);
      if (!current) return "";
      const previous = previousByBrand.get(brand);
      const receivedDelta = previous ? formatSignedIntDelta(current.received_count - previous.received_count) : "n/a";
      const solvedDelta = previous ? formatSignedIntDelta(current.solved_closed_count - previous.solved_closed_count) : "n/a";
      const openDelta = previous ? formatSignedIntDelta(current.still_open_count - previous.still_open_count) : "n/a";
      const rateDelta = previous ? formatSignedRateDelta(current.resolution_rate - previous.resolution_rate) : "n/a";
      return `
        <tr>
          <td>${escapeHtml(BRAND_LABELS[brand] ?? brand)}</td>
          <td>${current.received_count}</td>
          <td>${escapeHtml(receivedDelta)}</td>
          <td>${current.solved_closed_count}</td>
          <td>${escapeHtml(solvedDelta)}</td>
          <td>${current.still_open_count}</td>
          <td>${escapeHtml(openDelta)}</td>
          <td>${(current.resolution_rate * 100).toFixed(1)}%</td>
          <td>${escapeHtml(rateDelta)}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead>
        <tr>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Brand</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Received</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">WoW Received</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Solved/Closed</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">WoW Solved</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Still Open</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">WoW Open</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Resolution</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">WoW Rate</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

function buildRollupSummaryHtml(rollupRows: TicketReceivedRollupRow[]): string {
  if (rollupRows.length === 0) {
    return "<p>No M/Q/Y intake rows returned.</p>";
  }

  const orderedPeriods = ["month", "quarter", "year"];
  const orderedBrands = ["total", "omni_one", "omni_arena", "other"];
  const byKey = new Map(rollupRows.map((row) => [`${row.period_type}:${row.brand}`, row]));

  return orderedPeriods
    .map((period) => {
      const total = byKey.get(`${period}:total`);
      if (!total) return "";

      const rows = orderedBrands
        .map((brand) => {
          const row = byKey.get(`${period}:${brand}`);
          if (!row) return "";
          return `
            <tr>
              <td>${escapeHtml(BRAND_LABELS[brand] ?? brand)}</td>
              <td>${row.received_count}</td>
              <td>${row.previous_received_count}</td>
              <td>${escapeHtml(formatSignedIntDelta(row.delta))}</td>
              <td>${escapeHtml(formatPercentDelta(row.delta_pct))}</td>
            </tr>
          `;
        })
        .join("");

      return `
        <h3 style="margin:18px 0 8px">${escapeHtml(PERIOD_LABELS[period] ?? period)} (${formatDateShort(total.period_start_date)} - ${formatDateShort(total.period_end_date)})</h3>
        <table style="border-collapse:collapse;width:100%;font-size:14px">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Brand</th>
              <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Received</th>
              <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Previous</th>
              <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Delta</th>
              <th style="text-align:left;padding:8px;border-bottom:1px solid #ddd">Delta %</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    })
    .join("");
}

async function postToSlack(text: string): Promise<void> {
  const response = await fetch(SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${body}`);
  }
}

async function sendEmailReport(subject: string, html: string, text: string): Promise<void> {
  const payload: Record<string, unknown> = {
    from: REPORT_EMAIL_FROM!,
    to: REPORT_EMAIL_TO,
    subject,
    html,
    text,
  };

  if (REPORT_EMAIL_CC.length > 0) payload.cc = REPORT_EMAIL_CC;
  if (REPORT_EMAIL_BCC.length > 0) payload.bcc = REPORT_EMAIL_BCC;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend email failed (${response.status}): ${body}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const missingEnv = getMissingEnvVars();
  if (missingEnv.length > 0) {
    return jsonResponse({ error: `Missing required environment variables: ${missingEnv.join(", ")}` }, 500);
  }

  let requestWasDryRun = false;
  try {
    await authorizeVirtuixRequest(req, { allowServiceRole: true, functionName: "weekly_ticket_report_dispatch" });

    const body = await req.json().catch(() => ({} as DispatchRequest));
    const requestedWeekStart = typeof body.week_start_date === "string" ? body.week_start_date.trim() : "";
    const requestedReferenceDate = typeof body.reference_date === "string" ? body.reference_date.trim() : "";
    const skipSync = body.skip_sync === true;
    const dryRun = body.dry_run === true;
    requestWasDryRun = dryRun;

    const weekStartDate = requestedWeekStart || getCurrentWeekStartDateISOInTimezone(CENTRAL_TIMEZONE);
    const referenceDate = requestedReferenceDate || formatDateInTimeZone(new Date(), CENTRAL_TIMEZONE);
    if (!parseIsoDate(weekStartDate)) {
      return jsonResponse({ error: "Invalid week_start_date. Expected YYYY-MM-DD." }, 400);
    }
    if (!parseIsoDate(referenceDate)) {
      return jsonResponse({ error: "Invalid reference_date. Expected YYYY-MM-DD." }, 400);
    }

    const previousWeekStartDate = shiftIsoDate(weekStartDate, -7);
    const weekEndDate = shiftIsoDate(weekStartDate, 6);

    const supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });

    let syncResponse: SyncZendeskResponse = { ok: true, skipped: true, reason: "skip_sync requested" };
    if (!skipSync) {
      syncResponse = await invokeSyncZendesk();
    }

    let syncRun: SyncRunRow | null = null;
    if (syncResponse.run_id) {
      syncRun = await fetchSyncRunById(supabaseAdmin, syncResponse.run_id);
    } else if (syncResponse.skipped) {
      syncRun = await waitForRunningSyncToFinish(supabaseAdmin);
    } else {
      syncRun = await fetchLatestSyncRun(supabaseAdmin);
    }

    if (!skipSync && syncRun?.status === "error") {
      const syncError = syncRun.error_message || "Zendesk sync run finished with error status.";
      throw new Error(`Zendesk sync failed: ${syncError}`);
    }

    const [weeklyCurrentResult, weeklyPreviousResult, rollupResult, coverageResult] = await Promise.all([
      supabaseAdmin.rpc("get_weekly_ticket_report", {
        period_start: weekStartDate,
        period_days: 7,
      }),
      supabaseAdmin.rpc("get_weekly_ticket_report", {
        period_start: previousWeekStartDate,
        period_days: 7,
      }),
      supabaseAdmin.rpc("get_ticket_received_rollup", {
        reference_date: referenceDate,
      }),
      supabaseAdmin.rpc("get_ticket_data_coverage"),
    ]);

    if (weeklyCurrentResult.error) {
      throw new Error((weeklyCurrentResult.error as SupabaseRpcError).message ?? "Failed to load weekly report.");
    }
    if (weeklyPreviousResult.error) {
      throw new Error((weeklyPreviousResult.error as SupabaseRpcError).message ?? "Failed to load previous weekly report.");
    }
    if (rollupResult.error) {
      throw new Error((rollupResult.error as SupabaseRpcError).message ?? "Failed to load ticket rollup report.");
    }
    if (coverageResult.error) {
      throw new Error((coverageResult.error as SupabaseRpcError).message ?? "Failed to load ticket data coverage.");
    }

    const weeklyRows = normalizeWeeklyRows(weeklyCurrentResult.data);
    const previousWeeklyRows = normalizeWeeklyRows(weeklyPreviousResult.data);
    const rollupRows = normalizeRollupRows(rollupResult.data);
    const coverage = normalizeCoverageRow(coverageResult.data);

    const weeklySummaryText = buildWeeklySummaryText(weeklyRows, previousWeeklyRows, weekStartDate);
    const rollupSummaryText = buildRollupSummaryText(rollupRows, referenceDate);

    const syncStatusLine = syncRun
      ? `Sync status: ${syncRun.status} | fetched ${syncRun.tickets_fetched ?? 0} | upserted ${syncRun.tickets_upserted ?? 0} | finished ${formatDateTime(syncRun.finished_at)}`
      : `Sync status: ${syncResponse.skipped ? "skipped" : "ok"}${syncResponse.reason ? ` (${syncResponse.reason})` : ""}`;

    const coverageLine = coverage
      ? `Coverage: ${coverage.earliest_created_at ? formatDateTime(coverage.earliest_created_at) : "-"} to ${coverage.latest_created_at ? formatDateTime(coverage.latest_created_at) : "-"} | ${coverage.tickets_with_created_at} tickets with created date`
      : "Coverage: not available.";

    const textReport = [
      `Virtuix Support Weekly Ticket Report`,
      `Week: ${formatDateShort(weekStartDate)} - ${formatDateShort(weekEndDate)} (generated ${formatDateTime(new Date().toISOString())} ${CENTRAL_TIMEZONE})`,
      syncStatusLine,
      coverageLine,
      "",
      weeklySummaryText,
      "",
      rollupSummaryText,
    ].join("\n");

    const htmlReport = `
      <div style="font-family:Arial,sans-serif;line-height:1.45;color:#101010">
        <h2 style="margin-bottom:6px">Virtuix Support Weekly Ticket Report</h2>
        <p style="margin:0 0 6px">Week: <strong>${escapeHtml(formatDateShort(weekStartDate))} - ${escapeHtml(formatDateShort(weekEndDate))}</strong></p>
        <p style="margin:0 0 6px">${escapeHtml(syncStatusLine)}</p>
        <p style="margin:0 0 14px">${escapeHtml(coverageLine)}</p>

        <h3 style="margin:14px 0 8px">Weekly Summary</h3>
        ${buildWeeklySummaryHtml(weeklyRows, previousWeeklyRows)}

        <h3 style="margin:18px 0 8px">Ticket Intake Search (M/Q/Y)</h3>
        ${buildRollupSummaryHtml(rollupRows)}
      </div>
    `;

    const slackReport = [
      `*Virtuix Support Weekly Ticket Report*`,
      `Week: ${formatDateShort(weekStartDate)} - ${formatDateShort(weekEndDate)}`,
      syncStatusLine,
      coverageLine,
      "",
      weeklySummaryText,
      "",
      rollupSummaryText,
    ].join("\n");

    const subject = `[Support Hub] Weekly Ticket Report - ${formatDateShort(weekStartDate)} to ${formatDateShort(weekEndDate)}`;

    if (dryRun) {
      return jsonResponse({
        ok: true,
        dry_run: true,
        week_start_date: weekStartDate,
        reference_date: referenceDate,
        subject,
        sync: syncResponse,
        sync_run: syncRun,
        preview_text: textReport,
        preview_slack: slackReport,
        preview_email_html: htmlReport,
      });
    }

    await Promise.all([
      postToSlack(slackReport),
      sendEmailReport(subject, htmlReport, textReport),
    ]);

    return jsonResponse({
      ok: true,
      week_start_date: weekStartDate,
      reference_date: referenceDate,
      sync: syncResponse,
      sync_run: syncRun,
      weekly_rows: weeklyRows.length,
      rollup_rows: rollupRows.length,
      email_to: REPORT_EMAIL_TO,
      email_cc: REPORT_EMAIL_CC,
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

    const message = error instanceof Error ? error.message : "Unknown weekly report dispatch error.";

    // Best-effort alert for pipeline failures.
    try {
      if (SLACK_WEBHOOK_URL && !requestWasDryRun) {
        await postToSlack(`:warning: Weekly report dispatch failed: ${message}`);
      }
    } catch {
      // no-op: avoid masking original failure with alert failure
    }

    return jsonResponse({ error: message }, 500);
  }
});
