import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { CalendarDays, Copy, Download, ExternalLink, FileText, Loader2, Menu, RefreshCw, Search, Send, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BrandLockup } from "@/components/BrandLockup";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ArenaSitesTable } from "@/components/schedule/ArenaSitesTable";
import { CopilotChatDock, type CopilotChatInputMessage } from "@/components/hub/CopilotChatDock";
import { VideosPane } from "@/components/hub/VideosPane";
import { getArenaSites, type ArenaSite } from "@/lib/scheduleData";
import { getHubVideoLibraryEntries } from "@/lib/hubVideos";
import { useToast } from "@/hooks/use-toast";
import type {
  CopilotCitation,
  CopilotChatResponse,
  CreateDigestResponse,
  Digest,
  HubAnalyticsTrackResponse,
  SemanticSearchDocumentResult,
  SemanticSearchDocumentsResponse,
  SendToSlackResponse,
  SummarizeTicketResponse,
  SyncZendeskResponse,
  Ticket,
  TicketSearchResult,
  TicketReceivedRollupRow,
  TicketSummary,
  WeeklyTicketReportDispatchResponse,
  WeeklyTicketReportRow,
} from "@/types/support";
import omniArenaLogo from "@/assets/omniarena-logo.png";
import omniOneLogo from "@/assets/omnione_logo_color.png";

const ALLOWED_DOMAIN = "@virtuix.com";
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const SUPPORT_DOCUMENTS_BUCKET = import.meta.env.VITE_SUPPORT_DOCUMENTS_BUCKET || "support-documents";
const SUPPORT_DOCUMENTS_BRANDS = ["omni_one", "omni_arena"] as const;

type DocumentBrand = (typeof SUPPORT_DOCUMENTS_BRANDS)[number];

function isDocumentBrand(value: string): value is DocumentBrand {
  return value === "omni_one" || value === "omni_arena";
}

type SyncSummary = {
  finishedAt: string | null;
  ticketsUpserted: number;
  status: string;
};

type DigestRequest = {
  ticketIds?: number[];
  filters?: {
    brand?: string;
    status?: string;
    search?: string;
    limit?: number;
  };
};

type TableProps = {
  rows: Ticket[];
  loading: boolean;
  error: string | null;
  selectedIds: Set<number>;
  onSelectionChange: (ticketId: number, checked: boolean) => void;
  onSelectAllVisible: (ticketIds: number[], checked: boolean) => void;
  onOpenTicket: (ticket: Ticket) => void;
  onGenerateDigest: (request: DigestRequest) => Promise<void>;
  generatingDigest: boolean;
};

type TicketSearchPaneProps = {
  query: string;
  loading: boolean;
  error: string | null;
  submittedQuery: string;
  results: TicketSearchResult[];
  selectedIds: Set<number>;
  onQueryChange: (value: string) => void;
  onSearch: () => Promise<void>;
  onClear: () => void;
  onSelectionChange: (ticketId: number, checked: boolean) => void;
  onSelectAllVisible: (ticketIds: number[], checked: boolean) => void;
  onOpenTicket: (ticket: Ticket) => void;
  onGenerateDigest: (request: DigestRequest) => Promise<void>;
  generatingDigest: boolean;
};

type JwtClaims = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
  ref?: unknown;
  role?: unknown;
};

type AccessTokenContext = {
  token: string;
  claims: JwtClaims;
};

type SupportDocument = {
  brand: DocumentBrand;
  path: string;
  name: string;
  updatedAt: string | null;
  sizeBytes: number | null;
};

type HubViewKey = "tickets" | "digests" | "documents" | "videos" | "reports";

type HubRouteTab = {
  key: HubViewKey;
  label: string;
  path: string;
  active: boolean;
  description: string;
};

type WorkspaceMetric = {
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
};

type PaneErrorBoundaryState = {
  error: Error | null;
};

const ACTIVE_TICKET_STATUSES = new Set(["new", "open", "pending"]);
const REPORT_BACKLOG_STATUSES = new Set(["open", "pending"]);

type ReportCountEntry = {
  label: string;
  count: number;
};

const TICKET_THEME_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: "Display / TV", pattern: /\b(tv|display|screen|monitor)\b/i },
  { label: "PC / Hardware", pattern: /\b(pc|computer|gpu|cpu|motherboard|power supply|ssd|hardware)\b/i },
  { label: "Cabling / Electrical", pattern: /\b(cable|he cable|wiring|connector|usb|hdmi|ethernet|power cable)\b/i },
  { label: "Mechanical / Parts", pattern: /\b(agg|ring handle|handle|latch|arm|bracket|frame|strap|foot tracker|tracker)\b/i },
  { label: "Setup / Calibration", pattern: /\b(setup|set up|install|assemble|pair|calibration|calibrate|adjust)\b/i },
  { label: "Shipping / RMA", pattern: /\b(rma|shipping|shipment|return|warranty|replacement|replace)\b/i },
  { label: "Software / Account", pattern: /\b(software|firmware|app|launcher|steam|login|password|account)\b/i },
  { label: "Billing / Orders", pattern: /\b(billing|invoice|payment|refund|charge|order|purchase|quote)\b/i },
];

function isReportBacklogStatus(status: string): boolean {
  return REPORT_BACKLOG_STATUSES.has(status.toLowerCase());
}

function getOpenPendingTickets(rows: Ticket[]): Ticket[] {
  return rows.filter((ticket) => isReportBacklogStatus(ticket.status));
}

function getOpenPendingStatusCounts(rows: Ticket[]): { open: number; pending: number; total: number } {
  const counts = rows.reduce(
    (accumulator, ticket) => {
      const normalizedStatus = ticket.status.toLowerCase();
      if (normalizedStatus === "open") accumulator.open += 1;
      if (normalizedStatus === "pending") accumulator.pending += 1;
      return accumulator;
    },
    { open: 0, pending: 0 },
  );

  return {
    ...counts,
    total: counts.open + counts.pending,
  };
}

function getTicketStatusCounts(rows: Ticket[]): { open: number; pending: number; new: number; active: number } {
  return rows.reduce(
    (accumulator, ticket) => {
      const normalizedStatus = ticket.status.toLowerCase();
      if (normalizedStatus === "open") accumulator.open += 1;
      if (normalizedStatus === "pending") accumulator.pending += 1;
      if (normalizedStatus === "new") accumulator.new += 1;
      if (ACTIVE_TICKET_STATUSES.has(normalizedStatus)) accumulator.active += 1;
      return accumulator;
    },
    { open: 0, pending: 0, new: 0, active: 0 },
  );
}

function toTopCounts(values: Array<string | null | undefined>, limit = 3): ReportCountEntry[] {
  const counts = new Map<string, number>();

  values.forEach((value) => {
    const normalized = value?.trim();
    if (!normalized) return;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function getTicketTheme(subject: string): string {
  const normalizedSubject = subject.trim();
  if (normalizedSubject.length === 0) return "General Support";

  const matchedRule = TICKET_THEME_RULES.find((rule) => rule.pattern.test(normalizedSubject));
  return matchedRule?.label || "General Support";
}

function getTopTicketThemes(rows: Ticket[], limit = 3): ReportCountEntry[] {
  return toTopCounts(rows.map((ticket) => getTicketTheme(ticket.subject)), limit);
}

function getTicketRequesterLabel(ticket: Ticket): string {
  const requester = firstNonEmptyString(ticket.requester_name, ticket.requester_email);
  if (!requester) return "Unknown requester";
  return requester;
}

function getTopTicketRequesters(rows: Ticket[], limit = 5): ReportCountEntry[] {
  return toTopCounts(rows.map((ticket) => getTicketRequesterLabel(ticket)), limit);
}

type ClientAuthDebug = {
  token_prefix: string | null;
  token_project_ref: string | null;
  token_role: string | null;
  expected_project_ref: string | null;
  token_expired: boolean | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractRequesterFromRawPayload(rawPayload: unknown): { name: string | null; email: string | null } {
  const payload = asRecord(rawPayload);
  if (!payload) {
    return { name: null, email: null };
  }

  const requester = asRecord(payload.requester);
  const submitter = asRecord(payload.submitter);
  const via = asRecord(payload.via);
  const viaSource = asRecord(via?.source);
  const viaFrom = asRecord(viaSource?.from);

  const name = firstNonEmptyString(
    normalizeOptionalString(requester?.name),
    normalizeOptionalString(submitter?.name),
    normalizeOptionalString(viaFrom?.name),
  );

  const email = firstNonEmptyString(
    normalizeOptionalString(requester?.email),
    normalizeOptionalString(submitter?.email),
    normalizeOptionalString(viaFrom?.address),
    normalizeOptionalString(viaFrom?.email),
  );

  return { name, email };
}

function isAllowedEmail(email?: string | null): boolean {
  return !!email && email.toLowerCase().endsWith(ALLOWED_DOMAIN);
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatDateShort(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toIsoDateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentWeekStartDateISO(): string {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);
  return toIsoDateOnly(monday);
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  date.setDate(date.getDate() + days);
  return toIsoDateOnly(date);
}

function formatSignedIntDelta(value: number): string {
  const rounded = Math.round(value);
  if (rounded > 0) return `+${rounded}`;
  return `${rounded}`;
}

function formatSignedPercentDelta(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "n/a";
  const percent = value * 100;
  const normalized = Math.abs(percent) < 0.05 ? 0 : Number(percent.toFixed(1));
  if (normalized > 0) return `+${normalized.toFixed(1)}%`;
  return `${normalized.toFixed(1)}%`;
}

function formatFileSize(sizeBytes: number | null): string {
  if (typeof sizeBytes !== "number" || Number.isNaN(sizeBytes) || sizeBytes < 0) {
    return "Unknown size";
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function trimLeadingSlashes(path: string): string {
  return path.replace(/^\/+/, "");
}

function normalizeStoragePath(path: string): string {
  return trimLeadingSlashes(path).replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

function resolveStorageItemPath(folder: string, itemName: string, brand: DocumentBrand): string {
  const rawName = trimLeadingSlashes(itemName);
  if (rawName.startsWith(`${brand}/`)) {
    return rawName;
  }

  const rawFolder = trimLeadingSlashes(folder);
  return `${rawFolder}/${itemName}`.replace(/^\/+/, "");
}

function getDocumentRelativePath(path: string, brand: DocumentBrand): string | null {
  const normalizedPath = normalizeStoragePath(path);
  const prefix = `${brand}/`;
  if (!normalizedPath.startsWith(prefix)) {
    return null;
  }
  return normalizedPath.slice(prefix.length);
}

function getDocumentTopLevelFolder(path: string, brand: DocumentBrand): string | null {
  const relativePath = getDocumentRelativePath(path, brand);
  if (!relativePath) {
    return null;
  }

  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) {
    return null;
  }
  return segments[0];
}

function getFolderOptionsForBrand(documents: SupportDocument[], brand: DocumentBrand): string[] {
  const folders = new Set<string>();
  documents.forEach((document) => {
    const folder = getDocumentTopLevelFolder(document.path, brand);
    if (folder) {
      folders.add(folder);
    }
  });
  return Array.from(folders).sort((a, b) => a.localeCompare(b));
}

function filterDocumentsByFolder(
  documents: SupportDocument[],
  brand: DocumentBrand,
  topLevelFolder: string | null,
): SupportDocument[] {
  if (!topLevelFolder) {
    return documents;
  }
  return documents.filter((document) => getDocumentTopLevelFolder(document.path, brand) === topLevelFolder);
}

function getFirstDocumentPath(
  documentsByBrand: Record<DocumentBrand, SupportDocument[]>,
  brand: DocumentBrand,
  topLevelFolder: string | null,
): string | null {
  const byFolder = filterDocumentsByFolder(documentsByBrand[brand] || [], brand, topLevelFolder);
  if (byFolder.length > 0) {
    return byFolder[0].path;
  }
  return (documentsByBrand[brand] || [])[0]?.path || null;
}

function flattenDocumentsByBrand(documentsByBrand: Record<DocumentBrand, SupportDocument[]>): SupportDocument[] {
  return SUPPORT_DOCUMENTS_BRANDS.reduce<SupportDocument[]>((allDocuments, brand) => {
    const docs = documentsByBrand[brand] || [];
    docs.forEach((document) => allDocuments.push(document));
    return allDocuments;
  }, []);
}

function statusPillClasses(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "new") {
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  }
  if (normalized === "open") {
    return "bg-red-500/15 text-red-300 border-red-500/30";
  }
  if (normalized === "pending") {
    return "bg-blue-500/15 text-blue-300 border-blue-500/30";
  }
  if (normalized === "hold") {
    return "bg-purple-500/15 text-purple-300 border-purple-500/30";
  }
  return "bg-muted text-muted-foreground border-border";
}

async function extractFunctionErrorMessage(error: unknown): Promise<string> {
  if (!error || typeof error !== "object") {
    return "Unknown function error.";
  }

  const fallback =
    "message" in error && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Unknown function error.";

  const context = "context" in error ? (error as { context?: unknown }).context : null;
  if (context && typeof context === "object") {
    const response = context as Response;
    if (typeof response.json === "function") {
      try {
        const body = await response.json();
        if (body && typeof body === "object") {
          if ("error" in body && typeof (body as { error?: unknown }).error === "string") {
            return (body as { error: string }).error;
          }
          if ("message" in body && typeof (body as { message?: unknown }).message === "string") {
            return (body as { message: string }).message;
          }
        }
      } catch {
        // Fallback below.
      }
    }
  }

  return fallback;
}

function isAuthTokenErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "invalid jwt",
    "invalid or expired user token",
    "missing authorization header",
    "auth_invalid_or_expired_user_token",
    "jwt expired",
  ].some((needle) => normalized.includes(needle));
}

function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = atob(`${normalized}${padding}`);
    return JSON.parse(decoded) as JwtClaims;
  } catch {
    return null;
  }
}

function extractProjectRefFromSupabaseUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const ref = parsed.hostname.split(".")[0];
    return ref || null;
  } catch {
    return null;
  }
}

function extractProjectRefFromIssuer(issuer: unknown): string | null {
  if (typeof issuer !== "string" || issuer.trim().length === 0 || issuer === "supabase") {
    return null;
  }

  try {
    const parsed = new URL(issuer);
    const ref = parsed.hostname.split(".")[0];
    return ref || null;
  } catch {
    return null;
  }
}

function extractProjectRefFromClaims(claims: JwtClaims): string | null {
  if (typeof claims.ref === "string" && claims.ref.trim().length > 0) {
    return claims.ref;
  }
  return extractProjectRefFromIssuer(claims.iss);
}

function getJwtExp(claims: JwtClaims): number | null {
  if (typeof claims.exp === "number") return claims.exp;
  if (typeof claims.exp === "string") {
    const parsed = Number.parseInt(claims.exp, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeAccessToken(rawToken: string): string {
  let token = rawToken.trim();
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  if (
    (token.startsWith("\"") && token.endsWith("\"")) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token;
}

function tokenNeedsRefreshSoon(claims: JwtClaims, skewSeconds = 45): boolean {
  const exp = getJwtExp(claims);
  if (!exp) return false;
  return exp <= Math.floor(Date.now() / 1000) + skewSeconds;
}

async function getSessionAccessTokenContext(forceRefresh = false): Promise<AccessTokenContext> {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Supabase URL or publishable key is missing in frontend env.");
  }

  const sessionData = await supabase.auth.getSession();
  if (sessionData.error) {
    throw new Error(`Unable to read auth session: ${sessionData.error.message}`);
  }

  let session = sessionData.data.session;

  if (forceRefresh || !session?.access_token) {
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session?.access_token) {
      throw new Error("Unable to refresh auth session. Please sign in again.");
    }
    session = refreshed.data.session;
  }

  let normalizedToken = normalizeAccessToken(session.access_token);
  let claims = decodeJwtClaims(normalizedToken);
  if (!claims) {
    throw new Error("Session access token is malformed. Please sign in again.");
  }

  if (!forceRefresh && tokenNeedsRefreshSoon(claims)) {
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session?.access_token) {
      throw new Error("Session refresh failed. Please sign in again.");
    }

    session = refreshed.data.session;
    normalizedToken = normalizeAccessToken(session.access_token);
    claims = decodeJwtClaims(normalizedToken);
    if (!claims) {
      throw new Error("Refreshed access token is malformed. Please sign in again.");
    }
  }

  const expectedRef = extractProjectRefFromSupabaseUrl(SUPABASE_URL);
  const tokenRef = extractProjectRefFromClaims(claims);
  if (expectedRef && tokenRef && tokenRef !== expectedRef) {
    await supabase.auth.signOut();
    throw new Error(
      `Session token belongs to project ${tokenRef}, but app is configured for ${expectedRef}. Sign in again.`,
    );
  }

  return { token: normalizedToken, claims };
}

async function getClientAuthDebugSnapshot(): Promise<ClientAuthDebug> {
  try {
    const auth = await getSessionAccessTokenContext(false);
    return {
      token_prefix: auth.token.slice(0, 20),
      token_project_ref: extractProjectRefFromClaims(auth.claims),
      token_role: typeof auth.claims.role === "string" ? auth.claims.role : null,
      expected_project_ref: extractProjectRefFromSupabaseUrl(SUPABASE_URL),
      token_expired: tokenNeedsRefreshSoon(auth.claims, 0),
    };
  } catch {
    return {
      token_prefix: null,
      token_project_ref: null,
      token_role: null,
      expected_project_ref: extractProjectRefFromSupabaseUrl(SUPABASE_URL),
      token_expired: null,
    };
  }
}

async function invokeFunctionWithAccessTokenFallback<T>(
  name: string,
  body: Record<string, unknown>,
  token: string,
): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Supabase URL or publishable key is missing in frontend env.");
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: (T & { error?: string; message?: string }) | null = null;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text) as T & { error?: string; message?: string };
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const message =
      parsed?.error && typeof parsed.error === "string"
        ? parsed.error
        : parsed?.message && typeof parsed.message === "string"
          ? parsed.message
          : `Fallback call failed for ${name} (${response.status}).`;
    throw new Error(message);
  }

  if (!parsed) {
    throw new Error(`Fallback call returned empty response for ${name}.`);
  }

  return parsed as T;
}

function normalizeSummaryRecord(item: {
  ticket_id: number;
  summary_text: string;
  key_actions: unknown;
  next_steps: unknown;
  updated_at: string;
}): TicketSummary {
  return {
    ticket_id: item.ticket_id,
    summary_text: item.summary_text,
    key_actions: Array.isArray(item.key_actions) ? item.key_actions.filter((entry): entry is string => typeof entry === "string") : [],
    next_steps: Array.isArray(item.next_steps) ? item.next_steps.filter((entry): entry is string => typeof entry === "string") : [],
    updated_at: item.updated_at,
  };
}

function normalizeTicketRecord(item: Ticket & { raw_payload?: unknown }): Ticket {
  const fallbackRequester = extractRequesterFromRawPayload(item.raw_payload);
  return {
    ticket_id: item.ticket_id,
    brand: item.brand,
    subject: item.subject,
    status: item.status,
    priority: item.priority,
    requester_email: firstNonEmptyString(item.requester_email, fallbackRequester.email),
    requester_name: firstNonEmptyString(item.requester_name, fallbackRequester.name),
    assignee_email: item.assignee_email,
    zendesk_updated_at: item.zendesk_updated_at,
    ticket_url: item.ticket_url,
    summary_text: item.summary_text,
  };
}

function formatTicketTableForClipboard(rows: Array<Record<string, unknown>>): string {
  const header = ["Ticket ID", "Requester", "Created At", "Updated At", "Subject"];
  const lines = [header.join("\t")];
  rows.forEach((row) => {
    const ticketId = row.ticket_id ?? row.ticket ?? "";
    const requester = row.requester ?? row.requester_name ?? row.requester_email ?? "";
    const createdAt = row.created_at ?? row.zendesk_created_at ?? "";
    const updatedAt = row.updated_at ?? row.zendesk_updated_at ?? "";
    const subject = row.subject ?? row.summary ?? "";

    lines.push(
      [
        ticketId,
        requester,
        createdAt,
        updatedAt,
        subject,
      ]
        .map((cell) => String(cell ?? ""))
        .join("\t"),
    );
  });

  return lines.join("\n");
}

function WorkspaceMetricCard({ label, value, detail, accent = false }: WorkspaceMetric) {
  return (
    <article
      className={[
        "rounded-2xl border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_36px_-28px_hsl(var(--primary)/0.88)]",
        accent
          ? "border-primary/45 bg-primary/[0.12] hover:border-primary/65"
          : "border-border/70 bg-background/45 hover:border-primary/45 hover:bg-background/60",
      ].join(" ")}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight md:text-[1.75rem]">{value}</p>
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{detail}</p>
    </article>
  );
}

class PaneErrorBoundary extends React.Component<React.PropsWithChildren, PaneErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): PaneErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Hub pane render error", error);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="surface-panel p-5 md:p-6">
          <p className="brand-kicker">Route Error</p>
          <h2 className="mt-3 text-xl font-semibold tracking-tight">This hub section failed to render.</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Open the browser console for the exact stack trace. The error message is shown below so the route does not fail silently.
          </p>
          <pre className="mt-4 overflow-auto rounded-xl border border-border/70 bg-background/45 p-4 text-xs leading-6 text-destructive">
            {this.state.error.message || "Unknown render error"}
          </pre>
        </section>
      );
    }

    return this.props.children;
  }
}

function SideNavigation({
  userEmail,
  onSignOut,
  onNavigate,
  routes,
  allTicketCount,
  activeBacklogCount,
  lastSync,
}: {
  userEmail: string;
  onSignOut: () => void;
  onNavigate: () => void;
  routes: HubRouteTab[];
  allTicketCount: number;
  activeBacklogCount: number;
  lastSync: SyncSummary | null;
}) {
  const linkClasses =
    "rounded-xl border border-transparent px-3.5 py-3 text-left transition hover:border-border/75 hover:bg-muted/45";
  const activeClasses = "border-primary/40 bg-primary/12 text-primary";

  return (
    <div className="flex h-full flex-col surface-panel p-4">
      <div className="mb-5 space-y-4">
        <BrandLockup size="sm" showOmniOne={false} accessoryLabel="Support Hub" />

        <div className="rounded-2xl border border-border/70 bg-background/45 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Workspace Snapshot</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight">{allTicketCount}</p>
          <p className="text-[12px] leading-5 text-muted-foreground">Cached tickets across both support brands.</p>
          <div className="mt-4 space-y-2 text-[12px] leading-5 text-muted-foreground">
            <p>
              Active backlog: <span className="font-medium text-foreground">{activeBacklogCount}</span>
            </p>
            <p>
              Last sync:{" "}
              <span className="font-medium text-foreground">
                {lastSync?.finishedAt ? formatDateTime(lastSync.finishedAt) : "Not available"}
              </span>
            </p>
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-2">
        {routes.map((route) => (
          <NavLink
            key={route.path}
            to={route.path}
            end={route.path === "/hub"}
            onClick={onNavigate}
            className={({ isActive }) => `${linkClasses} ${isActive ? activeClasses : "text-foreground"}`}
          >
            <span className="block text-[14px] font-medium">{route.label}</span>
            <span className="mt-1 block text-[12px] leading-5 text-muted-foreground">{route.description}</span>
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-3 rounded-xl border border-border/65 bg-background/45 p-3">
        <p className="break-all text-[12px] leading-5 text-muted-foreground">{userEmail}</p>
        <Button variant="secondary" className="w-full" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

function TicketTable({
  rows,
  loading,
  error,
  selectedIds,
  onSelectionChange,
  onSelectAllVisible,
  onOpenTicket,
  onGenerateDigest,
  generatingDigest,
}: TableProps) {
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "pending" | "new">("all");
  const [query, setQuery] = useState("");

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const normalizedStatus = row.status.toLowerCase();
      const statusMatches = statusFilter === "all"
        ? ACTIVE_TICKET_STATUSES.has(normalizedStatus)
        : normalizedStatus === statusFilter;
      const searchMatches =
        query.trim().length === 0
          ? true
          : `${row.subject} ${row.requester_name ?? ""} ${row.requester_email ?? ""}`
              .toLowerCase()
              .includes(query.trim().toLowerCase());
      return statusMatches && searchMatches;
    });
  }, [rows, statusFilter, query]);

  const statusCounts = useMemo(() => getTicketStatusCounts(rows), [rows]);
  const visibleIds = filteredRows.map((row) => row.ticket_id);
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const selectedTotalCount = selectedIds.size;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const filterOptions: Array<{ key: "all" | "open" | "pending" | "new"; label: string; count: number }> = [
    { key: "all", label: "All active", count: statusCounts.active },
    { key: "open", label: "Open", count: statusCounts.open },
    { key: "pending", label: "Pending", count: statusCounts.pending },
    { key: "new", label: "New", count: statusCounts.new },
  ];

  async function handleGenerateDigest() {
    if (selectedTotalCount > 0) {
      await onGenerateDigest({ ticketIds: Array.from(selectedIds) });
      return;
    }

    await onGenerateDigest({ ticketIds: filteredRows.map((row) => row.ticket_id) });
  }

  return (
    <div className="space-y-3">
      <div className="surface-panel-soft flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-3">
          <div className="relative max-w-full sm:max-w-[320px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search subject or requester..."
              className="h-10 w-full pl-9"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {filterOptions.map((filter) => (
              <Button
                key={filter.key}
                variant={statusFilter === filter.key ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setStatusFilter(filter.key)}
                className="gap-2"
              >
                <span className="capitalize">{filter.label}</span>
                <span className="rounded-full border border-border/70 bg-background/55 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  {filter.count}
                </span>
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-start gap-2 text-sm lg:items-end">
          <div className="text-xs text-muted-foreground">
            {selectedTotalCount > 0 ? `${selectedTotalCount} selected across both queues` : `${filteredRows.length} tickets in view`}
          </div>
          <p className="max-w-xs text-[12px] leading-5 text-muted-foreground lg:text-right">
            Generate a digest from checked tickets, or from the current filtered list when nothing is selected.
          </p>
          <Button size="sm" onClick={handleGenerateDigest} disabled={loading || generatingDigest || filteredRows.length === 0}>
            {generatingDigest ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Generate Digest
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border/65 bg-background/35 px-4 py-3 text-[12px] leading-5 text-muted-foreground">
        <span className="font-medium text-foreground">{statusCounts.active}</span> active tickets in this queue. Open{" "}
        {statusCounts.open}, pending {statusCounts.pending}, new {statusCounts.new}.
      </div>

      <div className="space-y-2 lg:hidden">
        {loading ? (
          <p className="surface-panel-soft p-4 text-sm text-muted-foreground">Loading tickets...</p>
        ) : error ? (
          <p className="surface-panel-soft p-4 text-sm text-destructive">{error}</p>
        ) : filteredRows.length === 0 ? (
          <p className="surface-panel-soft p-4 text-sm text-muted-foreground">No tickets for current filter.</p>
        ) : (
          filteredRows.map((row) => {
            const requester = row.requester_name || row.requester_email || "-";
            return (
              <article key={`mobile-${row.ticket_id}`} className="surface-panel-soft space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedIds.has(row.ticket_id)}
                      onCheckedChange={(checked) => onSelectionChange(row.ticket_id, checked === true)}
                      aria-label={`Select ticket ${row.ticket_id}`}
                    />
                    <p className="text-sm font-semibold text-foreground">#{row.ticket_id}</p>
                  </div>
                  <span
                    className={[
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.1em]",
                      statusPillClasses(row.status),
                    ].join(" ")}
                  >
                    {row.status}
                  </span>
                </div>
                <button
                  className="w-full text-left text-sm font-medium leading-6 underline decoration-muted-foreground/40 hover:decoration-foreground"
                  onClick={() => onOpenTicket(row)}
                >
                  {row.subject}
                </button>
                <div className="space-y-1 text-[12px] leading-5 text-muted-foreground">
                  <p>Requester: {requester}</p>
                  <p>Updated: {formatDateTime(row.zendesk_updated_at)}</p>
                </div>
              </article>
            );
          })
        )}
      </div>

      <div className="table-shell hidden lg:block">
        <div className="max-h-[520px] overflow-y-auto">
          <table className="w-full text-[14px] md:text-[15px]">
            <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur-sm">
              <tr>
                <th className="px-3 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={(checked) => onSelectAllVisible(visibleIds, checked === true)}
                    aria-label="Select all visible tickets"
                  />
                </th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Ticket</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Subject</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Status</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Requester</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-muted-foreground" colSpan={6}>
                    Loading tickets...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-destructive" colSpan={6}>
                    {error}
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-muted-foreground" colSpan={6}>
                    No tickets for current filter.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const requester = row.requester_name || row.requester_email || "-";
                  return (
                    <tr key={row.ticket_id} className="border-t hover:bg-muted/40">
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selectedIds.has(row.ticket_id)}
                          onCheckedChange={(checked) => onSelectionChange(row.ticket_id, checked === true)}
                          aria-label={`Select ticket ${row.ticket_id}`}
                        />
                      </td>
                      <td className="px-4 py-2 font-semibold whitespace-nowrap">#{row.ticket_id}</td>
                      <td className="px-4 py-2 min-w-[280px]">
                        <button className="text-left underline decoration-muted-foreground/40 hover:decoration-foreground leading-6" onClick={() => onOpenTicket(row)}>
                          {row.subject}
                        </button>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span
                          className={[
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.1em]",
                            statusPillClasses(row.status),
                          ].join(" ")}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">{requester}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{formatDateTime(row.zendesk_updated_at)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TicketSearchPane({
  query,
  loading,
  error,
  submittedQuery,
  results,
  selectedIds,
  onQueryChange,
  onSearch,
  onClear,
  onSelectionChange,
  onSelectAllVisible,
  onOpenTicket,
  onGenerateDigest,
  generatingDigest,
}: TicketSearchPaneProps) {
  const visibleIds = results.map((row) => row.ticket_id);
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const selectedTotalCount = selectedIds.size;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const trimmedQuery = query.trim();

  async function handleGenerateDigest() {
    if (selectedTotalCount > 0) {
      await onGenerateDigest({ ticketIds: Array.from(selectedIds) });
      return;
    }

    await onGenerateDigest({ ticketIds: visibleIds });
  }

  return (
    <section className="surface-panel space-y-4 p-5 md:p-6">
      <div className="flex flex-col gap-4 border-b border-border/55 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Cached Ticket Search</p>
            <h2 className="mt-1 font-display text-2xl tracking-tight">Search All Cached Tickets</h2>
          </div>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Searches cached subject, requester, assignee, AI summary, and ticket description fields across all brands. V1 does
            not search public replies or internal notes.
          </p>
        </div>

        <div className="text-xs text-muted-foreground lg:text-right">
          {selectedTotalCount > 0 ? `${selectedTotalCount} selected across queues and search results` : "No tickets selected"}
        </div>
      </div>

      <form
        className="surface-panel-soft flex flex-col gap-3 p-4 lg:flex-row lg:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          void onSearch();
        }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search keywords, ticket ID, requester, summary, or description"
            className="h-10 w-full pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={loading || trimmedQuery.length === 0}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Searching...
              </>
            ) : (
              <>
                <Search className="mr-2 h-4 w-4" />
                Search Cache
              </>
            )}
          </Button>
          <Button type="button" variant="outline" onClick={onClear} disabled={loading && submittedQuery.length === 0}>
            Clear
          </Button>
          <Button type="button" variant="secondary" onClick={handleGenerateDigest} disabled={loading || generatingDigest || results.length === 0}>
            {generatingDigest ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Digest Results
              </>
            )}
          </Button>
        </div>
      </form>

      <div className="rounded-xl border border-border/65 bg-background/35 px-4 py-3 text-[12px] leading-5 text-muted-foreground">
        {submittedQuery
          ? (
            <>
              Showing <span className="font-medium text-foreground">{results.length}</span> cached matches for{" "}
              <span className="font-medium text-foreground">&quot;{submittedQuery}&quot;</span>.
            </>
          )
          : "Run a search to scan the full cached ticket set instead of only the latest queue snapshot."}
      </div>

      <div className="space-y-2 lg:hidden">
        {loading ? (
          <p className="surface-panel-soft p-4 text-sm text-muted-foreground">Searching cached tickets...</p>
        ) : error ? (
          <p className="surface-panel-soft p-4 text-sm text-destructive">{error}</p>
        ) : submittedQuery.length === 0 ? (
          <p className="surface-panel-soft p-4 text-sm text-muted-foreground">No search has been run yet.</p>
        ) : results.length === 0 ? (
          <p className="surface-panel-soft p-4 text-sm text-muted-foreground">No cached tickets matched this search.</p>
        ) : (
          results.map((row) => {
            const requester = row.requester_name || row.requester_email || "-";
            return (
              <article key={`search-mobile-${row.ticket_id}`} className="surface-panel-soft space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedIds.has(row.ticket_id)}
                      onCheckedChange={(checked) => onSelectionChange(row.ticket_id, checked === true)}
                      aria-label={`Select ticket ${row.ticket_id}`}
                    />
                    <div>
                      <p className="text-sm font-semibold text-foreground">#{row.ticket_id}</p>
                      <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{row.brand}</p>
                    </div>
                  </div>
                  <span
                    className={[
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.1em]",
                      statusPillClasses(row.status),
                    ].join(" ")}
                  >
                    {row.status}
                  </span>
                </div>
                <button
                  className="w-full text-left text-sm font-medium leading-6 underline decoration-muted-foreground/40 hover:decoration-foreground"
                  onClick={() => onOpenTicket(row)}
                >
                  {row.subject}
                </button>
                {row.search_snippet && row.search_snippet !== row.subject ? (
                  <p className="text-[12px] leading-5 text-muted-foreground">{row.search_snippet}</p>
                ) : null}
                <div className="space-y-1 text-[12px] leading-5 text-muted-foreground">
                  <p>Requester: {requester}</p>
                  <p>Updated: {formatDateTime(row.zendesk_updated_at)}</p>
                </div>
              </article>
            );
          })
        )}
      </div>

      <div className="table-shell hidden lg:block">
        <div className="max-h-[520px] overflow-y-auto">
          <table className="w-full text-[14px] md:text-[15px]">
            <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur-sm">
              <tr>
                <th className="px-3 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={(checked) => onSelectAllVisible(visibleIds, checked === true)}
                    aria-label="Select all visible search results"
                  />
                </th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Ticket</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Brand</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Subject</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Status</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Requester</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-muted-foreground" colSpan={7}>
                    Searching cached tickets...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-destructive" colSpan={7}>
                    {error}
                  </td>
                </tr>
              ) : submittedQuery.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-muted-foreground" colSpan={7}>
                    No search has been run yet.
                  </td>
                </tr>
              ) : results.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-muted-foreground" colSpan={7}>
                    No cached tickets matched this search.
                  </td>
                </tr>
              ) : (
                results.map((row) => {
                  const requester = row.requester_name || row.requester_email || "-";
                  return (
                    <tr key={`search-${row.ticket_id}`} className="border-t hover:bg-muted/40">
                      <td className="px-3 py-2 align-top">
                        <Checkbox
                          checked={selectedIds.has(row.ticket_id)}
                          onCheckedChange={(checked) => onSelectionChange(row.ticket_id, checked === true)}
                          aria-label={`Select ticket ${row.ticket_id}`}
                        />
                      </td>
                      <td className="px-4 py-2 align-top font-semibold whitespace-nowrap">#{row.ticket_id}</td>
                      <td className="px-4 py-2 align-top whitespace-nowrap">{row.brand}</td>
                      <td className="px-4 py-2 align-top min-w-[360px]">
                        <button className="text-left underline decoration-muted-foreground/40 hover:decoration-foreground leading-6" onClick={() => onOpenTicket(row)}>
                          {row.subject}
                        </button>
                        {row.search_snippet && row.search_snippet !== row.subject ? (
                          <p className="mt-1 max-w-[42rem] text-xs leading-5 text-muted-foreground">{row.search_snippet}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 align-top whitespace-nowrap">
                        <span
                          className={[
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.1em]",
                            statusPillClasses(row.status),
                          ].join(" ")}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 align-top whitespace-nowrap">{requester}</td>
                      <td className="px-4 py-2 align-top whitespace-nowrap text-muted-foreground">{formatDateTime(row.zendesk_updated_at)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function TicketDrawer({
  open,
  onOpenChange,
  ticket,
  summary,
  loading,
  onRefreshSummary,
  onSendToSlack,
  onCopy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: Ticket | null;
  summary: TicketSummary | null;
  loading: boolean;
  onRefreshSummary: (refresh: boolean) => Promise<void>;
  onSendToSlack: () => Promise<void>;
  onCopy: () => Promise<void>;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto border-border/70 bg-background/98 sm:max-w-2xl">
        <SheetHeader className="space-y-1 border-b border-border/55 pb-4">
          <SheetTitle className="font-display text-2xl tracking-tight">{ticket ? `Ticket #${ticket.ticket_id}` : "Ticket"}</SheetTitle>
          <SheetDescription className="text-sm leading-6">{ticket?.subject || "No ticket selected"}</SheetDescription>
        </SheetHeader>

        {ticket ? (
          <div className="mt-6 space-y-4">
            <div className="surface-panel-soft grid gap-3 p-4 text-sm sm:grid-cols-2">
              <p><span className="text-muted-foreground">Brand:</span> {ticket.brand}</p>
              <p><span className="text-muted-foreground">Status:</span> {ticket.status}</p>
              <p><span className="text-muted-foreground">Priority:</span> {ticket.priority || "-"}</p>
              <p><span className="text-muted-foreground">Updated:</span> {formatDateTime(ticket.zendesk_updated_at)}</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void onRefreshSummary(true)} disabled={loading}>
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh Summary
              </Button>
              <Button size="sm" variant="outline" onClick={() => void onSendToSlack()}>
                <Send className="mr-2 h-4 w-4" />
                Send to Slack
              </Button>
              <Button size="sm" variant="outline" onClick={() => void onCopy()}>
                <Copy className="mr-2 h-4 w-4" />
                Copy
              </Button>
              {ticket.ticket_url ? (
                <Button size="sm" variant="ghost" asChild>
                  <a href={ticket.ticket_url} target="_blank" rel="noreferrer">Open in Zendesk</a>
                </Button>
              ) : null}
            </div>

            <div className="surface-panel-soft p-4">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.11em] text-muted-foreground">Summary</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {summary?.summary_text || ticket.summary_text || "No summary yet. Click Refresh Summary to generate one."}
              </p>

              {summary?.key_actions?.length ? (
                <div className="mt-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Troubleshooting</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {summary.key_actions.map((action, idx) => (
                      <li key={idx}>{action}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {summary?.next_steps?.length ? (
                <div className="mt-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Next Steps</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {summary.next_steps.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DigestsPane({
  digests,
  loading,
  error,
  selectedDigestId,
  onSelectDigest,
  onSendToSlack,
  onCopyMarkdown,
  onCopyTable,
}: {
  digests: Digest[];
  loading: boolean;
  error: string | null;
  selectedDigestId: string | null;
  onSelectDigest: (id: string) => void;
  onSendToSlack: (id: string) => Promise<void>;
  onCopyMarkdown: (id: string) => Promise<void>;
  onCopyTable: (id: string) => Promise<void>;
}) {
  const selected = digests.find((item) => item.id === selectedDigestId) || null;

  return (
    <section className="grid gap-5 xl:h-[calc(100vh-15rem)] xl:grid-cols-[420px_minmax(0,1fr)] 2xl:grid-cols-[500px_minmax(0,1fr)]">
      <div className="surface-panel p-5 xl:flex xl:h-full xl:min-h-0 xl:flex-col">
        <h2 className="mb-3 text-base font-semibold tracking-tight">Recent Digests</h2>
        {loading ? <p className="text-sm text-muted-foreground">Loading digests...</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!loading && !error ? (
          <div className="space-y-2 pr-1 xl:min-h-0 xl:flex-1 xl:overflow-auto">
            {digests.map((digest) => (
              <button
                key={digest.id}
                onClick={() => onSelectDigest(digest.id)}
                className={[
                  "w-full rounded-xl border border-border/70 bg-background/45 px-4 py-3 text-left text-[15px] transition",
                  selectedDigestId === digest.id
                    ? "border-primary/45 bg-primary/[0.11] shadow-[0_14px_30px_-24px_hsl(var(--primary)/0.9)]"
                    : "hover:border-primary/35 hover:bg-muted/35",
                ].join(" ")}
              >
                <p className="font-medium">{digest.title}</p>
                <p className="text-[12px] text-muted-foreground">{formatDateTime(digest.created_at)} • {digest.ticket_ids.length} tickets</p>
              </button>
            ))}
            {digests.length === 0 ? <p className="text-sm text-muted-foreground">No digests yet.</p> : null}
          </div>
        ) : null}
      </div>

      <div className="surface-panel p-5 xl:flex xl:h-full xl:min-h-0 xl:flex-col">
        {selected ? (
          <div className="space-y-4 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{selected.title}</h2>
                <p className="text-[12px] text-muted-foreground">{formatDateTime(selected.created_at)} • Source: {selected.source}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void onSendToSlack(selected.id)}>
                  <Send className="mr-2 h-4 w-4" />
                  Send to Slack
                </Button>
                <Button size="sm" variant="outline" onClick={() => void onCopyMarkdown(selected.id)}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Markdown
                </Button>
                <Button size="sm" variant="outline" onClick={() => void onCopyTable(selected.id)}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Table
                </Button>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-b from-card via-card to-muted/55 shadow-[inset_0_1px_0_rgba(15,23,42,0.05)] dark:from-[#171d12] dark:via-[#111610] dark:to-[#0c100b] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
              <div className="border-b border-primary/20 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary/90">
                Digest Result
              </div>
              <pre className="max-h-[75vh] overflow-y-auto px-5 py-5 text-[15px] md:text-[16px] leading-8 whitespace-pre-wrap font-sans text-foreground/95 xl:max-h-none xl:min-h-0 xl:flex-1">
                {selected.content_markdown}
              </pre>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Select a digest to view details.</p>
        )}
      </div>
    </section>
  );
}

function DocumentsPane({
  documentsByBrand,
  loading,
  error,
  activeBrand,
  activeTopLevelFolder,
  selectedDocumentPath,
  previewUrl,
  previewPageNumber,
  previewLoading,
  previewError,
  downloadingDocumentPath,
  semanticQuery,
  semanticSearching,
  semanticError,
  semanticResults,
  onRefresh,
  onSelectBrand,
  onSelectTopLevelFolder,
  onSelectDocument,
  onDownloadDocument,
  onSemanticQueryChange,
  onSemanticSearch,
  onClearSemanticSearch,
  onSelectSemanticResult,
}: {
  documentsByBrand: Record<DocumentBrand, SupportDocument[]>;
  loading: boolean;
  error: string | null;
  activeBrand: DocumentBrand;
  activeTopLevelFolder: string | null;
  selectedDocumentPath: string | null;
  previewUrl: string | null;
  previewPageNumber: number | null;
  previewLoading: boolean;
  previewError: string | null;
  downloadingDocumentPath: string | null;
  semanticQuery: string;
  semanticSearching: boolean;
  semanticError: string | null;
  semanticResults: SemanticSearchDocumentResult[];
  onRefresh: () => Promise<void>;
  onSelectBrand: (brand: DocumentBrand) => void;
  onSelectTopLevelFolder: (folder: string | null) => void;
  onSelectDocument: (document: SupportDocument) => void;
  onDownloadDocument: (document: SupportDocument) => Promise<void>;
  onSemanticQueryChange: (value: string) => void;
  onSemanticSearch: () => Promise<void>;
  onClearSemanticSearch: () => void;
  onSelectSemanticResult: (result: SemanticSearchDocumentResult) => void;
}) {
  const brandMeta: Record<DocumentBrand, { label: string; logo: string }> = {
    omni_one: { label: "Omni One", logo: omniOneLogo },
    omni_arena: { label: "Omni Arena", logo: omniArenaLogo },
  };

  const allDocuments = useMemo(
    () => flattenDocumentsByBrand(documentsByBrand),
    [documentsByBrand],
  );
  const activeDocuments = useMemo(
    () => documentsByBrand[activeBrand] || [],
    [activeBrand, documentsByBrand],
  );
  const activeFolderOptions = useMemo(
    () => getFolderOptionsForBrand(activeDocuments, activeBrand),
    [activeBrand, activeDocuments],
  );
  const filteredDocuments = useMemo(
    () => filterDocumentsByFolder(activeDocuments, activeBrand, activeTopLevelFolder),
    [activeBrand, activeDocuments, activeTopLevelFolder],
  );
  const selectedDocument = allDocuments.find((document) => document.path === selectedDocumentPath) || null;
  const activeFolderLabel = activeTopLevelFolder || "All folders";
  const previewUrlWithPage = previewUrl && previewPageNumber ? `${previewUrl}#page=${previewPageNumber}` : previewUrl;

  return (
    <section className="grid gap-5 xl:h-[calc(100vh-15rem)] xl:grid-cols-[430px_minmax(0,1fr)] 2xl:grid-cols-[520px_minmax(0,1fr)]">
      <div className="surface-panel p-5 xl:flex xl:h-full xl:min-h-0 xl:flex-col">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold tracking-tight">Documents</h2>
          <Button size="sm" variant="outline" onClick={() => void onRefresh()} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border/70 bg-card/68 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">PDF Library</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{allDocuments.length}</p>
            <p className="text-[12px] leading-5 text-muted-foreground">Documents currently available in the library.</p>
          </div>
          <div className="rounded-xl border border-border/70 bg-card/68 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Current Scope</p>
            <p className="mt-1 text-lg font-semibold tracking-tight">{activeFolderLabel}</p>
            <p className="text-[12px] leading-5 text-muted-foreground">{filteredDocuments.length} docs in current view.</p>
          </div>
          <div className="rounded-xl border border-border/70 bg-card/68 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Search Matches</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{semanticResults.length}</p>
            <p className="text-[12px] leading-5 text-muted-foreground">
              {semanticQuery.trim() ? `Current query: ${semanticQuery.trim()}` : "Run semantic search in the active scope."}
            </p>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {SUPPORT_DOCUMENTS_BRANDS.map((brand) => (
            <Button
              key={brand}
              size="sm"
              variant={activeBrand === brand ? "secondary" : "ghost"}
              className="h-11 gap-2.5 rounded-full px-3"
              onClick={() => onSelectBrand(brand)}
              aria-label={brandMeta[brand].label}
              title={brandMeta[brand].label}
            >
              <span className={`brand-logo-shell shrink-0 ${brand === "omni_arena" ? "h-7 min-w-[76px] px-2.5" : "h-7 min-w-[68px] px-2.5"}`}>
                <img
                  src={brandMeta[brand].logo}
                  alt={brandMeta[brand].label}
                  className={`w-auto shrink-0 object-contain ${brand === "omni_arena" ? "h-[14px]" : "h-4"}`}
                />
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em]">
                {brandMeta[brand].label}
              </span>
              <span className="rounded-full border border-border/70 bg-card/75 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                {(documentsByBrand[brand] || []).length}
              </span>
            </Button>
          ))}
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={activeTopLevelFolder === null ? "secondary" : "ghost"}
            className="h-8"
            onClick={() => onSelectTopLevelFolder(null)}
          >
            All folders
          </Button>
          {activeFolderOptions.map((folder) => (
            <Button
              key={folder}
              size="sm"
              variant={activeTopLevelFolder === folder ? "secondary" : "ghost"}
              className="h-8"
              onClick={() => onSelectTopLevelFolder(folder)}
            >
              {folder}
            </Button>
          ))}
        </div>

        <p className="mb-3 text-[12px] text-muted-foreground">
          Bucket: <span className="font-medium text-foreground">{SUPPORT_DOCUMENTS_BUCKET}</span> • Expected folders:
          {" "}omni_one, omni_arena
        </p>

        <form
          className="mb-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSemanticSearch();
          }}
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={semanticQuery}
              onChange={(event) => onSemanticQueryChange(event.target.value)}
              placeholder="Semantic search in current brand/folder"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="h-10 shrink-0 sm:w-auto"
              disabled={semanticSearching || semanticQuery.trim().length === 0}
            >
              {semanticSearching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
              Search
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-muted-foreground">Searches indexed chunks for this selected scope.</p>
            {(semanticResults.length > 0 || semanticError) && !semanticSearching ? (
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={onClearSemanticSearch}>
                Clear
              </Button>
            ) : null}
          </div>
          {semanticError ? <p className="text-[12px] text-destructive">{semanticError}</p> : null}
        </form>

        {semanticResults.length > 0 ? (
          <div className="surface-panel-soft mb-3 space-y-2 p-2">
            <p className="px-1 text-[12px] font-medium text-muted-foreground">{semanticResults.length} semantic matches</p>
            <div className="max-h-52 space-y-2 overflow-auto pr-1">
              {semanticResults.map((result) => (
                <button
                  key={result.chunk_id}
                  className="w-full rounded-lg border border-border/70 bg-card/72 px-3 py-3 text-left transition hover:border-primary/35 hover:bg-muted/35"
                  onClick={() => onSelectSemanticResult(result)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[12px] font-semibold">{result.file_name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Page {result.page_number ?? "-"} • {(result.similarity * 100).toFixed(1)}%
                    </p>
                  </div>
                  <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{result.snippet}</p>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-2 pr-1 xl:min-h-0 xl:flex-1 xl:overflow-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading documents...</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : filteredDocuments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {activeTopLevelFolder
                ? `No PDF documents found in ${activeTopLevelFolder}.`
                : `No PDF documents found for ${brandMeta[activeBrand].label}.`}
            </p>
          ) : (
            filteredDocuments.map((document) => (
              <button
                key={document.path}
                className={[
                  "w-full rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-left transition",
                  selectedDocumentPath === document.path
                    ? "border-primary/45 bg-primary/[0.11] shadow-[0_14px_30px_-24px_hsl(var(--primary)/0.9)]"
                    : "hover:border-primary/35 hover:bg-muted/35",
                ].join(" ")}
                onClick={() => onSelectDocument(document)}
              >
                <div className="flex items-start gap-2">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <p className="truncate text-[14px] md:text-[15px] font-semibold">{document.name}</p>
                    <p className="text-[12px] text-muted-foreground">
                      Updated {formatDateTime(document.updatedAt)} • {formatFileSize(document.sizeBytes)}
                    </p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="surface-panel p-5 xl:flex xl:h-full xl:min-h-0 xl:flex-col">
        {selectedDocument ? (
          <div className="space-y-4 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-xl font-semibold tracking-tight">{selectedDocument.name}</h2>
                <p className="text-[12px] text-muted-foreground">Path: {selectedDocument.path}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void onDownloadDocument(selectedDocument)}
                  disabled={downloadingDocumentPath === selectedDocument.path}
                >
                  {downloadingDocumentPath === selectedDocument.path ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  Download
                </Button>
                {previewUrlWithPage ? (
                  <Button size="sm" variant="outline" asChild>
                    <a href={previewUrlWithPage} target="_blank" rel="noreferrer">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Open PDF
                    </a>
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="table-shell relative min-h-[52vh] overflow-hidden xl:min-h-0 xl:flex-1">
              {previewLoading ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading preview...
                </div>
              ) : null}

              {!previewLoading && previewError ? (
                <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
                  {previewError}
                </div>
              ) : null}

              {!previewLoading && !previewError && previewUrlWithPage ? (
                <iframe
                  key={previewUrlWithPage}
                  src={previewUrlWithPage}
                  title={`Preview ${selectedDocument.name}`}
                  className="h-[52vh] w-full xl:h-full"
                />
              ) : null}

              {!previewLoading && !previewError && !previewUrl ? (
                <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                  Preview unavailable for this file.
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
            Select a PDF document to preview it.
          </div>
        )}
      </div>
    </section>
  );
}

function ReportsPane({
  rows,
  previousRows,
  receivedRollupRows,
  receivedRollupLoading,
  receivedRollupError,
  omniOneTickets,
  omniArenaTickets,
  loading,
  error,
  weekStartDate,
  onWeekStartDateChange,
  onRefresh,
  onRefreshReceivedRollup,
  onCopySummary,
  dispatchPreview,
  dispatchLoading,
  onPreviewDispatch,
  onSendDispatch,
  onClearDispatchPreview,
}: {
  rows: WeeklyTicketReportRow[];
  previousRows: WeeklyTicketReportRow[];
  receivedRollupRows: TicketReceivedRollupRow[];
  receivedRollupLoading: boolean;
  receivedRollupError: string | null;
  omniOneTickets: Ticket[];
  omniArenaTickets: Ticket[];
  loading: boolean;
  error: string | null;
  weekStartDate: string;
  onWeekStartDateChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onRefreshReceivedRollup: () => Promise<void>;
  onCopySummary: () => Promise<void>;
  dispatchPreview: string | null;
  dispatchLoading: boolean;
  onPreviewDispatch: () => Promise<void>;
  onSendDispatch: () => Promise<void>;
  onClearDispatchPreview: () => void;
}) {
  const labels: Record<string, string> = {
    total: "Total",
    omni_one: "Omni One",
    omni_arena: "Omni Arena",
    other: "Other Brands",
  };

  const sortedRows = useMemo(() => {
    const order: Record<string, number> = { total: 0, omni_one: 1, omni_arena: 2, other: 3 };
    return [...rows].sort((a, b) => (order[a.brand] ?? 99) - (order[b.brand] ?? 99));
  }, [rows]);

  const previousRowsByBrand = useMemo(() => {
    return new Map(previousRows.map((row) => [row.brand, row]));
  }, [previousRows]);

  const totalRow = sortedRows.find((row) => row.brand === "total") ?? null;
  const previousTotalRow = previousRowsByBrand.get("total") ?? null;
  const periodLabel = totalRow
    ? `${formatDateShort(totalRow.period_start_date)} - ${formatDateShort(totalRow.period_end_date)}`
    : null;
  const previousPeriodLabel = previousTotalRow
    ? `${formatDateShort(previousTotalRow.period_start_date)} - ${formatDateShort(previousTotalRow.period_end_date)}`
    : null;

  const summaryRows = useMemo(() => {
    const order = ["total", "omni_one", "omni_arena"];

    return order
      .map((brand) => {
        const current = sortedRows.find((row) => row.brand === brand) || null;
        if (!current) return null;

        const previous = previousRowsByBrand.get(brand) || null;
        return {
          brand,
          current,
          previous,
          delta: previous ? current.received_count - previous.received_count : null,
        };
      })
      .filter((row): row is {
        brand: string;
        current: WeeklyTicketReportRow;
        previous: WeeklyTicketReportRow | null;
        delta: number | null;
      } => row !== null);
  }, [sortedRows, previousRowsByBrand]);

  const periodLabels: Record<string, string> = {
    month: "Monthly",
    quarter: "Quarterly",
    year: "Yearly",
  };
  const orderedPeriods = ["month", "quarter", "year"];
  const orderedRollupBrands = ["total", "omni_one", "omni_arena"];
  const receivedRollupMap = useMemo(() => {
    return new Map(receivedRollupRows.map((row) => [`${row.period_type}:${row.brand}`, row]));
  }, [receivedRollupRows]);
  const receivedRollupTotals = useMemo(() => {
    return orderedPeriods
      .map((period) => receivedRollupMap.get(`${period}:total`) || null)
      .filter((row): row is TicketReceivedRollupRow => row !== null);
  }, [receivedRollupMap]);

  const omniOneOpenPendingTickets = useMemo(() => getOpenPendingTickets(omniOneTickets), [omniOneTickets]);
  const omniArenaOpenPendingTickets = useMemo(() => getOpenPendingTickets(omniArenaTickets), [omniArenaTickets]);
  const omniOneBacklogCounts = useMemo(
    () => getOpenPendingStatusCounts(omniOneOpenPendingTickets),
    [omniOneOpenPendingTickets],
  );
  const omniArenaBacklogCounts = useMemo(
    () => getOpenPendingStatusCounts(omniArenaOpenPendingTickets),
    [omniArenaOpenPendingTickets],
  );
  const totalBacklogCount = omniOneBacklogCounts.total + omniArenaBacklogCounts.total;

  const omniOneTopThemes = useMemo(() => getTopTicketThemes(omniOneOpenPendingTickets, 3), [omniOneOpenPendingTickets]);
  const omniArenaTopThemes = useMemo(() => getTopTicketThemes(omniArenaOpenPendingTickets, 3), [omniArenaOpenPendingTickets]);
  const omniArenaTopCallers = useMemo(() => getTopTicketRequesters(omniArenaOpenPendingTickets, 5), [omniArenaOpenPendingTickets]);

  return (
    <section className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[380px_minmax(0,1fr)]">
      <div className="surface-panel space-y-4 p-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">High-Impact Ticket Report</h2>
          <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
            Simplified for weekly execution: intake trend, active backlog, top issues, and top caller activity.
          </p>
        </div>

        <div className="surface-panel-soft space-y-2 p-3">
          <label htmlFor="week-start" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Week Start Date
          </label>
          <div className="relative">
            <Input
              id="week-start"
              type="date"
              value={weekStartDate}
              onChange={(event) => onWeekStartDateChange(event.target.value)}
              className="report-date-input pr-10"
            />
            <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary/85" />
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={() => void onRefresh()} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh Report
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void onRefreshReceivedRollup()}
            disabled={receivedRollupLoading}
          >
            {receivedRollupLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh M/Q/Y View
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => void onCopySummary()}
            disabled={loading || sortedRows.length === 0}
          >
            <Copy className="mr-2 h-4 w-4" />
            Copy Report Summary
          </Button>
        </div>

        <div className="surface-panel-soft space-y-2 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Weekly Dispatch Test</p>
          <Button variant="outline" size="sm" className="w-full" onClick={() => void onPreviewDispatch()} disabled={dispatchLoading}>
            {dispatchLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            Preview Slack Format
          </Button>
          <Button variant="secondary" size="sm" className="w-full" onClick={() => void onSendDispatch()} disabled={dispatchLoading}>
            {dispatchLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Send Test to Slack + Email
          </Button>
          <p className="text-[12px] leading-5 text-muted-foreground">
            Preview does not send anything. Send Test runs the full dispatch immediately.
          </p>
          {dispatchPreview ? (
            <>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-border/65 bg-background/55 p-2">
                <pre className="whitespace-pre-wrap text-[12px] leading-5 text-foreground">{dispatchPreview}</pre>
              </div>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={onClearDispatchPreview}>
                Clear Preview
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="surface-panel space-y-4 p-5">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading weekly report...</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <>
            <div className="surface-panel-soft p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Report Window</p>
              <p className="mt-1 text-[15px] font-medium">{periodLabel || "-"}</p>
              {previousPeriodLabel ? (
                <p className="mt-1 text-[12px] text-muted-foreground">Compared against: {previousPeriodLabel}</p>
              ) : null}
              {totalRow ? (
                <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
                  Weekly intake snapshot: {totalRow.received_count} tickets received across all brands.
                </p>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {summaryRows.map(({ brand, current, previous, delta }) => (
                <article
                  key={`summary-card-${brand}`}
                  className={[
                    "rounded-xl border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_34px_-24px_hsl(var(--primary)/0.92)]",
                    brand === "total"
                      ? "border-primary/45 bg-primary/[0.12] hover:border-primary/70"
                      : "border-border/65 bg-background/55 hover:border-primary/55 hover:bg-background/65",
                  ].join(" ")}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {labels[brand] ?? brand}
                  </p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight">{current.received_count}</p>
                  <p className="text-[12px] text-muted-foreground">Tickets received</p>
                  <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                    WoW: {delta === null ? "n/a" : formatSignedIntDelta(delta)}
                    {previous ? ` (Prev ${previous.received_count})` : ""}
                  </p>
                </article>
              ))}
            </div>

            <article className="surface-panel-soft space-y-3 p-4">
              <div>
                <h3 className="text-lg font-semibold tracking-tight">Monthly / Quarterly / Yearly Intake</h3>
                <p className="text-[12px] leading-5 text-muted-foreground">
                  Snapshot by current reference date, with previous-period comparison.
                </p>
              </div>

              {receivedRollupLoading ? (
                <p className="text-[13px] text-muted-foreground">Loading intake view...</p>
              ) : receivedRollupError ? (
                <p className="text-[13px] text-destructive">{receivedRollupError}</p>
              ) : receivedRollupTotals.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No monthly/quarterly/yearly data available yet.</p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {receivedRollupTotals.map((row) => (
                      <div
                        key={`rollup-total-${row.period_type}`}
                        className="rounded-lg border border-border/65 bg-background/55 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/55 hover:bg-background/65 hover:shadow-[0_14px_30px_-24px_hsl(var(--primary)/0.9)]"
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          {periodLabels[row.period_type] ?? row.period_type}
                        </p>
                        <p className="mt-1 text-2xl font-semibold tracking-tight">{row.received_count}</p>
                        <p className="text-[12px] text-muted-foreground">
                          Prev {row.previous_received_count} ({formatSignedIntDelta(row.delta)} / {formatSignedPercentDelta(row.delta_pct)})
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="table-shell">
                    <table className="w-full text-[13px] md:text-[14px]">
                      <thead className="bg-muted/55">
                        <tr>
                          <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Brand</th>
                          {orderedPeriods.map((period) => (
                            <th key={`rollup-period-${period}`} className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                              {periodLabels[period] ?? period}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {orderedRollupBrands.map((brand) => (
                          <tr key={`rollup-brand-row-${brand}`} className="border-t border-border/35">
                            <td className="px-3 py-2 font-medium">{labels[brand] ?? brand}</td>
                            {orderedPeriods.map((period) => {
                              const row = receivedRollupMap.get(`${period}:${brand}`) || null;
                              return (
                                <td key={`rollup-brand-cell-${brand}-${period}`} className="px-3 py-2 align-top">
                                  {row ? (
                                    <div className="leading-5">
                                      <p className="font-medium">{row.received_count}</p>
                                      <p className="text-[11px] text-muted-foreground">
                                        {formatSignedIntDelta(row.delta)} / {formatSignedPercentDelta(row.delta_pct)}
                                      </p>
                                    </div>
                                  ) : (
                                    <p className="text-muted-foreground">-</p>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </article>

            <div className="grid items-stretch gap-4 xl:grid-cols-2">
              <article className="surface-panel-soft h-full space-y-3 p-4">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">Currently Open Tickets</h3>
                  <p className="text-[12px] leading-5 text-muted-foreground">Open + Pending queue only.</p>
                </div>
                <p className="text-2xl font-semibold tracking-tight">{totalBacklogCount}</p>
                <p className="text-[12px] text-muted-foreground">Total active tickets across both queues.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-border/65 bg-background/55 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/55 hover:bg-background/65 hover:shadow-[0_14px_30px_-24px_hsl(var(--primary)/0.9)]">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Omni One</p>
                    <p className="mt-1 text-xl font-semibold">{omniOneBacklogCounts.total}</p>
                    <p className="text-[12px] text-muted-foreground">
                      Open {omniOneBacklogCounts.open} • Pending {omniOneBacklogCounts.pending}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/65 bg-background/55 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/55 hover:bg-background/65 hover:shadow-[0_14px_30px_-24px_hsl(var(--primary)/0.9)]">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Omni Arena</p>
                    <p className="mt-1 text-xl font-semibold">{omniArenaBacklogCounts.total}</p>
                    <p className="text-[12px] text-muted-foreground">
                      Open {omniArenaBacklogCounts.open} • Pending {omniArenaBacklogCounts.pending}
                    </p>
                  </div>
                </div>
              </article>

              <article className="surface-panel-soft h-full space-y-3 p-4">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">Top Issue Themes</h3>
                  <p className="text-[12px] leading-5 text-muted-foreground">Top 3 from active queue subjects.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 sm:auto-rows-fr">
                  <div className="h-full rounded-lg border border-border/65 bg-background/55 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Omni One</p>
                    {omniOneTopThemes.length === 0 ? (
                      <p className="mt-2 text-[13px] text-muted-foreground">No active tickets.</p>
                    ) : (
                      <ol className="mt-2 space-y-1.5">
                        {omniOneTopThemes.map((entry) => (
                          <li key={`omni-one-theme-${entry.label}`} className="text-[13px] leading-5">
                            <span className="font-medium">{entry.label}</span>
                            <span className="text-muted-foreground"> ({entry.count})</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  <div className="h-full rounded-lg border border-border/65 bg-background/55 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Omni Arena</p>
                    {omniArenaTopThemes.length === 0 ? (
                      <p className="mt-2 text-[13px] text-muted-foreground">No active tickets.</p>
                    ) : (
                      <ol className="mt-2 space-y-1.5">
                        {omniArenaTopThemes.map((entry) => (
                          <li key={`omni-arena-theme-${entry.label}`} className="text-[13px] leading-5">
                            <span className="font-medium">{entry.label}</span>
                            <span className="text-muted-foreground"> ({entry.count})</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              </article>
            </div>

            <article className="surface-panel-soft space-y-3 p-4">
              <div>
                <h3 className="text-lg font-semibold tracking-tight">Top Arena Callers / Venues</h3>
                <p className="text-[12px] leading-5 text-muted-foreground">
                  Top requesters in the current open + pending arena queue.
                </p>
              </div>

              {omniArenaTopCallers.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No active arena tickets.</p>
              ) : (
                <ol className="grid gap-2 sm:grid-cols-2">
                  {omniArenaTopCallers.map((entry, index) => (
                    <li
                      key={`oa-caller-${entry.label}`}
                      className={[
                        "rounded-lg border border-border/65 bg-background/55 px-3 py-2 text-[13px]",
                        "transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/55 hover:bg-background/65 hover:shadow-[0_14px_30px_-24px_hsl(var(--primary)/0.9)]",
                        omniArenaTopCallers.length % 2 === 1 && index === omniArenaTopCallers.length - 1 ? "sm:col-span-2" : "",
                      ].join(" ")}
                    >
                      <span className="font-medium">{index + 1}. {entry.label}</span>
                      <span className="text-muted-foreground"> ({entry.count})</span>
                    </li>
                  ))}
                </ol>
              )}

              <p className="text-[11px] text-muted-foreground">
                Queue metrics are based on the current cached ticket set in Hub.
              </p>
            </article>
          </>
        )}
      </div>
    </section>
  );
}

export default function Hub() {
  const { toast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();

  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);

  const [sites, setSites] = useState<ArenaSite[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesError, setSitesError] = useState<string | null>(null);

  const [omniOneTickets, setOmniOneTickets] = useState<Ticket[]>([]);
  const [omniArenaTickets, setOmniArenaTickets] = useState<Ticket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsError, setTicketsError] = useState<string | null>(null);
  const [ticketSearchQuery, setTicketSearchQuery] = useState("");
  const [ticketSearchSubmittedQuery, setTicketSearchSubmittedQuery] = useState("");
  const [ticketSearchResults, setTicketSearchResults] = useState<TicketSearchResult[]>([]);
  const [ticketSearchLoading, setTicketSearchLoading] = useState(false);
  const [ticketSearchError, setTicketSearchError] = useState<string | null>(null);
  const [summaryMap, setSummaryMap] = useState<Record<number, TicketSummary>>({});
  const [summaryLoadingTicketId, setSummaryLoadingTicketId] = useState<number | null>(null);

  const [selectedTicketIds, setSelectedTicketIds] = useState<Set<number>>(new Set());
  const [activeTicket, setActiveTicket] = useState<Ticket | null>(null);
  const [ticketDrawerOpen, setTicketDrawerOpen] = useState(false);

  const [digests, setDigests] = useState<Digest[]>([]);
  const [digestsLoading, setDigestsLoading] = useState(false);
  const [digestsError, setDigestsError] = useState<string | null>(null);
  const [selectedDigestId, setSelectedDigestId] = useState<string | null>(null);

  const [documentsByBrand, setDocumentsByBrand] = useState<Record<DocumentBrand, SupportDocument[]>>({
    omni_one: [],
    omni_arena: [],
  });
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [documentsPreviewError, setDocumentsPreviewError] = useState<string | null>(null);
  const [activeDocumentsBrand, setActiveDocumentsBrand] = useState<DocumentBrand>("omni_one");
  const [documentsFolderByBrand, setDocumentsFolderByBrand] = useState<Record<DocumentBrand, string | null>>({
    omni_one: null,
    omni_arena: null,
  });
  const [selectedDocumentPath, setSelectedDocumentPath] = useState<string | null>(null);
  const [selectedDocumentPreviewUrl, setSelectedDocumentPreviewUrl] = useState<string | null>(null);
  const [selectedDocumentPreviewPageNumber, setSelectedDocumentPreviewPageNumber] = useState<number | null>(null);
  const [documentsPreviewLoading, setDocumentsPreviewLoading] = useState(false);
  const [downloadLoadingPath, setDownloadLoadingPath] = useState<string | null>(null);
  const [documentsSemanticQuery, setDocumentsSemanticQuery] = useState("");
  const [documentsSemanticSearching, setDocumentsSemanticSearching] = useState(false);
  const [documentsSemanticError, setDocumentsSemanticError] = useState<string | null>(null);
  const [documentsSemanticResults, setDocumentsSemanticResults] = useState<SemanticSearchDocumentResult[]>([]);

  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [weeklyReportRows, setWeeklyReportRows] = useState<WeeklyTicketReportRow[]>([]);
  const [weeklyReportPreviousRows, setWeeklyReportPreviousRows] = useState<WeeklyTicketReportRow[]>([]);
  const [weeklyReportLoading, setWeeklyReportLoading] = useState(false);
  const [weeklyReportError, setWeeklyReportError] = useState<string | null>(null);
  const [weeklyReportStartDate, setWeeklyReportStartDate] = useState(getCurrentWeekStartDateISO);
  const [receivedRollupRows, setReceivedRollupRows] = useState<TicketReceivedRollupRow[]>([]);
  const [receivedRollupLoading, setReceivedRollupLoading] = useState(false);
  const [receivedRollupError, setReceivedRollupError] = useState<string | null>(null);
  const [weeklyDispatchLoading, setWeeklyDispatchLoading] = useState(false);
  const [weeklyDispatchPreview, setWeeklyDispatchPreview] = useState<string | null>(null);

  const [generatingDigest, setGeneratingDigest] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const inDigestRoute = location.pathname === "/hub/digests";
  const inDocumentsRoute = location.pathname === "/hub/documents";
  const inReportsRoute = location.pathname === "/hub/reports";
  const inVideosRoute = location.pathname === "/hub/videos";
  const inTicketRoute = !inDigestRoute && !inDocumentsRoute && !inReportsRoute && !inVideosRoute;
  const currentView: HubViewKey = inDigestRoute
    ? "digests"
    : inDocumentsRoute
      ? "documents"
      : inReportsRoute
        ? "reports"
        : inVideosRoute
          ? "videos"
          : "tickets";

  async function invokeFunctionRobust<T>(name: string, body: Record<string, unknown>): Promise<T> {
    try {
      const auth = await getSessionAccessTokenContext(false);
      return await invokeFunctionWithAccessTokenFallback<T>(name, body, auth.token);
    } catch (primaryError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : "Unknown function error.";
      if (!isAuthTokenErrorMessage(primaryMessage)) {
        throw primaryError instanceof Error ? primaryError : new Error(primaryMessage);
      }

      try {
        const retryAuth = await getSessionAccessTokenContext(true);
        return await invokeFunctionWithAccessTokenFallback<T>(name, body, retryAuth.token);
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : "Unknown retry error.";
        throw new Error(`${primaryMessage} | Retry failed: ${retryMessage}`);
      }
    }
  }

  async function trackHubEvent(eventName: string, metadata: Record<string, unknown> = {}) {
    if (!authorized) return;
    try {
      const payload: HubAnalyticsTrackResponse = await invokeFunctionRobust<HubAnalyticsTrackResponse>("hub_analytics", {
        event_name: eventName,
        route: location.pathname,
        metadata,
      });
      if (!payload.ok) {
        console.warn(`Hub analytics event rejected: ${payload.error || "unknown_error"}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown analytics track error.";
      console.warn("Hub analytics tracking failed", message);
    }
  }

  async function runTicketCacheSearch(queryValue = ticketSearchQuery) {
    const trimmed = queryValue.trim();
    if (!trimmed) {
      setTicketSearchLoading(false);
      setTicketSearchError("Enter a search query.");
      setTicketSearchSubmittedQuery("");
      setTicketSearchResults([]);
      return;
    }

    setTicketSearchLoading(true);
    setTicketSearchError(null);
    setTicketSearchSubmittedQuery(trimmed);

    const { data, error } = await supabase.rpc("search_ticket_cache", {
      search_query: trimmed,
      match_limit: 50,
      match_offset: 0,
    });

    if (error) {
      const message = `Cached ticket search failed: ${error.message}`;
      setTicketSearchError(message);
      setTicketSearchResults([]);
      setTicketSearchLoading(false);
      return;
    }

    const nextResults: TicketSearchResult[] = (data || []).map((row) => ({
      ticket_id: row.ticket_id,
      brand: row.brand,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      requester_email: row.requester_email,
      requester_name: row.requester_name,
      assignee_email: row.assignee_email,
      zendesk_updated_at: row.zendesk_updated_at,
      ticket_url: row.ticket_url,
      summary_text: row.summary_text,
      search_snippet: row.search_snippet,
      match_score: typeof row.match_score === "number" ? row.match_score : 0,
    }));

    setTicketSearchResults(nextResults);
    setTicketSearchLoading(false);
    void trackHubEvent("ticket_cache_search_submitted", {
      query_length: trimmed.length,
      result_count: nextResults.length,
    });
  }

  function handleClearTicketSearch() {
    setTicketSearchQuery("");
    setTicketSearchSubmittedQuery("");
    setTicketSearchResults([]);
    setTicketSearchError(null);
    setTicketSearchLoading(false);
  }

  async function listPdfDocumentsForBrand(brand: DocumentBrand): Promise<SupportDocument[]> {
    const collectedByPath = new Map<string, SupportDocument>();
    const queue: string[] = [brand, `${brand}/`, `${brand}//`];
    const queuedFolders = new Set(queue);
    const visitedFolders = new Set<string>();

    function enqueueFolder(rawPath: string) {
      const nextFolder = trimLeadingSlashes(rawPath);
      if (nextFolder.length === 0) return;
      if (queuedFolders.has(nextFolder) || visitedFolders.has(nextFolder)) return;
      queue.push(nextFolder);
      queuedFolders.add(nextFolder);
    }

    while (queue.length > 0) {
      const folder = queue.shift();
      if (!folder) continue;
      queuedFolders.delete(folder);

      if (visitedFolders.has(folder)) {
        continue;
      }
      visitedFolders.add(folder);
      if (visitedFolders.size > 5000) {
        throw new Error(`Stopped document listing for ${brand}: too many folder entries.`);
      }

      let offset = 0;
      let done = false;
      let pageCount = 0;
      while (!done) {
        const { data, error } = await supabase.storage.from(SUPPORT_DOCUMENTS_BUCKET).list(folder, {
          limit: 100,
          offset,
          sortBy: { column: "name", order: "asc" },
        });

        if (error) {
          throw new Error(`Failed to list documents for ${brand}: ${error.message}`);
        }

        const page = data || [];
        for (const item of page) {
          const rawName = item.name || "";
          const lowerName = rawName.toLowerCase();
          const isPdf = lowerName.endsWith(".pdf");
          const metadata = asRecord(item.metadata);
          const sizeBytes = toOptionalNumber(metadata?.size);
          const isKnownFile =
            !!item.id ||
            sizeBytes !== null ||
            normalizeOptionalString(item.updated_at) !== null ||
            normalizeOptionalString(item.created_at) !== null;
          const looksLikeFolder =
            !isPdf &&
            (rawName.trim().length === 0 || (!isKnownFile && !rawName.includes(".")));

          if (looksLikeFolder) {
            const childFolder = resolveStorageItemPath(folder, rawName, brand);
            enqueueFolder(childFolder);

            // Some legacy uploads contain an empty path segment (e.g. "omni_arena//file.pdf").
            // Probe deeper slashed prefixes so those objects are still discoverable.
            if (rawName.trim().length === 0) {
              enqueueFolder(`${folder}/`);
              enqueueFolder(`${folder}//`);
            }
            continue;
          }

          if (!isPdf) {
            continue;
          }

          const itemPath = resolveStorageItemPath(folder, rawName, brand);
          const normalizedPath = normalizeStoragePath(itemPath);
          if (!normalizedPath.startsWith(`${brand}/`)) {
            continue;
          }

          const updatedAt = firstNonEmptyString(
            normalizeOptionalString(item.updated_at),
            normalizeOptionalString(item.created_at),
            normalizeOptionalString(item.last_accessed_at),
          );

          if (!collectedByPath.has(normalizedPath)) {
            collectedByPath.set(normalizedPath, {
              brand,
              path: normalizedPath,
              name: rawName,
              updatedAt,
              sizeBytes,
            });
          }
        }

        if (page.length < 100) {
          done = true;
        } else {
          offset += 100;
          pageCount += 1;
          if (pageCount > 1000) {
            throw new Error(`Too many pages while listing ${brand} documents.`);
          }
        }
      }
    }

    return Array.from(collectedByPath.values()).sort((a, b) => {
      const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (updatedA !== updatedB) {
        return updatedB - updatedA;
      }
      return a.name.localeCompare(b.name);
    });
  }

  async function refreshDocuments() {
    setDocumentsLoading(true);
    setDocumentsError(null);

    try {
      const [omniOneDocs, omniArenaDocs] = await Promise.all([
        listPdfDocumentsForBrand("omni_one"),
        listPdfDocumentsForBrand("omni_arena"),
      ]);

      const nextDocumentsByBrand: Record<DocumentBrand, SupportDocument[]> = {
        omni_one: omniOneDocs,
        omni_arena: omniArenaDocs,
      };
      setDocumentsByBrand(nextDocumentsByBrand);

      const nextFolderByBrand: Record<DocumentBrand, string | null> = {
        omni_one: documentsFolderByBrand.omni_one,
        omni_arena: documentsFolderByBrand.omni_arena,
      };
      SUPPORT_DOCUMENTS_BRANDS.forEach((brand) => {
        const availableFolders = getFolderOptionsForBrand(nextDocumentsByBrand[brand], brand);
        const currentFolder = nextFolderByBrand[brand];
        if (currentFolder && !availableFolders.includes(currentFolder)) {
          nextFolderByBrand[brand] = null;
        }
      });
      setDocumentsFolderByBrand(nextFolderByBrand);

      const allDocumentPaths = new Set(
        [...omniOneDocs, ...omniArenaDocs].map((document) => document.path),
      );
      setSelectedDocumentPath((current) => {
        if (current && allDocumentPaths.has(current)) {
          return current;
        }

        const preferredPath = getFirstDocumentPath(
          nextDocumentsByBrand,
          activeDocumentsBrand,
          nextFolderByBrand[activeDocumentsBrand],
        );
        if (preferredPath) {
          return preferredPath;
        }

        return (
          getFirstDocumentPath(nextDocumentsByBrand, "omni_one", nextFolderByBrand.omni_one) ||
          getFirstDocumentPath(nextDocumentsByBrand, "omni_arena", nextFolderByBrand.omni_arena) ||
          null
        );
      });

      setActiveDocumentsBrand((current) => {
        if (current === "omni_one" && omniOneDocs.length > 0) return current;
        if (current === "omni_arena" && omniArenaDocs.length > 0) return current;
        if (omniOneDocs.length > 0) return "omni_one";
        if (omniArenaDocs.length > 0) return "omni_arena";
        return current;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load documents.";
      setDocumentsError(message);
    } finally {
      setDocumentsLoading(false);
    }
  }

  async function refreshWeeklyReport() {
    setWeeklyReportLoading(true);
    setWeeklyReportError(null);

    try {
      const selectedStartDate = weeklyReportStartDate || getCurrentWeekStartDateISO();
      const previousStartDate = shiftIsoDate(selectedStartDate, -7);

      const [currentResult, previousResult] = await Promise.all([
        supabase.rpc("get_weekly_ticket_report", {
          period_start: selectedStartDate,
          period_days: 7,
        }),
        supabase.rpc("get_weekly_ticket_report", {
          period_start: previousStartDate,
          period_days: 7,
        }),
      ]);

      if (currentResult.error) {
        throw new Error(currentResult.error.message);
      }
      if (previousResult.error) {
        throw new Error(previousResult.error.message);
      }

      const normalizeRows = (rows: WeeklyTicketReportRow[] | null): WeeklyTicketReportRow[] => {
        return (rows || []).map((row) => ({
          ...row,
          received_count: Number(row.received_count || 0),
          solved_closed_count: Number(row.solved_closed_count || 0),
          still_open_count: Number(row.still_open_count || 0),
          resolution_rate: Number(row.resolution_rate || 0),
        }));
      };

      const currentRows = normalizeRows((currentResult.data || []) as WeeklyTicketReportRow[]);
      const previousRows = normalizeRows((previousResult.data || []) as WeeklyTicketReportRow[]);
      setWeeklyReportRows(currentRows);
      setWeeklyReportPreviousRows(previousRows);
      void trackHubEvent("weekly_report_refreshed", {
        start_date: selectedStartDate,
        rows: currentRows.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load weekly report.";
      setWeeklyReportError(message);
      setWeeklyReportRows([]);
      setWeeklyReportPreviousRows([]);
      void trackHubEvent("weekly_report_refresh_failed", {
        start_date: weeklyReportStartDate,
        message,
      });
    } finally {
      setWeeklyReportLoading(false);
    }
  }

  async function refreshReceivedRollup() {
    setReceivedRollupLoading(true);
    setReceivedRollupError(null);

    try {
      const referenceDate = toIsoDateOnly(new Date());
      const { data, error } = await supabase.rpc("get_ticket_received_rollup", {
        reference_date: referenceDate,
      });

      if (error) {
        throw new Error(error.message);
      }

      const rows = ((data || []) as TicketReceivedRollupRow[]).map((row) => ({
        ...row,
        received_count: Number(row.received_count || 0),
        previous_received_count: Number(row.previous_received_count || 0),
        delta: Number(row.delta || 0),
        delta_pct: row.delta_pct === null ? null : Number(row.delta_pct),
      }));

      setReceivedRollupRows(rows);
      void trackHubEvent("received_rollup_refreshed", {
        reference_date: referenceDate,
        rows: rows.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load monthly/quarterly/yearly intake.";
      setReceivedRollupError(message);
      setReceivedRollupRows([]);
      void trackHubEvent("received_rollup_refresh_failed", { message });
    } finally {
      setReceivedRollupLoading(false);
    }
  }

  async function handleCopyWeeklySummary() {
    if (weeklyReportRows.length === 0) {
      toast({ title: "No report data", description: "Load a report first.", variant: "destructive" });
      return;
    }

    const labels: Record<string, string> = {
      total: "Total",
      omni_one: "Omni One",
      omni_arena: "Omni Arena",
      other: "Other Brands",
    };
    const orderedBrands = ["total", "omni_one", "omni_arena", "other"];
    const currentByBrand = new Map(weeklyReportRows.map((row) => [row.brand, row]));
    const previousByBrand = new Map(weeklyReportPreviousRows.map((row) => [row.brand, row]));

    const totalRow = currentByBrand.get("total") || weeklyReportRows[0];
    const previousTotalRow = previousByBrand.get("total") || null;
    const currentStart = totalRow?.period_start_date || weeklyReportStartDate;
    const currentEnd = totalRow?.period_end_date || shiftIsoDate(currentStart, 6);

    const lines: string[] = [
      `Weekly Ticket Report (${formatDateShort(currentStart)} - ${formatDateShort(currentEnd)})`,
    ];

    if (previousTotalRow) {
      lines.push(
        `Compared to previous week (${formatDateShort(previousTotalRow.period_start_date)} - ${formatDateShort(previousTotalRow.period_end_date)}).`,
      );
    }

    lines.push("High-impact summary only.");
    lines.push("");

    lines.push("Tickets Received (WoW)");
    orderedBrands.filter((brand) => brand !== "other").forEach((brand) => {
      const current = currentByBrand.get(brand);
      if (!current) return;
      const previous = previousByBrand.get(brand);
      const receivedDelta = previous ? formatSignedIntDelta(current.received_count - previous.received_count) : "n/a";
      lines.push(`${labels[brand] ?? brand}: ${current.received_count} received (WoW ${receivedDelta})`);
    });

    const omniOneOpenPending = getOpenPendingTickets(omniOneTickets);
    const omniArenaOpenPending = getOpenPendingTickets(omniArenaTickets);
    const omniOneBacklogCounts = getOpenPendingStatusCounts(omniOneOpenPending);
    const omniArenaBacklogCounts = getOpenPendingStatusCounts(omniArenaOpenPending);

    lines.push("");
    lines.push("Currently Open Tickets (Open + Pending)");
    lines.push(
      `Omni One: ${omniOneBacklogCounts.total} (Open ${omniOneBacklogCounts.open}, Pending ${omniOneBacklogCounts.pending})`,
    );
    lines.push(
      `Omni Arena: ${omniArenaBacklogCounts.total} (Open ${omniArenaBacklogCounts.open}, Pending ${omniArenaBacklogCounts.pending})`,
    );
    lines.push(`Total Active: ${omniOneBacklogCounts.total + omniArenaBacklogCounts.total}`);

    const omniOneThemes = getTopTicketThemes(omniOneOpenPending, 3);
    const omniArenaThemes = getTopTicketThemes(omniArenaOpenPending, 3);
    const topOmniArenaCallers = getTopTicketRequesters(omniArenaOpenPending, 5);

    lines.push("");
    lines.push("Top Issue Themes (Active Queue)");
    lines.push(
      `Omni One: ${
        omniOneThemes.length > 0
          ? omniOneThemes.map((entry) => `${entry.label} (${entry.count})`).join(", ")
          : "No active tickets"
      }`,
    );
    lines.push(
      `Omni Arena: ${
        omniArenaThemes.length > 0
          ? omniArenaThemes.map((entry) => `${entry.label} (${entry.count})`).join(", ")
          : "No active tickets"
      }`,
    );

    lines.push("");
    lines.push("Top Omni Arena Callers / Venues");
    if (topOmniArenaCallers.length === 0) {
      lines.push("No active Omni Arena tickets.");
    } else {
      topOmniArenaCallers.forEach((entry, index) => {
        lines.push(`${index + 1}. ${entry.label} (${entry.count})`);
      });
    }

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast({ title: "Copied", description: "High-impact weekly summary copied." });
      void trackHubEvent("weekly_summary_copied", {
        start_date: weeklyReportStartDate,
        rows: weeklyReportRows.length,
      });
    } catch {
      toast({ title: "Copy failed", description: "Clipboard is not available.", variant: "destructive" });
    }
  }

  async function handlePreviewWeeklyDispatch() {
    setWeeklyDispatchLoading(true);

    try {
      const payload = await invokeFunctionRobust<WeeklyTicketReportDispatchResponse>("weekly_ticket_report_dispatch", {
        dry_run: true,
        skip_sync: true,
        week_start_date: weeklyReportStartDate || getCurrentWeekStartDateISO(),
        reference_date: toIsoDateOnly(new Date()),
      });

      if (!payload.ok) {
        throw new Error(payload.error || "Failed to generate weekly dispatch preview.");
      }

      const preview = payload.preview_slack || payload.preview_text || "No preview content returned.";
      setWeeklyDispatchPreview(preview);
      toast({ title: "Preview ready", description: "Slack preview generated below." });
      void trackHubEvent("weekly_dispatch_preview_generated", {
        week_start: payload.week_start_date || weeklyReportStartDate,
        reference_date: payload.reference_date || toIsoDateOnly(new Date()),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate weekly dispatch preview.";
      toast({ title: "Preview failed", description: message, variant: "destructive" });
      void trackHubEvent("weekly_dispatch_preview_failed", { message });
    } finally {
      setWeeklyDispatchLoading(false);
    }
  }

  async function handleSendWeeklyDispatchNow() {
    const confirmed = window.confirm("Send the weekly ticket report now to configured Slack channel and email recipients?");
    if (!confirmed) return;

    setWeeklyDispatchLoading(true);

    try {
      const payload = await invokeFunctionRobust<WeeklyTicketReportDispatchResponse>("weekly_ticket_report_dispatch", {
        week_start_date: weeklyReportStartDate || getCurrentWeekStartDateISO(),
        reference_date: toIsoDateOnly(new Date()),
      });

      if (!payload.ok) {
        throw new Error(payload.error || "Weekly dispatch send failed.");
      }

      toast({ title: "Weekly dispatch sent", description: "Slack and email delivery were triggered." });
      setWeeklyDispatchPreview(null);
      void trackHubEvent("weekly_dispatch_sent_manual", {
        week_start: payload.week_start_date || weeklyReportStartDate,
        reference_date: payload.reference_date || toIsoDateOnly(new Date()),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Weekly dispatch send failed.";
      toast({ title: "Dispatch failed", description: message, variant: "destructive" });
      void trackHubEvent("weekly_dispatch_sent_manual_failed", { message });
    } finally {
      setWeeklyDispatchLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;

    async function loadSession() {
      const { data, error } = await supabase.auth.getSession();
      if (!mounted) return;
      if (error) setStatus(error.message);
      setSession(data.session ?? null);
      setLoadingSession(false);
    }

    void loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession ?? null);
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryMode(true);
        setStatus("Password recovery mode detected. Set a new password.");
      }
      if (event === "SIGNED_IN") {
        setRecoveryMode(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) return;

    const userEmail = session.user.email;
    if (!isAllowedEmail(userEmail)) {
      setStatus("Access is limited to @virtuix.com accounts.");
      void supabase.auth.signOut();
    }
  }, [session]);

  const userEmail = session?.user.email ?? "";
  const authorized = useMemo(() => isAllowedEmail(userEmail), [userEmail]);

  useEffect(() => {
    if (!authorized) {
      setSites([]);
      return;
    }

    let mounted = true;
    setSitesLoading(true);
    setSitesError(null);

    getArenaSites()
      .then((data) => {
        if (mounted) setSites(data);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        const message = error instanceof Error ? error.message : "Failed to load arena sites.";
        setSitesError(message);
      })
      .finally(() => {
        if (mounted) setSitesLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [authorized]);

  useEffect(() => {
    if (!authorized) {
      setOmniOneTickets([]);
      setOmniArenaTickets([]);
      setTicketSearchResults([]);
      setTicketSearchError(null);
      setTicketSearchLoading(false);
      setTicketSearchSubmittedQuery("");
      setSummaryMap({});
      return;
    }

    let mounted = true;
    setTicketsLoading(true);
    setTicketsError(null);

      Promise.all([
        supabase
          .from("ticket_cache")
          .select("ticket_id,brand,subject,status,priority,requester_email,requester_name,assignee_email,zendesk_updated_at,ticket_url,summary_text,raw_payload")
          .eq("brand", "omni_one")
          .order("zendesk_updated_at", { ascending: false })
          .limit(75),
        supabase
          .from("ticket_cache")
          .select("ticket_id,brand,subject,status,priority,requester_email,requester_name,assignee_email,zendesk_updated_at,ticket_url,summary_text,raw_payload")
          .eq("brand", "omni_arena")
          .order("zendesk_updated_at", { ascending: false })
          .limit(75),
    ])
      .then(async ([omniOneResult, omniArenaResult]) => {
        if (!mounted) return;

        if (omniOneResult.error || omniArenaResult.error) {
          throw new Error(omniOneResult.error?.message || omniArenaResult.error?.message || "Ticket fetch failed.");
        }

        const omniOne = ((omniOneResult.data || []) as Array<Ticket & { raw_payload?: unknown }>).map(normalizeTicketRecord);
        const omniArena = ((omniArenaResult.data || []) as Array<Ticket & { raw_payload?: unknown }>).map(normalizeTicketRecord);

        setOmniOneTickets(omniOne);
        setOmniArenaTickets(omniArena);

        const ids = [...omniOne, ...omniArena].map((ticket) => ticket.ticket_id);
        if (ids.length === 0) {
          setSummaryMap({});
          return;
        }

        const { data: summaries, error: summariesError } = await supabase
          .from("ticket_summaries")
          .select("ticket_id,summary_text,key_actions,next_steps,updated_at")
          .in("ticket_id", ids);

        if (summariesError) {
          throw new Error(`Summary fetch failed: ${summariesError.message}`);
        }

        const map: Record<number, TicketSummary> = {};
        (summaries || []).forEach((item) => {
          const normalized = normalizeSummaryRecord(item);
          map[normalized.ticket_id] = normalized;
        });
        setSummaryMap(map);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        const message = error instanceof Error ? error.message : "Failed to load tickets.";
        setTicketsError(message);
      })
      .finally(() => {
        if (mounted) setTicketsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [authorized, refreshKey]);

  useEffect(() => {
    if (!authorized) {
      return;
    }

    if (!ticketSearchSubmittedQuery) {
      return;
    }

    void runTicketCacheSearch(ticketSearchSubmittedQuery);
  }, [authorized, refreshKey, ticketSearchSubmittedQuery]);

  useEffect(() => {
    if (!authorized) {
      setDigests([]);
      return;
    }

    let mounted = true;
    setDigestsLoading(true);
    setDigestsError(null);

    supabase
      .from("digests")
      .select("id,title,source,filters,ticket_ids,content_markdown,content_table,created_at")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          setDigestsError(error.message);
          return;
        }

        const nextDigests = (data || []) as Digest[];
        setDigests(nextDigests);
        setSelectedDigestId((current) => current || nextDigests[0]?.id || null);
      })
      .finally(() => {
        if (mounted) setDigestsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [authorized, refreshKey]);

  useEffect(() => {
    if (!authorized) {
      setDocumentsByBrand({ omni_one: [], omni_arena: [] });
      setDocumentsFolderByBrand({ omni_one: null, omni_arena: null });
      setDocumentsError(null);
      setDocumentsPreviewError(null);
      setSelectedDocumentPath(null);
      setSelectedDocumentPreviewUrl(null);
      setSelectedDocumentPreviewPageNumber(null);
      setDocumentsSemanticQuery("");
      setDocumentsSemanticSearching(false);
      setDocumentsSemanticError(null);
      setDocumentsSemanticResults([]);
      return;
    }

    if (!inDocumentsRoute) {
      return;
    }

    void refreshDocuments();
  }, [authorized, inDocumentsRoute, refreshKey]);

  useEffect(() => {
    if (!authorized || !inDocumentsRoute || !selectedDocumentPath) {
      setSelectedDocumentPreviewUrl(null);
      setSelectedDocumentPreviewPageNumber(null);
      setDocumentsPreviewError(null);
      setDocumentsPreviewLoading(false);
      return;
    }

    let mounted = true;
    setDocumentsPreviewLoading(true);
    setDocumentsPreviewError(null);

    supabase.storage.from(SUPPORT_DOCUMENTS_BUCKET).createSignedUrl(normalizeStoragePath(selectedDocumentPath), 60 * 60 * 12)
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          setSelectedDocumentPreviewUrl(null);
          setDocumentsPreviewError(error.message);
          return;
        }
        setSelectedDocumentPreviewUrl(data?.signedUrl || null);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        const message = error instanceof Error ? error.message : "Failed to create preview link.";
        setSelectedDocumentPreviewUrl(null);
        setDocumentsPreviewError(message);
      })
      .finally(() => {
        if (mounted) {
          setDocumentsPreviewLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [authorized, inDocumentsRoute, selectedDocumentPath]);

  useEffect(() => {
    if (!authorized) {
      setWeeklyReportRows([]);
      setWeeklyReportPreviousRows([]);
      setWeeklyReportError(null);
      setWeeklyReportLoading(false);
      setReceivedRollupRows([]);
      setReceivedRollupError(null);
      setReceivedRollupLoading(false);
      return;
    }

    if (!inReportsRoute) {
      return;
    }

    void refreshWeeklyReport();
  }, [authorized, inReportsRoute, refreshKey, weeklyReportStartDate]);

  useEffect(() => {
    if (!authorized) {
      setReceivedRollupRows([]);
      setReceivedRollupError(null);
      setReceivedRollupLoading(false);
      return;
    }

    if (!inReportsRoute) {
      return;
    }

    void refreshReceivedRollup();
  }, [authorized, inReportsRoute, refreshKey]);

  useEffect(() => {
    if (!authorized) {
      setLastSync(null);
      return;
    }

    let mounted = true;
    supabase
      .from("zendesk_sync_runs")
      .select("finished_at,tickets_upserted,status")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error || !data) {
          setLastSync(null);
          return;
        }

        setLastSync({
          finishedAt: data.finished_at,
          ticketsUpserted: data.tickets_upserted ?? 0,
          status: data.status ?? "unknown",
        });
      });

    return () => {
      mounted = false;
    };
  }, [authorized, refreshKey]);

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalized = email.trim().toLowerCase();
    if (!isAllowedEmail(normalized)) {
      setStatus("Use your @virtuix.com email address.");
      return;
    }

    setSubmitting(true);
    setStatus(null);

    const { error } = await supabase.auth.signInWithPassword({ email: normalized, password });
    setStatus(error ? error.message : "Signed in.");
    setSubmitting(false);
  }

  async function handleSignOut() {
    const { error } = await supabase.auth.signOut();
    if (error) {
      setStatus(error.message);
      return;
    }
    setStatus("Signed out.");
    setSelectedTicketIds(new Set());
    setActiveTicket(null);
  }

  async function handleUpdatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (newPassword.length < 8) {
      setStatus("New password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setStatus("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setStatus(`Password update failed: ${error.message}`);
    } else {
      setStatus("Password updated successfully. Please sign in.");
      setRecoveryMode(false);
      setNewPassword("");
      setConfirmPassword("");
      await supabase.auth.signOut();
    }
    setSubmitting(false);
  }

  async function handleSyncNow() {
    setSyncLoading(true);
    setSyncMessage(null);

    let data: SyncZendeskResponse;
    try {
      data = await invokeFunctionRobust<SyncZendeskResponse>("sync_zendesk", { brand: "all" });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Unknown sync error.";
      let enriched = details;
      if (isAuthTokenErrorMessage(details)) {
        const debug = await getClientAuthDebugSnapshot();
        enriched = `${details} | client_auth=${JSON.stringify(debug)}`;
      }
      setSyncMessage(`Sync failed: ${enriched}`);
      toast({ title: "Sync failed", description: enriched, variant: "destructive" });
      setSyncLoading(false);
      return;
    }

    const upserted = data.tickets_upserted ?? 0;
    const message = data.skipped
      ? data.reason || "Sync skipped."
      : data.has_more
        ? `Sync progressed. ${upserted} tickets updated in this run; additional pages remain.`
        : `Sync completed. ${upserted} tickets updated.`;
    setSyncMessage(message);
    toast({ title: "Zendesk sync", description: message });
    setSyncLoading(false);
    setRefreshKey((value) => value + 1);
  }

  async function handleBackfillOneYear() {
    setSyncLoading(true);
    setSyncMessage(null);

    const maxRuns = 6;
    const pauseBetweenRunsMs = 1200;
    let runsExecuted = 0;
    let totalFetched = 0;
    let totalUpserted = 0;
    let stillHasMore = false;
    let skippedReason: string | null = null;

    try {
      for (let run = 1; run <= maxRuns; run += 1) {
        const data = await invokeFunctionRobust<SyncZendeskResponse>("sync_zendesk", {
          brand: "all",
          backfill_year: true,
          backfill_days: 365,
          max_pages: 120,
        });

        if (data.skipped) {
          skippedReason = data.reason || "Backfill skipped.";
          break;
        }

        runsExecuted += 1;
        totalFetched += data.tickets_fetched ?? 0;
        totalUpserted += data.tickets_upserted ?? 0;
        stillHasMore = data.has_more === true;

        if (!stillHasMore) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, pauseBetweenRunsMs));
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : "Unknown backfill error.";
      let enriched = details;
      if (isAuthTokenErrorMessage(details)) {
        const debug = await getClientAuthDebugSnapshot();
        enriched = `${details} | client_auth=${JSON.stringify(debug)}`;
      }
      setSyncMessage(`Backfill failed: ${enriched}`);
      toast({ title: "Backfill failed", description: enriched, variant: "destructive" });
      setSyncLoading(false);
      return;
    }

    const message = skippedReason && runsExecuted === 0
      ? skippedReason
      : stillHasMore
        ? `Backfill progressed (${runsExecuted} runs, ${totalFetched} fetched, ${totalUpserted} updated). More historical pages remain; run again to continue.`
        : `Backfill completed for the configured window (${runsExecuted} runs, ${totalFetched} fetched, ${totalUpserted} updated).`;
    setSyncMessage(message);
    toast({
      title: "Zendesk backfill",
      description: message,
    });
    setSyncLoading(false);
    setRefreshKey((value) => value + 1);
  }

  function setSelection(ticketId: number, checked: boolean) {
    setSelectedTicketIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(ticketId);
      } else {
        next.delete(ticketId);
      }
      return next;
    });
  }

  function setSelectionForMany(ticketIds: number[], checked: boolean) {
    setSelectedTicketIds((prev) => {
      const next = new Set(prev);
      ticketIds.forEach((id) => {
        if (checked) {
          next.add(id);
        } else {
          next.delete(id);
        }
      });
      return next;
    });
  }

  function openTicket(ticket: Ticket) {
    setActiveTicket(ticket);
    setTicketDrawerOpen(true);
    if (!summaryMap[ticket.ticket_id] && !summaryLoadingTicketId) {
      void refreshTicketSummary(ticket.ticket_id, false);
    }
  }

  function handleSelectDocumentsBrand(brand: DocumentBrand) {
    setActiveDocumentsBrand(brand);
    setSelectedDocumentPreviewPageNumber(null);
    setDocumentsSemanticError(null);
    setDocumentsSemanticResults([]);
    setSelectedDocumentPath(getFirstDocumentPath(documentsByBrand, brand, documentsFolderByBrand[brand]));
  }

  function handleSelectDocumentsTopLevelFolder(folder: string | null) {
    setDocumentsFolderByBrand((previous) => ({ ...previous, [activeDocumentsBrand]: folder }));
    setSelectedDocumentPreviewPageNumber(null);
    setDocumentsSemanticError(null);
    setDocumentsSemanticResults([]);
    const matchingDocuments = filterDocumentsByFolder(documentsByBrand[activeDocumentsBrand] || [], activeDocumentsBrand, folder);
    setSelectedDocumentPath(matchingDocuments[0]?.path || null);
  }

  function handleSelectDocument(file: SupportDocument) {
    setActiveDocumentsBrand(file.brand);
    setSelectedDocumentPreviewPageNumber(null);
    setSelectedDocumentPath(normalizeStoragePath(file.path));
  }

  function handleClearDocumentsSemanticSearch() {
    setDocumentsSemanticQuery("");
    setDocumentsSemanticError(null);
    setDocumentsSemanticResults([]);
  }

  async function handleSemanticSearchDocuments() {
    const query = documentsSemanticQuery.trim();
    if (!query) {
      setDocumentsSemanticError("Enter a search query.");
      setDocumentsSemanticResults([]);
      return;
    }

    setDocumentsSemanticSearching(true);
    setDocumentsSemanticError(null);

    let data: SemanticSearchDocumentsResponse;
    try {
      data = await invokeFunctionRobust<SemanticSearchDocumentsResponse>("semantic_search_documents", {
        query,
        brand: activeDocumentsBrand,
        top_level_folder: documentsFolderByBrand[activeDocumentsBrand],
        top_k: 8,
        min_similarity: 0.2,
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Semantic search failed.";
      setDocumentsSemanticError(details);
      setDocumentsSemanticResults([]);
      setDocumentsSemanticSearching(false);
      return;
    }

    if (!data.ok) {
      const details = data.error || "Semantic search failed.";
      setDocumentsSemanticError(details);
      setDocumentsSemanticResults([]);
      setDocumentsSemanticSearching(false);
      return;
    }

    const results = Array.isArray(data.results) ? data.results : [];
    setDocumentsSemanticResults(results);
    if (results.length === 0) {
      setDocumentsSemanticError("No semantic matches found for this query in the current scope.");
    } else {
      setDocumentsSemanticError(null);
    }
    setDocumentsSemanticSearching(false);
  }

  function handleSelectSemanticDocumentResult(result: SemanticSearchDocumentResult) {
    const brand = isDocumentBrand(result.brand) ? result.brand : activeDocumentsBrand;
    const normalizedPath = normalizeStoragePath(result.storage_path);
    const normalizedFolder = typeof result.top_level_folder === "string" && result.top_level_folder.trim().length > 0
      ? result.top_level_folder.trim()
      : null;

    setActiveDocumentsBrand(brand);
    setDocumentsFolderByBrand((previous) => ({ ...previous, [brand]: normalizedFolder }));
    const matchingDocuments = documentsByBrand[brand] || [];
    const found = matchingDocuments.find((document) => normalizeStoragePath(document.path) === normalizedPath);
    setSelectedDocumentPath(found?.path || normalizedPath);

    const pageNumber = typeof result.page_number === "number" && result.page_number > 0
      ? Math.trunc(result.page_number)
      : null;
    setSelectedDocumentPreviewPageNumber(pageNumber);
  }

  async function handleDownloadDocument(file: SupportDocument) {
    setDownloadLoadingPath(file.path);

    try {
      const { data, error } = await supabase.storage.from(SUPPORT_DOCUMENTS_BUCKET).download(normalizeStoragePath(file.path));
      if (error || !data) {
        throw new Error(error?.message || "Unable to download document.");
      }

      const objectUrl = URL.createObjectURL(data);
      const link = window.document.createElement("a");
      link.href = objectUrl;
      link.download = file.name;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed.";
      toast({ title: "Download failed", description: message, variant: "destructive" });
    } finally {
      setDownloadLoadingPath(null);
    }
  }

  async function refreshTicketSummary(ticketId: number, refresh: boolean) {
    setSummaryLoadingTicketId(ticketId);

    let data: SummarizeTicketResponse;
    try {
      data = await invokeFunctionRobust<SummarizeTicketResponse>("summarize_ticket", {
        ticket_id: ticketId,
        refresh,
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Summary generation failed.";
      toast({ title: "Summary error", description: details, variant: "destructive" });
      setSummaryLoadingTicketId(null);
      return;
    }
    if (!data.ok) {
      toast({ title: "Summary error", description: data.error || "Summary generation failed.", variant: "destructive" });
      setSummaryLoadingTicketId(null);
      return;
    }

    const normalized: TicketSummary = {
      ticket_id: data.ticket_id,
      summary_text: data.summary_text,
      key_actions: data.key_actions || [],
      next_steps: data.next_steps || [],
      updated_at: data.updated_at,
    };

    setSummaryMap((prev) => ({ ...prev, [data.ticket_id]: normalized }));
    setOmniOneTickets((prev) => prev.map((row) => (row.ticket_id === data.ticket_id ? { ...row, summary_text: data.summary_text } : row)));
    setOmniArenaTickets((prev) => prev.map((row) => (row.ticket_id === data.ticket_id ? { ...row, summary_text: data.summary_text } : row)));

    toast({ title: "Summary ready", description: data.cached ? "Loaded cached summary." : "Generated a fresh summary." });
    setSummaryLoadingTicketId(null);
  }

  async function handleGenerateDigest(request: DigestRequest) {
    setGeneratingDigest(true);

    let data: CreateDigestResponse;
    try {
      data = await invokeFunctionRobust<CreateDigestResponse>("create_digest", {
        ticket_ids: request.ticketIds,
        filters: request.filters,
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Digest generation failed.";
      toast({ title: "Digest error", description: details, variant: "destructive" });
      setGeneratingDigest(false);
      return;
    }
    if (!data.ok) {
      toast({ title: "Digest error", description: data.error || "Digest generation failed.", variant: "destructive" });
      setGeneratingDigest(false);
      return;
    }

    setDigests((prev) => [data.digest, ...prev.filter((digest) => digest.id !== data.digest.id)]);
    setSelectedDigestId(data.digest.id);
    setSelectedTicketIds(new Set());
    toast({ title: "Digest created", description: `${data.ticket_count} tickets included.` });
    setGeneratingDigest(false);
    navigate("/hub/digests");
  }

  async function sendTicketSummaryToSlack(ticketId: number) {
    let data: SendToSlackResponse;
    try {
      data = await invokeFunctionRobust<SendToSlackResponse>("send_to_slack", {
        type: "ticket_summary",
        ticket_id: ticketId,
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Failed to send ticket summary to Slack.";
      toast({ title: "Slack send failed", description: details, variant: "destructive" });
      return;
    }
    if (!data.ok) {
      toast({ title: "Slack send failed", description: data.error || "Failed to send ticket summary to Slack.", variant: "destructive" });
      return;
    }

    toast({ title: "Sent to Slack", description: `Ticket #${ticketId} summary posted.` });
  }

  async function sendDigestToSlack(digestId: string) {
    let data: SendToSlackResponse;
    try {
      data = await invokeFunctionRobust<SendToSlackResponse>("send_to_slack", {
        type: "digest",
        digest_id: digestId,
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Failed to send digest to Slack.";
      toast({ title: "Slack send failed", description: details, variant: "destructive" });
      return;
    }
    if (!data.ok) {
      toast({ title: "Slack send failed", description: data.error || "Failed to send digest to Slack.", variant: "destructive" });
      return;
    }

    toast({ title: "Sent to Slack", description: "Digest posted to Slack." });
  }

  async function copyTicketSummary(ticket: Ticket, summary: TicketSummary | null) {
    const lines = [
      `Ticket #${ticket.ticket_id}`,
      `Brand: ${ticket.brand}`,
      `Status: ${ticket.status}`,
      `Subject: ${ticket.subject}`,
      "",
      summary?.summary_text || ticket.summary_text || "No summary.",
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast({ title: "Copied", description: "Ticket summary copied." });
    } catch {
      toast({ title: "Copy failed", description: "Clipboard is not available.", variant: "destructive" });
    }
  }

  async function copyDigestMarkdown(digestId: string) {
    const digest = digests.find((item) => item.id === digestId);
    if (!digest) return;

    try {
      await navigator.clipboard.writeText(digest.content_markdown);
      toast({ title: "Copied", description: "Digest markdown copied." });
    } catch {
      toast({ title: "Copy failed", description: "Clipboard is not available.", variant: "destructive" });
    }
  }

  async function copyDigestTable(digestId: string) {
    const digest = digests.find((item) => item.id === digestId);
    if (!digest) return;

    try {
      const rows = Array.isArray(digest.content_table) ? digest.content_table : [];
      await navigator.clipboard.writeText(formatTicketTableForClipboard(rows));
      toast({ title: "Copied", description: "Digest table copied." });
    } catch {
      toast({ title: "Copy failed", description: "Clipboard is not available.", variant: "destructive" });
    }
  }

  async function handleCopilotAsk(messages: CopilotChatInputMessage[]): Promise<{ reply: string; citations: CopilotCitation[] }> {
    void trackHubEvent("copilot_query_submitted", {
      message_count: messages.length,
      latest_message_length: messages[messages.length - 1]?.content.length ?? 0,
    });

    const data = await invokeFunctionRobust<CopilotChatResponse>("copilot_chat", {
      messages,
      context: {
        omni_one_ticket_count: omniOneTickets.length,
        omni_arena_ticket_count: omniArenaTickets.length,
        digest_count: digests.length,
      },
    });

    if (!data.ok) {
      void trackHubEvent("copilot_query_failed", {
        message_count: messages.length,
        error: data.error || "copilot_response_failed",
      });
      throw new Error(data.error || "Copilot response failed.");
    }

    const citations = Array.isArray(data.citations) ? data.citations : [];
    void trackHubEvent("copilot_query_completed", {
      message_count: messages.length,
      citation_count: citations.length,
      model: data.model || null,
    });

    return {
      reply: data.reply,
      citations,
    };
  }

  function handleCopilotCitationClick(citation: CopilotCitation) {
    void trackHubEvent("copilot_citation_clicked", {
      source_type: citation.source_type,
      title: citation.title,
      ticket_id: citation.ticket_id ?? null,
      similarity: citation.similarity ?? null,
    });
  }

  const videoLibraryEntries = useMemo(() => getHubVideoLibraryEntries(), []);
  const allTicketCount = omniOneTickets.length + omniArenaTickets.length;
  const omniOneTicketCounts = useMemo(() => getTicketStatusCounts(omniOneTickets), [omniOneTickets]);
  const omniArenaTicketCounts = useMemo(() => getTicketStatusCounts(omniArenaTickets), [omniArenaTickets]);
  const activeBacklogCount = omniOneTicketCounts.open + omniOneTicketCounts.pending + omniArenaTicketCounts.open + omniArenaTicketCounts.pending;
  const noSupportSitesCount = useMemo(
    () =>
      sites.filter((site) => {
        const normalized = site.currentQuarterStatus.toLowerCase().trim();
        return normalized === "no support" || normalized === "nosupport";
      }).length,
    [sites],
  );
  const allDocuments = useMemo(
    () => flattenDocumentsByBrand(documentsByBrand),
    [documentsByBrand],
  );
  const activeDocumentFolderCount = useMemo(
    () => getFolderOptionsForBrand(documentsByBrand[activeDocumentsBrand] || [], activeDocumentsBrand).length,
    [activeDocumentsBrand, documentsByBrand],
  );
  const selectedDigest = digests.find((digest) => digest.id === selectedDigestId) || null;
  const featuredVideoCount = useMemo(
    () => videoLibraryEntries.filter((video) => video.featured).length,
    [videoLibraryEntries],
  );
  const omniOneVideoCount = useMemo(
    () => videoLibraryEntries.filter((video) => video.brand === "omni_one").length,
    [videoLibraryEntries],
  );
  const omniArenaVideoCount = useMemo(
    () => videoLibraryEntries.filter((video) => video.brand === "omni_arena").length,
    [videoLibraryEntries],
  );
  const routeTabs: HubRouteTab[] = [
    { key: "tickets", label: "Tickets", path: "/hub", active: inTicketRoute, description: "Live Zendesk queue and sites" },
    { key: "digests", label: "Digests", path: "/hub/digests", active: inDigestRoute, description: "Saved queue summaries" },
    { key: "documents", label: "Documents", path: "/hub/documents", active: inDocumentsRoute, description: "PDF library and search" },
    { key: "videos", label: "Videos", path: "/hub/videos", active: inVideosRoute, description: "Training and repair video library" },
    { key: "reports", label: "Reports", path: "/hub/reports", active: inReportsRoute, description: "Weekly reporting and dispatch" },
  ];
  const activeViewMeta: Record<HubViewKey, { kicker: string; title: string; description: string }> = {
    tickets: {
      kicker: "Operations Console",
      title: "Ticket Operations",
      description: "Review active Zendesk workload, open ticket detail, build digests, and monitor venue coverage from one workspace.",
    },
    digests: {
      kicker: "Operational Summaries",
      title: "Queue Digests",
      description: "Keep recent AI-generated digests visible so handoffs, escalation notes, and queue snapshots stay reusable.",
    },
    documents: {
      kicker: "Knowledge Base",
      title: "Support Documents",
      description: "Browse product PDFs, narrow by folder, and use semantic search to jump straight to the right reference material.",
    },
    videos: {
      kicker: "Training Library",
      title: "Support Videos",
      description: "A curated library for repair, setup, and troubleshooting videos.",
    },
    reports: {
      kicker: "Reporting",
      title: "Weekly Ticket Reporting",
      description: "Track intake trends, active backlog, and dispatch-ready summaries without leaving the hub.",
    },
  };
  const workspaceMetrics: WorkspaceMetric[] = (() => {
    switch (currentView) {
      case "digests":
        return [
          { label: "Saved Digests", value: String(digests.length), detail: "Recent summaries stored in Supabase.", accent: true },
          {
            label: "Selected Digest",
            value: String(selectedDigest?.ticket_ids.length ?? 0),
            detail: selectedDigest ? `${selectedDigest.title}` : "Select a digest to inspect its ticket set.",
          },
          { label: "Active Backlog", value: String(activeBacklogCount), detail: "Open + pending tickets across both brands." },
          {
            label: "Latest Digest",
            value: digests[0]?.created_at ? formatDateShort(digests[0].created_at) : "Not yet",
            detail: digests[0] ? digests[0].title : "No digests have been created yet.",
          },
        ];
      case "documents":
        return [
          { label: "PDF Library", value: String(allDocuments.length), detail: "Documents currently available in storage.", accent: true },
          { label: "Omni One Docs", value: String(documentsByBrand.omni_one.length), detail: "Current Omni One document count." },
          { label: "Omni Arena Docs", value: String(documentsByBrand.omni_arena.length), detail: "Current Omni Arena document count." },
          {
            label: "Active Scope",
            value: documentsFolderByBrand[activeDocumentsBrand] || "All folders",
            detail: `${activeDocumentsBrand === "omni_one" ? "Omni One" : "Omni Arena"} • ${activeDocumentFolderCount} folders`,
          },
        ];
      case "videos":
        return [
          { label: "Video Library", value: String(videoLibraryEntries.length), detail: "Validated playable video entries.", accent: true },
          { label: "Featured", value: String(featuredVideoCount), detail: "Pinned videos for common support flows." },
          { label: "Omni One", value: String(omniOneVideoCount), detail: "Video entries for Omni One support." },
          { label: "Omni Arena", value: String(omniArenaVideoCount), detail: "Video entries for Omni Arena support." },
        ];
      case "reports":
        return [
          { label: "Report Rows", value: String(weeklyReportRows.length), detail: "Rows loaded for the selected weekly report.", accent: true },
          { label: "Week Start", value: formatDateShort(weeklyReportStartDate), detail: "Current reporting window anchor date." },
          { label: "Active Backlog", value: String(activeBacklogCount), detail: "Open + pending queue used for report context." },
          {
            label: "Last Sync",
            value: lastSync?.status || "Unknown",
            detail: lastSync?.finishedAt ? formatDateTime(lastSync.finishedAt) : "No sync metadata available yet.",
          },
        ];
      case "tickets":
      default:
        return [
          { label: "Cached Tickets", value: String(allTicketCount), detail: "Latest cached records across both brands.", accent: true },
          { label: "Active Backlog", value: String(activeBacklogCount), detail: "Open + pending tickets needing follow-through." },
          { label: "Selected", value: String(selectedTicketIds.size), detail: "Selections can span both queues for digest generation." },
          { label: "No-Support Sites", value: String(noSupportSitesCount), detail: "Arena venues currently flagged as no support." },
        ];
    }
  })();
  const currentViewMeta = activeViewMeta[currentView];

  if (loadingSession) {
    return (
      <main className="relative min-h-screen overflow-hidden bg-background">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(132,202,65,0.22),transparent_40%)]" />
        <div className="pointer-events-none absolute inset-0 ambient-grid opacity-[0.14]" />

        <div className="relative z-10 border-b border-border/50 bg-gradient-to-b from-primary/28 via-primary/10 to-transparent backdrop-blur-sm">
          <div className="container flex max-w-[2200px] items-center justify-between gap-3 px-4 py-4">
            <Link to="/" className="inline-flex items-center gap-3">
              <BrandLockup />
            </Link>
            <ThemeToggle />
          </div>
        </div>

        <div className="container relative z-10 max-w-3xl px-4 py-16">
          <section className="surface-panel reveal-up p-8 md:p-10">
            <p className="brand-kicker">Session</p>
            <h1 className="mt-3 font-display text-3xl md:text-4xl font-semibold tracking-tight">Loading Support Hub</h1>
            <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
              Verifying your account and preparing ticket operations workspace.
            </p>
            <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/45 px-3 py-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Initializing session
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="relative min-h-screen overflow-hidden bg-background">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(132,202,65,0.22),transparent_38%)]" />
        <div className="pointer-events-none absolute inset-0 ambient-grid opacity-[0.14]" />

        <div className="relative z-10 border-b border-border/50 bg-gradient-to-b from-primary/28 via-primary/10 to-transparent backdrop-blur-sm">
          <div className="container flex max-w-[2200px] items-center justify-between gap-3 px-4 py-4">
            <Link to="/" className="inline-flex items-center gap-3">
              <BrandLockup />
            </Link>
            <ThemeToggle />
          </div>
        </div>

        <div className="container relative z-10 max-w-3xl px-4 py-12">
          <section className="surface-panel reveal-up p-7 md:p-9">
            <p className="brand-kicker">Internal Access</p>
            <h1 className="mt-3 font-display text-3xl md:text-4xl font-semibold tracking-tight">
              {recoveryMode ? "Recover Access" : "Support Hub Sign In"}
            </h1>
            <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
              {recoveryMode
                ? "Set your new password below to finish the secure recovery flow."
                : "Restricted to Virtuix team members using a @virtuix.com account."}
            </p>

            {recoveryMode ? (
              <form className="mt-6 space-y-3" onSubmit={handleUpdatePassword}>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="New password"
                  required
                />
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Confirm new password"
                  required
                />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button type="submit" disabled={submitting}>
                    {submitting ? "Updating..." : "Update password"}
                  </Button>
                  <Button asChild type="button" variant="ghost">
                    <Link to="/">Back to Schedule</Link>
                  </Button>
                </div>
              </form>
            ) : (
              <form className="mt-6 space-y-3" onSubmit={handleSignIn}>
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@virtuix.com"
                  required
                />
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Password"
                  required
                />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button type="submit" disabled={submitting}>
                    {submitting ? "Signing in..." : "Sign in"}
                  </Button>
                  <Button asChild type="button" variant="ghost">
                    <Link to="/">Back to Schedule</Link>
                  </Button>
                </div>
              </form>
            )}

            {status ? (
              <p className="mt-4 rounded-lg border border-border/70 bg-background/45 px-3 py-2 text-sm text-muted-foreground">
                {status}
              </p>
            ) : null}
          </section>
        </div>
      </main>
    );
  }

  const activeSummary = activeTicket ? summaryMap[activeTicket.ticket_id] || null : null;

  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(132,202,65,0.2),transparent_42%)]" />
      <div className="pointer-events-none absolute inset-0 ambient-grid opacity-[0.14]" />
      <div className="relative z-10 border-b border-border/50 bg-gradient-to-b from-primary/24 via-primary/8 to-transparent backdrop-blur-sm">
        <div className="container flex max-w-[2200px] items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="inline-flex items-center gap-3">
            <BrandLockup />
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild size="sm" variant="ghost" className="hidden sm:inline-flex">
              <Link to="/">Public Schedule</Link>
            </Button>
            <span className="hidden text-[12px] text-muted-foreground xl:inline">{userEmail}</span>
            <Button size="sm" variant="outline" className="gap-2 xl:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
              <Menu className="h-4 w-4" />
              <span className="hidden sm:inline">Menu</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="container relative z-10 max-w-[2200px] px-4 py-6 lg:py-7">
        <div className="grid gap-6 xl:grid-cols-[290px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="hidden xl:block xl:sticky xl:top-6 xl:self-start">
            <SideNavigation
              userEmail={userEmail}
              onSignOut={() => void handleSignOut()}
              onNavigate={() => setMobileNavOpen(false)}
              routes={routeTabs}
              allTicketCount={allTicketCount}
              activeBacklogCount={activeBacklogCount}
              lastSync={lastSync}
            />
          </aside>

          <section className="space-y-5">
            <section className="surface-panel reveal-up relative overflow-hidden p-6 md:p-7">
              <div className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-primary/18 blur-3xl" />
              <div className="relative space-y-5">
                <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <p className="brand-kicker">{currentViewMeta.kicker}</p>
                      <h1 className="font-display text-3xl font-semibold leading-tight tracking-tight md:text-4xl">
                        {currentViewMeta.title}
                      </h1>
                      <p className="max-w-3xl text-[15px] leading-6 text-muted-foreground md:text-[16px]">
                        {currentViewMeta.description}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {routeTabs.map((tab) => (
                        <Button
                          key={tab.path}
                          size="sm"
                          variant={tab.active ? "secondary" : "ghost"}
                          className={tab.active ? "border-primary/40 bg-primary/12 text-primary" : ""}
                          onClick={() => navigate(tab.path)}
                        >
                          {tab.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="surface-panel-soft space-y-3 p-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Data Sync</p>
                      <p className="mt-2 text-2xl font-semibold tracking-tight">{lastSync?.status || "Not available"}</p>
                      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                        {lastSync?.finishedAt
                          ? `Last completed ${formatDateTime(lastSync.finishedAt)}. ${lastSync.ticketsUpserted} tickets updated in that run.`
                          : "Run a sync to refresh cached Zendesk data and downstream reporting."}
                      </p>
                    </div>

                    {syncMessage ? (
                      <p className="rounded-xl border border-border/65 bg-background/45 px-3 py-2 text-[12px] leading-5 text-muted-foreground">
                        {syncMessage}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <Button onClick={handleSyncNow} disabled={syncLoading}>
                        {syncLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                        {syncLoading ? "Syncing..." : "Sync Zendesk"}
                      </Button>
                      <Button variant="outline" onClick={handleBackfillOneYear} disabled={syncLoading}>
                        {syncLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                        {syncLoading ? "Running..." : "Backfill 1 Year"}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {workspaceMetrics.map((metric) => (
                    <WorkspaceMetricCard key={metric.label} {...metric} />
                  ))}
                </div>
              </div>
            </section>

            <PaneErrorBoundary key={currentView}>
              {inDigestRoute ? (
                <DigestsPane
                  digests={digests}
                  loading={digestsLoading}
                  error={digestsError}
                  selectedDigestId={selectedDigestId}
                  onSelectDigest={setSelectedDigestId}
                  onSendToSlack={sendDigestToSlack}
                  onCopyMarkdown={copyDigestMarkdown}
                  onCopyTable={copyDigestTable}
                />
              ) : inDocumentsRoute ? (
                <DocumentsPane
                  documentsByBrand={documentsByBrand}
                  loading={documentsLoading}
                  error={documentsError}
                  activeBrand={activeDocumentsBrand}
                  activeTopLevelFolder={documentsFolderByBrand[activeDocumentsBrand]}
                  selectedDocumentPath={selectedDocumentPath}
                  previewUrl={selectedDocumentPreviewUrl}
                  previewPageNumber={selectedDocumentPreviewPageNumber}
                  previewLoading={documentsPreviewLoading}
                  previewError={documentsPreviewError}
                  downloadingDocumentPath={downloadLoadingPath}
                  semanticQuery={documentsSemanticQuery}
                  semanticSearching={documentsSemanticSearching}
                  semanticError={documentsSemanticError}
                  semanticResults={documentsSemanticResults}
                  onRefresh={refreshDocuments}
                  onSelectBrand={handleSelectDocumentsBrand}
                  onSelectTopLevelFolder={handleSelectDocumentsTopLevelFolder}
                  onSelectDocument={handleSelectDocument}
                  onDownloadDocument={handleDownloadDocument}
                  onSemanticQueryChange={setDocumentsSemanticQuery}
                  onSemanticSearch={handleSemanticSearchDocuments}
                  onClearSemanticSearch={handleClearDocumentsSemanticSearch}
                  onSelectSemanticResult={handleSelectSemanticDocumentResult}
                />
              ) : inReportsRoute ? (
                <ReportsPane
                  rows={weeklyReportRows}
                  previousRows={weeklyReportPreviousRows}
                  receivedRollupRows={receivedRollupRows}
                  receivedRollupLoading={receivedRollupLoading}
                  receivedRollupError={receivedRollupError}
                  omniOneTickets={omniOneTickets}
                  omniArenaTickets={omniArenaTickets}
                  loading={weeklyReportLoading}
                  error={weeklyReportError}
                  weekStartDate={weeklyReportStartDate}
                  onWeekStartDateChange={setWeeklyReportStartDate}
                  onRefresh={refreshWeeklyReport}
                  onRefreshReceivedRollup={refreshReceivedRollup}
                  onCopySummary={handleCopyWeeklySummary}
                  dispatchPreview={weeklyDispatchPreview}
                  dispatchLoading={weeklyDispatchLoading}
                  onPreviewDispatch={handlePreviewWeeklyDispatch}
                  onSendDispatch={handleSendWeeklyDispatchNow}
                  onClearDispatchPreview={() => setWeeklyDispatchPreview(null)}
                />
              ) : inVideosRoute ? (
                <VideosPane />
              ) : (
                <>
                  <TicketSearchPane
                    query={ticketSearchQuery}
                    loading={ticketSearchLoading}
                    error={ticketSearchError}
                    submittedQuery={ticketSearchSubmittedQuery}
                    results={ticketSearchResults}
                    selectedIds={selectedTicketIds}
                    onQueryChange={setTicketSearchQuery}
                    onSearch={() => runTicketCacheSearch()}
                    onClear={handleClearTicketSearch}
                    onSelectionChange={setSelection}
                    onSelectAllVisible={setSelectionForMany}
                    onOpenTicket={openTicket}
                    onGenerateDigest={handleGenerateDigest}
                    generatingDigest={generatingDigest}
                  />

                  <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <WorkspaceMetricCard
                      label="Active Queue"
                      value={String(activeBacklogCount)}
                      detail="Open + pending tickets across both brands."
                      accent
                    />
                    <WorkspaceMetricCard
                      label="Omni One Active"
                      value={String(omniOneTicketCounts.active)}
                      detail={`Open ${omniOneTicketCounts.open} • Pending ${omniOneTicketCounts.pending} • New ${omniOneTicketCounts.new}`}
                    />
                    <WorkspaceMetricCard
                      label="Omni Arena Active"
                      value={String(omniArenaTicketCounts.active)}
                      detail={`Open ${omniArenaTicketCounts.open} • Pending ${omniArenaTicketCounts.pending} • New ${omniArenaTicketCounts.new}`}
                    />
                    <WorkspaceMetricCard
                      label="Arena Sites"
                      value={String(sites.length)}
                      detail={`${noSupportSitesCount} venues currently flagged as no support.`}
                    />
                  </section>

                  <section className="rounded-2xl border border-border/70 bg-card/55 px-5 py-4 text-[13px] leading-6 text-muted-foreground">
                    Ticket selections persist across both brand tables. Open any ticket to generate a fresh summary, copy it,
                    or send it to Slack without leaving the queue view.
                  </section>

                  <section className="grid gap-5 xl:gap-6 2xl:grid-cols-2">
                    <section className="surface-panel space-y-4 p-5 md:p-6">
                      <div className="flex items-center justify-between border-b border-border/55 pb-3">
                        <div className="flex items-center gap-3">
                          <span className="brand-logo-shell h-10 min-w-[76px] px-3">
                            <img src={omniOneLogo} alt="Omni One" className="h-5 w-auto" />
                          </span>
                          <div>
                            <p className="text-base font-semibold tracking-tight">Omni One</p>
                            <p className="mt-1 text-sm text-muted-foreground">Zendesk queue snapshot.</p>
                          </div>
                        </div>
                        <span className="brand-chip">{omniOneTickets.length} tickets</span>
                      </div>
                      <TicketTable
                        rows={omniOneTickets}
                        loading={ticketsLoading}
                        error={ticketsError}
                        selectedIds={selectedTicketIds}
                        onSelectionChange={setSelection}
                        onSelectAllVisible={setSelectionForMany}
                        onOpenTicket={openTicket}
                        onGenerateDigest={handleGenerateDigest}
                        generatingDigest={generatingDigest}
                      />
                    </section>

                    <section className="surface-panel space-y-4 p-5 md:p-6">
                      <div className="flex items-center justify-between border-b border-border/55 pb-3">
                        <div className="flex items-center gap-3">
                          <span className="brand-logo-shell h-10 min-w-[84px] px-3">
                            <img src={omniArenaLogo} alt="Omni Arena" className="h-[16px] w-auto" />
                          </span>
                          <div>
                            <p className="text-base font-semibold tracking-tight">Omni Arena</p>
                            <p className="mt-1 text-sm text-muted-foreground">Zendesk queue snapshot.</p>
                          </div>
                        </div>
                        <span className="brand-chip">{omniArenaTickets.length} tickets</span>
                      </div>
                      <TicketTable
                        rows={omniArenaTickets}
                        loading={ticketsLoading}
                        error={ticketsError}
                        selectedIds={selectedTicketIds}
                        onSelectionChange={setSelection}
                        onSelectAllVisible={setSelectionForMany}
                        onOpenTicket={openTicket}
                        onGenerateDigest={handleGenerateDigest}
                        generatingDigest={generatingDigest}
                      />
                    </section>

                    <section className="surface-panel space-y-4 p-5 md:p-6 2xl:col-span-2">
                      <div className="flex items-center justify-between border-b border-border/55 pb-3">
                        <div className="flex items-center gap-3">
                          <span className="brand-logo-shell h-10 min-w-[84px] px-3">
                            <img src={omniArenaLogo} alt="Omni Arena" className="h-[16px] w-auto" />
                          </span>
                          <div>
                            <p className="text-base font-semibold tracking-tight">Arena Sites</p>
                            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                              Filter and search venue coverage status without leaving the ticket workspace.
                            </p>
                          </div>
                        </div>
                        <span className="brand-chip">{sites.length} venues</span>
                      </div>
                      <ArenaSitesTable sites={sites} loading={sitesLoading} error={sitesError} />
                    </section>
                  </section>
                </>
              )}
            </PaneErrorBoundary>
          </section>
        </div>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[320px] sm:w-[360px] p-0">
          <div className="h-full p-4">
            <SideNavigation
              userEmail={userEmail}
              onSignOut={() => void handleSignOut()}
              onNavigate={() => setMobileNavOpen(false)}
              routes={routeTabs}
              allTicketCount={allTicketCount}
              activeBacklogCount={activeBacklogCount}
              lastSync={lastSync}
            />
          </div>
        </SheetContent>
      </Sheet>

      <CopilotChatDock onAsk={handleCopilotAsk} onCitationClick={handleCopilotCitationClick} />

      <TicketDrawer
        open={ticketDrawerOpen}
        onOpenChange={setTicketDrawerOpen}
        ticket={activeTicket}
        summary={activeSummary}
        loading={activeTicket ? summaryLoadingTicketId === activeTicket.ticket_id : false}
        onRefreshSummary={async (refresh) => {
          if (!activeTicket) return;
          await refreshTicketSummary(activeTicket.ticket_id, refresh);
        }}
        onSendToSlack={async () => {
          if (!activeTicket) return;
          await sendTicketSummaryToSlack(activeTicket.ticket_id);
        }}
        onCopy={async () => {
          if (!activeTicket) return;
          await copyTicketSummary(activeTicket, activeSummary);
        }}
      />
    </main>
  );
}
