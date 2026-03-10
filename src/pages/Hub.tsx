import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { CalendarDays, Copy, Download, ExternalLink, FileText, Loader2, Menu, RefreshCw, Search, Send, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ArenaSitesTable } from "@/components/schedule/ArenaSitesTable";
import { CopilotChatDock, type CopilotChatInputMessage } from "@/components/hub/CopilotChatDock";
import { getArenaSites, type ArenaSite } from "@/lib/scheduleData";
import { useToast } from "@/hooks/use-toast";
import type {
  CopilotCitation,
  CopilotChatResponse,
  CreateDigestResponse,
  Digest,
  HubAnalyticsBaselineRow,
  HubAnalyticsTrackResponse,
  SemanticSearchDocumentResult,
  SemanticSearchDocumentsResponse,
  SendToSlackResponse,
  SummarizeTicketResponse,
  SyncZendeskResponse,
  Ticket,
  TicketDataCoverageRow,
  TicketReceivedRollupRow,
  TicketSummary,
  WeeklyTicketReportDispatchResponse,
  WeeklyTicketReportRow,
} from "@/types/support";
import virtuixLogoWhite from "@/assets/virtuix_logo_white.png";
import omniOneSquareLogo from "@/assets/omnione_logo_square.png";
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

const ACTIVE_TICKET_STATUSES = new Set(["new", "open", "pending"]);

type ParsedImportedVenueRow = {
  venue: string;
  totalPlays: number;
  uniquePlayers: number;
};

type ImportedVenueSummary = {
  venue: string;
  totalPlays: number;
  uniquePlayers: number;
  playsPerPlayer: number;
};

type ImportedMetricSummary = {
  key: "total_plays" | "total_unique_players" | "total_venues" | "avg_plays_per_venue" | "avg_unique_per_venue" | "avg_plays_per_player";
  label: string;
  value: number;
  format: "integer" | "decimal";
  subtitle: string;
};

type ImportedSqlReport = {
  totalParsedRows: number;
  skippedRows: number;
  totalPlays: number;
  totalUniquePlayers: number;
  venueCount: number;
  averagePlaysPerVenue: number;
  averageUniquePlayersPerVenue: number;
  averagePlaysPerPlayer: number;
  venues: ImportedVenueSummary[];
  topVenues: ImportedVenueSummary[];
  metricSummaries: ImportedMetricSummary[];
};

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

function formatSignedRateDelta(rateDelta: number): string {
  const points = rateDelta * 100;
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

function getWeeklyCardToneClass(brand: string): string {
  switch (brand) {
    case "total":
      return "from-primary/14 to-primary/8 hover:from-primary/22 hover:to-primary/12";
    case "omni_one":
      return "from-primary/12 to-emerald-500/8 hover:from-primary/20 hover:to-emerald-500/12";
    case "omni_arena":
      return "from-primary/10 to-lime-500/8 hover:from-primary/18 hover:to-lime-500/12";
    default:
      return "from-primary/8 to-primary/5 hover:from-primary/16 hover:to-primary/10";
  }
}

function getRollupCardToneClass(period: string): string {
  switch (period) {
    case "month":
      return "from-primary/12 to-emerald-500/9 hover:from-primary/20 hover:to-emerald-500/14";
    case "quarter":
      return "from-primary/12 to-lime-500/9 hover:from-primary/20 hover:to-lime-500/14";
    case "year":
      return "from-primary/12 to-green-500/9 hover:from-primary/20 hover:to-green-500/14";
    default:
      return "from-primary/10 to-primary/8 hover:from-primary/18 hover:to-primary/12";
  }
}

function getSqlImportMetricToneClass(key: ImportedMetricSummary["key"]): string {
  switch (key) {
    case "total_plays":
      return "from-primary/14 to-primary/9 hover:from-primary/22 hover:to-primary/14";
    case "total_unique_players":
      return "from-primary/12 to-emerald-500/10 hover:from-primary/20 hover:to-emerald-500/16";
    case "total_venues":
      return "from-primary/12 to-lime-500/10 hover:from-primary/20 hover:to-lime-500/16";
    case "avg_plays_per_venue":
      return "from-primary/11 to-green-500/9 hover:from-primary/19 hover:to-green-500/14";
    case "avg_unique_per_venue":
      return "from-primary/10 to-teal-500/9 hover:from-primary/18 hover:to-teal-500/14";
    case "avg_plays_per_player":
      return "from-primary/11 to-emerald-400/10 hover:from-primary/19 hover:to-emerald-400/15";
    default:
      return "from-primary/10 to-primary/8 hover:from-primary/18 hover:to-primary/12";
  }
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = index + 1 < line.length ? line[index + 1] : "";

    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function detectDelimiter(headerLine: string): string {
  const tabCount = (headerLine.match(/\t/g) || []).length;
  const commaCount = (headerLine.match(/,/g) || []).length;
  if (tabCount > 0 && tabCount >= commaCount) return "\t";
  return ",";
}

function normalizeHeaderKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  const normalizedCandidates = new Set(candidates.map((candidate) => normalizeHeaderKey(candidate)));
  return headers.findIndex((header) => normalizedCandidates.has(normalizeHeaderKey(header)));
}

function parseImportNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMetricValue(metric: ImportedMetricSummary): string {
  if (metric.format === "integer") {
    return Math.round(metric.value).toLocaleString();
  }
  return metric.value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseImportedVenueRows(rawInput: string): {
  rows: ParsedImportedVenueRow[];
  rowCount: number;
  skippedRows: number;
} {
  const normalizedInput = rawInput
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!normalizedInput) {
    throw new Error("Paste SQL export rows (CSV/TSV) first.");
  }

  const lines = normalizedInput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    throw new Error("Need at least a header row and one data row.");
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitDelimitedLine(lines[0], delimiter);

  const venueIndex = findHeaderIndex(headers, [
    "venue",
    "name",
    "shop_name",
    "shop",
    "location",
    "site",
  ]);
  const totalPlaysIndex = findHeaderIndex(headers, [
    "total_plays",
    "totalplays",
    "total plays",
    "plays",
    "play_count",
    "playcount",
    "sessions",
    "total_sessions",
  ]);
  const uniquePlayersIndex = findHeaderIndex(headers, [
    "unique_players",
    "uniqueplayers",
    "unique players",
    "players",
    "distinct_players",
    "distinctplayers",
  ]);

  if (venueIndex < 0 || totalPlaysIndex < 0 || uniquePlayersIndex < 0) {
    throw new Error("Could not find required columns. Required headers: Venue, Total_Plays, Unique_Players.");
  }

  const rows: ParsedImportedVenueRow[] = [];
  let skippedRows = 0;

  for (const line of lines.slice(1)) {
    const values = splitDelimitedLine(line, delimiter);
    if (values.length === 0) continue;
    const venue = (values[venueIndex] || "").trim();
    const totalPlays = parseImportNumber(values[totalPlaysIndex] || "");
    const uniquePlayers = parseImportNumber(values[uniquePlayersIndex] || "");

    if (!venue || totalPlays === null || uniquePlayers === null) {
      skippedRows += 1;
      continue;
    }

    rows.push({
      venue,
      totalPlays,
      uniquePlayers,
    });
  }

  if (rows.length === 0) {
    throw new Error("No valid rows found. Confirm headers are Venue, Total_Plays, Unique_Players.");
  }

  return {
    rows,
    rowCount: rows.length,
    skippedRows,
  };
}

function buildImportedSqlReport(
  rows: ParsedImportedVenueRow[],
  skippedRows: number,
): ImportedSqlReport {
  const venues = rows
    .map((row) => {
      const playsPerPlayer = row.uniquePlayers > 0 ? row.totalPlays / row.uniquePlayers : 0;
      return {
        venue: row.venue,
        totalPlays: row.totalPlays,
        uniquePlayers: row.uniquePlayers,
        playsPerPlayer,
      };
    })
    .sort((a, b) => b.totalPlays - a.totalPlays);

  const totalPlays = venues.reduce((sum, row) => sum + row.totalPlays, 0);
  const totalUniquePlayers = venues.reduce((sum, row) => sum + row.uniquePlayers, 0);
  const venueCount = venues.length;
  const averagePlaysPerVenue = venueCount > 0 ? totalPlays / venueCount : 0;
  const averageUniquePlayersPerVenue = venueCount > 0 ? totalUniquePlayers / venueCount : 0;
  const averagePlaysPerPlayer = totalUniquePlayers > 0 ? totalPlays / totalUniquePlayers : 0;

  const metricSummaries: ImportedMetricSummary[] = [
    {
      key: "total_plays",
      label: "Total Plays",
      value: totalPlays,
      format: "integer",
      subtitle: "All sessions in the pasted dataset",
    },
    {
      key: "total_unique_players",
      label: "Unique Players",
      value: totalUniquePlayers,
      format: "integer",
      subtitle: "Distinct players aggregated by venue",
    },
    {
      key: "total_venues",
      label: "Venues",
      value: venueCount,
      format: "integer",
      subtitle: "Total locations in this report",
    },
    {
      key: "avg_plays_per_venue",
      label: "Avg Plays / Venue",
      value: averagePlaysPerVenue,
      format: "decimal",
      subtitle: "Average session volume per location",
    },
    {
      key: "avg_unique_per_venue",
      label: "Avg Unique / Venue",
      value: averageUniquePlayersPerVenue,
      format: "decimal",
      subtitle: "Average unique players per location",
    },
    {
      key: "avg_plays_per_player",
      label: "Plays / Player",
      value: averagePlaysPerPlayer,
      format: "decimal",
      subtitle: "Average sessions per unique player",
    },
  ];

  return {
    totalParsedRows: rows.length,
    skippedRows,
    totalPlays,
    totalUniquePlayers,
    venueCount,
    averagePlaysPerVenue,
    averageUniquePlayersPerVenue,
    averagePlaysPerPlayer,
    venues,
    topVenues: venues.slice(0, 10),
    metricSummaries,
  };
}

function formatDecimalValue(value: number, digits = 2): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function buildImportedSqlSummary(report: ImportedSqlReport): string {
  const lines: string[] = [
    "Imported Venue Performance Report",
    `${report.totalParsedRows} venues parsed${report.skippedRows > 0 ? `, ${report.skippedRows} skipped row(s)` : ""}.`,
    `Total Plays: ${Math.round(report.totalPlays).toLocaleString()}`,
    `Unique Players: ${Math.round(report.totalUniquePlayers).toLocaleString()}`,
    `Venue Count: ${Math.round(report.venueCount).toLocaleString()}`,
    `Avg Plays / Venue: ${formatDecimalValue(report.averagePlaysPerVenue)}`,
    `Avg Unique / Venue: ${formatDecimalValue(report.averageUniquePlayersPerVenue)}`,
    `Avg Plays / Player: ${formatDecimalValue(report.averagePlaysPerPlayer)}`,
  ];

  lines.push("");
  lines.push("Top Venues by Total Plays:");
  report.topVenues.forEach((venue, index) => {
    lines.push(
      `${index + 1}. ${venue.venue} - ${Math.round(venue.totalPlays).toLocaleString()} plays, ${Math.round(venue.uniquePlayers).toLocaleString()} unique (${formatDecimalValue(venue.playsPerPlayer)} plays/player)`,
    );
  });

  return lines.join("\n");
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

function SideNavigation({
  userEmail,
  onSignOut,
  onNavigate,
}: {
  userEmail: string;
  onSignOut: () => void;
  onNavigate: () => void;
}) {
  const linkClasses =
    "rounded-xl border border-transparent px-3.5 py-2.5 text-[14px] font-medium text-muted-foreground transition hover:border-border/75 hover:bg-muted/45 hover:text-foreground";
  const activeClasses = "border-primary/40 bg-primary/12 text-primary";

  return (
    <div className="flex h-full flex-col surface-panel p-4">
      <div className="mb-5 flex items-center gap-2">
        <img src={virtuixLogoWhite} alt="Virtuix" className="h-6 w-auto" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Support Hub</span>
      </div>
      <nav className="flex flex-col gap-2">
        <NavLink
          to="/hub"
          end
          onClick={onNavigate}
          className={({ isActive }) => `${linkClasses} ${isActive ? activeClasses : ""}`}
        >
          Ticket Operations
        </NavLink>
        <NavLink
          to="/hub/digests"
          onClick={onNavigate}
          className={({ isActive }) => `${linkClasses} ${isActive ? activeClasses : ""}`}
        >
          Digests
        </NavLink>
        <NavLink
          to="/hub/documents"
          onClick={onNavigate}
          className={({ isActive }) => `${linkClasses} ${isActive ? activeClasses : ""}`}
        >
          Documents
        </NavLink>
        <NavLink
          to="/hub/reports"
          onClick={onNavigate}
          className={({ isActive }) => `${linkClasses} ${isActive ? activeClasses : ""}`}
        >
          Reports
        </NavLink>
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

  const visibleIds = filteredRows.map((row) => row.ticket_id);
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const selectedTotalCount = selectedIds.size;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

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
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search subject or requester..."
            className="h-9 w-full sm:w-[260px]"
          />
          {(["all", "open", "pending", "new"] as const).map((status) => (
            <Button
              key={status}
              variant={statusFilter === status ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter(status)}
              className="capitalize"
            >
              {status}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {selectedTotalCount > 0 ? `${selectedTotalCount} selected` : `${filteredRows.length} in view`}
          </span>
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
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Key Actions</p>
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

            <div className="overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-b from-[#171d12] via-[#111610] to-[#0c100b] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
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
    () => SUPPORT_DOCUMENTS_BRANDS.flatMap((brand) => documentsByBrand[brand] || []),
    [documentsByBrand],
  );
  const activeDocuments = documentsByBrand[activeBrand] || [];
  const activeFolderOptions = useMemo(
    () => getFolderOptionsForBrand(activeDocuments, activeBrand),
    [activeBrand, activeDocuments],
  );
  const filteredDocuments = useMemo(
    () => filterDocumentsByFolder(activeDocuments, activeBrand, activeTopLevelFolder),
    [activeBrand, activeDocuments, activeTopLevelFolder],
  );
  const selectedDocument = allDocuments.find((document) => document.path === selectedDocumentPath) || null;
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

        <div className="mb-4 flex flex-wrap gap-2">
          {SUPPORT_DOCUMENTS_BRANDS.map((brand) => (
            <Button
              key={brand}
              size="sm"
              variant={activeBrand === brand ? "secondary" : "ghost"}
              className={`h-10 gap-0 px-2.5 ${brand === "omni_arena" ? "min-w-[108px]" : "min-w-[72px]"}`}
              aria-label={brandMeta[brand].label}
              title={brandMeta[brand].label}
              onClick={() => onSelectBrand(brand)}
            >
              <img
                src={brandMeta[brand].logo}
                alt={brandMeta[brand].label}
                className={`w-auto shrink-0 object-contain ${brand === "omni_arena" ? "h-[18px]" : "h-5"}`}
              />
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
                  className="w-full rounded-lg border border-border/70 bg-background/50 px-3 py-3 text-left transition hover:border-primary/35 hover:bg-muted/35"
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
                  "w-full rounded-xl border border-border/70 bg-background/45 px-3 py-2 text-left transition",
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
  analyticsBaseline,
  analyticsBaselineLoading,
  analyticsBaselineError,
  coverage,
  coverageLoading,
  coverageError,
  loading,
  error,
  weekStartDate,
  rollupReferenceDate,
  onWeekStartDateChange,
  onRollupReferenceDateChange,
  onRefresh,
  onRefreshReceivedRollup,
  onCopySummary,
  onCopyReceivedRollupSummary,
  dispatchPreview,
  dispatchLoading,
  onPreviewDispatch,
  onSendDispatch,
  onClearDispatchPreview,
  onTrackEvent,
}: {
  rows: WeeklyTicketReportRow[];
  previousRows: WeeklyTicketReportRow[];
  receivedRollupRows: TicketReceivedRollupRow[];
  receivedRollupLoading: boolean;
  receivedRollupError: string | null;
  analyticsBaseline: HubAnalyticsBaselineRow | null;
  analyticsBaselineLoading: boolean;
  analyticsBaselineError: string | null;
  coverage: TicketDataCoverageRow | null;
  coverageLoading: boolean;
  coverageError: string | null;
  loading: boolean;
  error: string | null;
  weekStartDate: string;
  rollupReferenceDate: string;
  onWeekStartDateChange: (value: string) => void;
  onRollupReferenceDateChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onRefreshReceivedRollup: () => Promise<void>;
  onCopySummary: () => Promise<void>;
  onCopyReceivedRollupSummary: () => Promise<void>;
  dispatchPreview: string | null;
  dispatchLoading: boolean;
  onPreviewDispatch: () => Promise<void>;
  onSendDispatch: () => Promise<void>;
  onClearDispatchPreview: () => void;
  onTrackEvent?: (eventName: string, metadata?: Record<string, unknown>) => void;
}) {
  const labels: Record<string, string> = {
    total: "Total",
    omni_one: "Omni One",
    omni_arena: "Omni Arena",
    other: "Other Brands",
  };
  const periodLabels: Record<string, string> = {
    month: "Monthly",
    quarter: "Quarterly",
    year: "Yearly",
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

  const orderedPeriods = ["month", "quarter", "year"];
  const orderedBrands = ["total", "omni_one", "omni_arena", "other"];
  const receivedRollupMap = useMemo(() => {
    return new Map(receivedRollupRows.map((row) => [`${row.period_type}:${row.brand}`, row]));
  }, [receivedRollupRows]);

  const receivedRollupTotals = useMemo(() => {
    return orderedPeriods
      .map((period) => receivedRollupMap.get(`${period}:total`) || null)
      .filter((row): row is TicketReceivedRollupRow => row !== null);
  }, [receivedRollupMap]);
  const [activeWeeklyBrand, setActiveWeeklyBrand] = useState<string>("total");
  const [activeRollupPeriod, setActiveRollupPeriod] = useState<string>("month");
  const [sqlImportInput, setSqlImportInput] = useState("");
  const [sqlImportReport, setSqlImportReport] = useState<ImportedSqlReport | null>(null);
  const [sqlImportError, setSqlImportError] = useState<string | null>(null);

  useEffect(() => {
    if (sortedRows.length === 0) return;
    if (!sortedRows.some((row) => row.brand === activeWeeklyBrand)) {
      setActiveWeeklyBrand(sortedRows[0].brand);
    }
  }, [activeWeeklyBrand, sortedRows]);

  useEffect(() => {
    if (receivedRollupTotals.length === 0) return;
    if (!receivedRollupTotals.some((row) => row.period_type === activeRollupPeriod)) {
      setActiveRollupPeriod(receivedRollupTotals[0].period_type);
    }
  }, [activeRollupPeriod, receivedRollupTotals]);

  function handleGenerateImportedSqlReport() {
    setSqlImportError(null);

    try {
      const parsed = parseImportedVenueRows(sqlImportInput);
      const report = buildImportedSqlReport(parsed.rows, parsed.skippedRows);
      setSqlImportReport(report);
      onTrackEvent?.("sql_import_report_generated", {
        parsed_rows: parsed.rowCount,
        skipped_rows: parsed.skippedRows,
        venue_count: report.venueCount,
        total_plays: report.totalPlays,
        unique_players: report.totalUniquePlayers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse imported SQL rows.";
      setSqlImportReport(null);
      setSqlImportError(message);
      onTrackEvent?.("sql_import_report_failed", { message });
    }
  }

  async function handleCopyImportedSqlSummary() {
    if (!sqlImportReport) return;

    try {
      await navigator.clipboard.writeText(buildImportedSqlSummary(sqlImportReport));
      onTrackEvent?.("sql_import_summary_copied", {
        venue_count: sqlImportReport.venueCount,
        total_plays: sqlImportReport.totalPlays,
      });
    } catch {
      // no-op, caller UI already communicates clipboard failures elsewhere
    }
  }

  const coverageStartDate = coverage?.earliest_created_at?.slice(0, 10) || null;
  const coverageEndDate = coverage?.latest_created_at?.slice(0, 10) || null;
  const weeklyBeforeCoverage = coverageStartDate ? weekStartDate < coverageStartDate : false;
  const weeklyAfterCoverage = coverageEndDate ? weekStartDate > coverageEndDate : false;
  const rollupBeforeCoverage = coverageStartDate ? rollupReferenceDate < coverageStartDate : false;
  const rollupAfterCoverage = coverageEndDate ? rollupReferenceDate > coverageEndDate : false;

  return (
    <section className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)] 2xl:grid-cols-[420px_minmax(0,1fr)]">
      <div className="surface-panel p-5 space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Weekly Ticket Report</h2>
          <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
            Received vs solved/closed vs still open. Spam/deleted tickets are excluded.
          </p>
        </div>

        <div className="surface-panel-soft p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Data Coverage</p>
          {coverageLoading ? <p className="mt-2 text-[13px] text-muted-foreground">Checking coverage...</p> : null}
          {!coverageLoading && coverageError ? <p className="mt-2 text-[13px] text-destructive">{coverageError}</p> : null}
          {!coverageLoading && !coverageError && coverage ? (
            <div className="mt-2 space-y-1.5 text-[13px] leading-5">
              <p>
                Range: {coverage.earliest_created_at ? formatDateShort(coverage.earliest_created_at) : "-"} to{" "}
                {coverage.latest_created_at ? formatDateShort(coverage.latest_created_at) : "-"}
              </p>
              <p className="text-muted-foreground">
                {coverage.tickets_with_created_at} tickets with created date, {coverage.tickets_missing_created_at} missing created date.
              </p>
              {coverage.latest_sync_status ? (
                <p className="text-muted-foreground">
                  Latest sync: {coverage.latest_sync_status}
                  {coverage.latest_sync_finished_at ? ` at ${formatDateTime(coverage.latest_sync_finished_at)}` : ""}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="surface-panel-soft p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Hub Analytics (Last 14 Days)</p>
          {analyticsBaselineLoading ? <p className="mt-2 text-[13px] text-muted-foreground">Loading baseline metrics...</p> : null}
          {!analyticsBaselineLoading && analyticsBaselineError ? (
            <p className="mt-2 text-[13px] text-destructive">{analyticsBaselineError}</p>
          ) : null}
          {!analyticsBaselineLoading && !analyticsBaselineError && analyticsBaseline ? (
            <div className="mt-2 space-y-1.5 text-[13px] leading-5">
              <p>
                Window: {formatDateShort(analyticsBaseline.period_start_date)} - {formatDateShort(analyticsBaseline.period_end_date)}
              </p>
              <p className="text-muted-foreground">{analyticsBaseline.total_events} events from {analyticsBaseline.unique_users} active users.</p>
              <p className="text-muted-foreground">
                Copilot queries: {analyticsBaseline.copilot_queries} | Citation clicks: {analyticsBaseline.citation_clicks}
              </p>
              <p className="text-muted-foreground">
                Weekly refreshes: {analyticsBaseline.weekly_reports_refreshed} | M/Q/Y refreshes: {analyticsBaseline.rollup_reports_refreshed}
              </p>
              <p className="text-muted-foreground">SQL reports generated: {analyticsBaseline.sql_reports_generated}</p>
            </div>
          ) : null}
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
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => void onCopySummary()}
            disabled={loading || sortedRows.length === 0}
          >
            <Copy className="mr-2 h-4 w-4" />
            Copy Weekly Summary
          </Button>
          {weeklyBeforeCoverage ? (
            <p className="text-[12px] leading-5 text-amber-500">
              Selected week starts before available data ({coverageStartDate}).
            </p>
          ) : null}
          {weeklyAfterCoverage ? (
            <p className="text-[12px] leading-5 text-amber-500">
              Selected week starts after latest available ticket date ({coverageEndDate}).
            </p>
          ) : null}
        </div>

        <div className="surface-panel-soft p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Period</p>
          <p className="mt-1 text-[15px] font-medium">{periodLabel || "-"}</p>
          {previousPeriodLabel ? (
            <p className="mt-1 text-[12px] text-muted-foreground">Compared to: {previousPeriodLabel}</p>
          ) : null}
          {totalRow ? (
            <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
              {totalRow.received_count} received, {totalRow.solved_closed_count} solved/closed, {totalRow.still_open_count} still open.
            </p>
          ) : null}
        </div>

        <div className="surface-panel-soft space-y-2 p-3">
          <label htmlFor="rollup-reference-date" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Intake Search Date
          </label>
          <div className="relative">
            <Input
              id="rollup-reference-date"
              type="date"
              value={rollupReferenceDate}
              onChange={(event) => onRollupReferenceDateChange(event.target.value)}
              className="report-date-input pr-10"
            />
            <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary/85" />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void onRefreshReceivedRollup()}
            disabled={receivedRollupLoading}
          >
            {receivedRollupLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            Refresh M/Q/Y Search
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => void onCopyReceivedRollupSummary()}
            disabled={receivedRollupLoading || receivedRollupRows.length === 0}
          >
            <Copy className="mr-2 h-4 w-4" />
            Copy M/Q/Y Summary
          </Button>
          <p className="text-[12px] leading-5 text-muted-foreground">
            Returns ticket intake counts for current month, quarter, and year anchored to this date.
          </p>
          {rollupBeforeCoverage ? (
            <p className="text-[12px] leading-5 text-amber-500">
              Reference date is before available data ({coverageStartDate}).
            </p>
          ) : null}
          {rollupAfterCoverage ? (
            <p className="text-[12px] leading-5 text-amber-500">
              Reference date is after latest available ticket date ({coverageEndDate}).
            </p>
          ) : null}
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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-4">
              {sortedRows.map((row) => (
                (() => {
                  const previous = previousRowsByBrand.get(row.brand);
                  const receivedDelta = previous ? row.received_count - previous.received_count : null;
                  const solvedDelta = previous ? row.solved_closed_count - previous.solved_closed_count : null;
                  const openDelta = previous ? row.still_open_count - previous.still_open_count : null;
                  const rateDelta = previous ? row.resolution_rate - previous.resolution_rate : null;

                  return (
                    <button
                      key={row.brand}
                      type="button"
                      onClick={() => setActiveWeeklyBrand(row.brand)}
                      className={[
                        "rounded-xl border p-4 text-left transition-all duration-200",
                        "bg-gradient-to-br",
                        getWeeklyCardToneClass(row.brand),
                        activeWeeklyBrand === row.brand
                          ? "border-primary/75 bg-primary/12 shadow-[0_18px_36px_-24px_hsl(var(--primary)/0.98)] ring-1 ring-primary/45"
                          : "border-border/65 hover:-translate-y-0.5 hover:border-primary/70 hover:shadow-[0_16px_34px_-24px_hsl(var(--primary)/0.92)]",
                      ].join(" ")}
                      aria-pressed={activeWeeklyBrand === row.brand}
                    >
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {labels[row.brand] ?? row.brand}
                      </p>
                      <p className="mt-2 text-3xl font-semibold tracking-tight">{row.received_count}</p>
                      <p className="text-[12px] text-muted-foreground">received</p>
                      {previous ? (
                        <p className="mt-1 text-[12px] text-muted-foreground">
                          Prev {previous.received_count} ({formatSignedIntDelta(receivedDelta ?? 0)} WoW)
                        </p>
                      ) : null}
                      <div className="mt-3 space-y-1.5 text-[13px]">
                        <p>
                          <span className="text-muted-foreground">Solved/Closed:</span>{" "}
                          <span className="font-medium">{row.solved_closed_count}</span>
                          {previous ? (
                            <span className="text-muted-foreground"> ({formatSignedIntDelta(solvedDelta ?? 0)} WoW)</span>
                          ) : null}
                        </p>
                        <p>
                          <span className="text-muted-foreground">Still Open:</span>{" "}
                          <span className="font-medium">{row.still_open_count}</span>
                          {previous ? (
                            <span className="text-muted-foreground"> ({formatSignedIntDelta(openDelta ?? 0)} WoW)</span>
                          ) : null}
                        </p>
                        <p>
                          <span className="text-muted-foreground">Resolution Rate:</span>{" "}
                          <span className="font-medium">{(row.resolution_rate * 100).toFixed(1)}%</span>
                          {previous ? (
                            <span className="text-muted-foreground"> ({formatSignedRateDelta(rateDelta ?? 0)} WoW)</span>
                          ) : null}
                        </p>
                      </div>
                    </button>
                  );
                })()
              ))}
            </div>

            <div className="space-y-2 lg:hidden">
              {sortedRows.map((row) => {
                const previous = previousRowsByBrand.get(row.brand);
                return (
                  <article
                    key={`mobile-weekly-${row.brand}`}
                    className={[
                      "surface-panel-soft space-y-2 p-4",
                      activeWeeklyBrand === row.brand ? "border-primary/45 bg-primary/[0.11]" : "",
                    ].join(" ")}
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {labels[row.brand] ?? row.brand}
                    </p>
                    <p className="text-2xl font-semibold tracking-tight">{row.received_count}</p>
                    <div className="space-y-1 text-[13px] leading-5 text-muted-foreground">
                      <p>Solved/Closed: <span className="font-medium text-foreground">{row.solved_closed_count}</span></p>
                      <p>Still Open: <span className="font-medium text-foreground">{row.still_open_count}</span></p>
                      <p>Resolution Rate: <span className="font-medium text-foreground">{(row.resolution_rate * 100).toFixed(1)}%</span></p>
                      <p>
                        WoW Received:{" "}
                        <span className="font-medium text-foreground">
                          {previous ? formatSignedIntDelta(row.received_count - previous.received_count) : "-"}
                        </span>
                      </p>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="table-shell hidden lg:block">
              <table className="w-full text-[14px] md:text-[15px]">
                <thead className="bg-muted/55">
                  <tr>
                    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Brand</th>
                    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Received</th>
                    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">WoW Received</th>
                    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Solved/Closed</th>
                    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">WoW Solved</th>
                    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Still Open</th>
                    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">WoW Open</th>
                    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Resolution Rate</th>
                    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">WoW Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const previous = previousRowsByBrand.get(row.brand);
                    return (
                      <tr
                        key={`table-${row.brand}`}
                        className={[
                          "border-t border-border/35 transition-colors",
                          activeWeeklyBrand === row.brand ? "bg-primary/10" : "",
                        ].join(" ")}
                      >
                        <td className="px-4 py-3 font-medium">{labels[row.brand] ?? row.brand}</td>
                        <td className="px-4 py-3">{row.received_count}</td>
                        <td className="px-4 py-3">{previous ? formatSignedIntDelta(row.received_count - previous.received_count) : "-"}</td>
                        <td className="px-4 py-3">{row.solved_closed_count}</td>
                        <td className="px-4 py-3">{previous ? formatSignedIntDelta(row.solved_closed_count - previous.solved_closed_count) : "-"}</td>
                        <td className="px-4 py-3">{row.still_open_count}</td>
                        <td className="px-4 py-3">{previous ? formatSignedIntDelta(row.still_open_count - previous.still_open_count) : "-"}</td>
                        <td className="px-4 py-3">{(row.resolution_rate * 100).toFixed(1)}%</td>
                        <td className="px-4 py-3">{previous ? formatSignedRateDelta(row.resolution_rate - previous.resolution_rate) : "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="surface-panel-soft space-y-4 p-4">
              <div>
                <h3 className="text-lg font-semibold tracking-tight">Ticket Intake Search (M/Q/Y)</h3>
                <p className="text-[12px] leading-5 text-muted-foreground">
                  Received tickets only, excluding spam/deleted, with previous-period comparison.
                </p>
              </div>

              {receivedRollupLoading ? (
                <p className="text-sm text-muted-foreground">Loading monthly/quarterly/yearly intake...</p>
              ) : receivedRollupError ? (
                <p className="text-sm text-destructive">{receivedRollupError}</p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {receivedRollupTotals.map((row) => (
                      <button
                        key={`rollup-card-${row.period_type}`}
                        type="button"
                        onClick={() => setActiveRollupPeriod(row.period_type)}
                        className={[
                          "w-full rounded-xl border p-4 text-left transition-all duration-200",
                          "bg-gradient-to-br",
                          getRollupCardToneClass(row.period_type),
                          activeRollupPeriod === row.period_type
                            ? "border-primary/75 bg-primary/12 shadow-[0_18px_36px_-24px_hsl(var(--primary)/0.98)] ring-1 ring-primary/45"
                            : "border-border/65 hover:-translate-y-0.5 hover:border-primary/70 hover:shadow-[0_16px_34px_-24px_hsl(var(--primary)/0.92)]",
                        ].join(" ")}
                        aria-pressed={activeRollupPeriod === row.period_type}
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          {periodLabels[row.period_type] ?? row.period_type}
                        </p>
                        <p className="mt-2 text-3xl font-semibold tracking-tight">{row.received_count}</p>
                        <p className="text-[12px] text-muted-foreground">
                          {formatDateShort(row.period_start_date)} - {formatDateShort(row.period_end_date)}
                        </p>
                        <p className="mt-2 text-[12px] text-muted-foreground">
                          Prev {row.previous_received_count} ({formatSignedIntDelta(row.delta)} / {formatPercentDelta(row.delta_pct)} )
                        </p>
                      </button>
                    ))}
                  </div>

                  <div className="space-y-2 lg:hidden">
                    {orderedBrands.map((brand) => (
                      <article key={`rollup-mobile-${brand}`} className="surface-panel-soft p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          {labels[brand] ?? brand}
                        </p>
                        <div className="mt-2 grid grid-cols-3 gap-2">
                          {orderedPeriods.map((period) => {
                            const row = receivedRollupMap.get(`${period}:${brand}`) || null;
                            return (
                              <div
                                key={`rollup-mobile-cell-${brand}-${period}`}
                                className={[
                                  "rounded-lg border border-border/65 bg-background/50 px-2 py-2 text-[12px]",
                                  activeRollupPeriod === period ? "border-primary/45 bg-primary/[0.1]" : "",
                                ].join(" ")}
                              >
                                <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
                                  {periodLabels[period] ?? period}
                                </p>
                                {row ? (
                                  <>
                                    <p className="mt-1 font-semibold text-foreground">{row.received_count}</p>
                                    <p className="text-[11px] leading-4 text-muted-foreground">
                                      {formatSignedIntDelta(row.delta)} / {formatPercentDelta(row.delta_pct)}
                                    </p>
                                  </>
                                ) : (
                                  <p className="mt-1 text-muted-foreground">-</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </article>
                    ))}
                  </div>

                  <div className="table-shell hidden lg:block">
                    <table className="w-full text-[14px] md:text-[15px]">
                      <thead className="bg-muted/55">
                        <tr>
                          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Brand</th>
                          {orderedPeriods.map((period) => (
                            <th
                              key={`rollup-head-${period}`}
                              className={[
                                "px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
                                activeRollupPeriod === period ? "bg-primary/12 text-primary" : "",
                              ].join(" ")}
                            >
                              {periodLabels[period] ?? period}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {orderedBrands.map((brand) => (
                          <tr key={`rollup-row-${brand}`} className="border-t border-border/35">
                            <td className="px-4 py-3 font-medium">{labels[brand] ?? brand}</td>
                            {orderedPeriods.map((period) => {
                              const row = receivedRollupMap.get(`${period}:${brand}`) || null;
                              return (
                                <td key={`rollup-cell-${brand}-${period}`} className="px-4 py-3">
                                  {row ? (
                                    <div
                                      className={[
                                        "rounded-md px-2 py-1.5 leading-5 transition-colors",
                                        activeRollupPeriod === period ? "bg-primary/10" : "",
                                      ].join(" ")}
                                    >
                                      <p>{row.received_count}</p>
                                      <p className="text-[12px] text-muted-foreground">
                                        {formatSignedIntDelta(row.delta)} / {formatPercentDelta(row.delta_pct)}
                                      </p>
                                    </div>
                                  ) : (
                                    "-"
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
            </div>

            <div className="surface-panel-soft space-y-4 p-4">
              <div>
                <h3 className="text-lg font-semibold tracking-tight">SQL Import Report Builder</h3>
                <p className="text-[12px] leading-5 text-muted-foreground">
                  Paste HeidiSQL rows (CSV/TSV) with `Venue`, `Total_Plays`, and `Unique_Players` to generate a management-ready summary.
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="sql-import-input" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  SQL Export Rows
                </label>
                <Textarea
                  id="sql-import-input"
                  value={sqlImportInput}
                  onChange={(event) => setSqlImportInput(event.target.value)}
                  placeholder={"Venue\tTotal_Plays\tUnique_Players\nJake's Unlimited - Mesa\t1975\t294"}
                  className="min-h-[160px] resize-y bg-background/55"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={handleGenerateImportedSqlReport}>
                  <FileText className="mr-2 h-4 w-4" />
                  Generate Imported Report
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleCopyImportedSqlSummary()}
                  disabled={!sqlImportReport}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Imported Summary
                </Button>
              </div>

              {sqlImportError ? <p className="text-sm text-destructive">{sqlImportError}</p> : null}

              {sqlImportReport ? (
                <>
                  <p className="text-[12px] text-muted-foreground">
                    Parsed {sqlImportReport.totalParsedRows} venue rows.
                    {sqlImportReport.skippedRows > 0 ? ` ${sqlImportReport.skippedRows} rows were skipped due to missing/invalid values.` : ""}
                  </p>

                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {sqlImportReport.metricSummaries.map((metric) => (
                      <div
                        key={`sql-metric-${metric.key}`}
                        className={[
                          "rounded-xl border p-4 text-left transition-all duration-200",
                          "bg-gradient-to-br",
                          getSqlImportMetricToneClass(metric.key),
                          "border-border/65 hover:-translate-y-0.5 hover:border-primary/70 hover:shadow-[0_16px_34px_-24px_hsl(var(--primary)/0.92)]",
                        ].join(" ")}
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          {metric.label}
                        </p>
                        <p className="mt-2 text-3xl font-semibold tracking-tight">{formatMetricValue(metric)}</p>
                        <p className="mt-1 text-[12px] text-muted-foreground">{metric.subtitle}</p>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2 lg:hidden">
                    {sqlImportReport.topVenues.map((venue, index) => (
                      <article key={`sql-mobile-${index}-${venue.venue}`} className="surface-panel-soft p-4">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold">{index + 1}. {venue.venue}</p>
                          <span className="brand-chip">P/P {formatDecimalValue(venue.playsPerPlayer)}</span>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] text-muted-foreground">
                          <p>Total Plays: <span className="font-medium text-foreground">{Math.round(venue.totalPlays).toLocaleString()}</span></p>
                          <p>Unique Players: <span className="font-medium text-foreground">{Math.round(venue.uniquePlayers).toLocaleString()}</span></p>
                        </div>
                      </article>
                    ))}
                  </div>

                  <div className="table-shell hidden lg:block">
                    <table className="w-full text-[14px] md:text-[15px]">
                      <thead className="bg-muted/55">
                        <tr>
                          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">#</th>
                          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Venue</th>
                          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Total Plays</th>
                          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Unique Players</th>
                          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Plays / Player</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sqlImportReport.topVenues.map((venue, index) => (
                          <tr key={`sql-venue-${index}-${venue.venue}`} className="border-t border-border/35">
                            <td className="px-4 py-3">{index + 1}</td>
                            <td className="px-4 py-3 font-medium">{venue.venue}</td>
                            <td className="px-4 py-3">{Math.round(venue.totalPlays).toLocaleString()}</td>
                            <td className="px-4 py-3">{Math.round(venue.uniquePlayers).toLocaleString()}</td>
                            <td className="px-4 py-3">{formatDecimalValue(venue.playsPerPlayer)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </div>
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
  const [receivedRollupReferenceDate, setReceivedRollupReferenceDate] = useState(() => toIsoDateOnly(new Date()));
  const [ticketDataCoverage, setTicketDataCoverage] = useState<TicketDataCoverageRow | null>(null);
  const [ticketDataCoverageLoading, setTicketDataCoverageLoading] = useState(false);
  const [ticketDataCoverageError, setTicketDataCoverageError] = useState<string | null>(null);
  const [hubAnalyticsBaseline, setHubAnalyticsBaseline] = useState<HubAnalyticsBaselineRow | null>(null);
  const [hubAnalyticsBaselineLoading, setHubAnalyticsBaselineLoading] = useState(false);
  const [hubAnalyticsBaselineError, setHubAnalyticsBaselineError] = useState<string | null>(null);
  const [weeklyDispatchLoading, setWeeklyDispatchLoading] = useState(false);
  const [weeklyDispatchPreview, setWeeklyDispatchPreview] = useState<string | null>(null);

  const [generatingDigest, setGeneratingDigest] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const inDigestRoute = location.pathname === "/hub/digests";
  const inDocumentsRoute = location.pathname === "/hub/documents";
  const inReportsRoute = location.pathname === "/hub/reports";
  const inTicketRoute = !inDigestRoute && !inDocumentsRoute && !inReportsRoute;

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

          if (!collectedByPath.has(itemPath)) {
            collectedByPath.set(itemPath, {
              brand,
              path: itemPath,
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
        `${labels[brand] ?? brand}: received ${current.received_count} (WoW ${receivedDelta}), solved/closed ${current.solved_closed_count} (WoW ${solvedDelta}), still open ${current.still_open_count} (WoW ${openDelta}), resolution ${(current.resolution_rate * 100).toFixed(1)}% (WoW ${rateDelta}).`,
      );
    });

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast({ title: "Copied", description: "Weekly report summary copied." });
      void trackHubEvent("weekly_summary_copied", {
        start_date: weeklyReportStartDate,
        rows: weeklyReportRows.length,
      });
    } catch {
      toast({ title: "Copy failed", description: "Clipboard is not available.", variant: "destructive" });
    }
  }

  async function refreshReceivedRollup() {
    setReceivedRollupLoading(true);
    setReceivedRollupError(null);

    try {
      const { data, error } = await supabase.rpc("get_ticket_received_rollup", {
        reference_date: receivedRollupReferenceDate || null,
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
        reference_date: receivedRollupReferenceDate,
        rows: rows.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load monthly/quarterly/yearly intake.";
      setReceivedRollupError(message);
      setReceivedRollupRows([]);
      void trackHubEvent("received_rollup_refresh_failed", {
        reference_date: receivedRollupReferenceDate,
        message,
      });
    } finally {
      setReceivedRollupLoading(false);
    }
  }

  async function refreshTicketDataCoverage() {
    setTicketDataCoverageLoading(true);
    setTicketDataCoverageError(null);

    try {
      const { data, error } = await supabase.rpc("get_ticket_data_coverage");

      if (error) {
        throw new Error(error.message);
      }

      const row = Array.isArray(data) && data.length > 0 ? (data[0] as TicketDataCoverageRow) : null;
      if (!row) {
        setTicketDataCoverage(null);
        return;
      }

      const latestSyncCursor = toOptionalNumber(row.latest_sync_cursor);

      setTicketDataCoverage({
        ...row,
        total_tickets: Number(row.total_tickets || 0),
        tickets_with_created_at: Number(row.tickets_with_created_at || 0),
        tickets_missing_created_at: Number(row.tickets_missing_created_at || 0),
        latest_sync_cursor: latestSyncCursor === null ? null : latestSyncCursor,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load ticket data coverage.";
      setTicketDataCoverageError(message);
      setTicketDataCoverage(null);
    } finally {
      setTicketDataCoverageLoading(false);
    }
  }

  async function refreshHubAnalyticsBaseline() {
    setHubAnalyticsBaselineLoading(true);
    setHubAnalyticsBaselineError(null);

    try {
      const { data, error } = await supabase.rpc("get_hub_analytics_baseline", {
        period_days: 14,
      });

      if (error) {
        throw new Error(error.message);
      }

      const row = Array.isArray(data) && data.length > 0 ? data[0] as HubAnalyticsBaselineRow : null;
      if (!row) {
        setHubAnalyticsBaseline(null);
        return;
      }

      setHubAnalyticsBaseline({
        ...row,
        total_events: Number(row.total_events || 0),
        unique_users: Number(row.unique_users || 0),
        copilot_queries: Number(row.copilot_queries || 0),
        citation_clicks: Number(row.citation_clicks || 0),
        weekly_reports_refreshed: Number(row.weekly_reports_refreshed || 0),
        rollup_reports_refreshed: Number(row.rollup_reports_refreshed || 0),
        sql_reports_generated: Number(row.sql_reports_generated || 0),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load hub analytics baseline.";
      setHubAnalyticsBaselineError(message);
      setHubAnalyticsBaseline(null);
    } finally {
      setHubAnalyticsBaselineLoading(false);
    }
  }

  async function handleCopyReceivedRollupSummary() {
    if (receivedRollupRows.length === 0) {
      toast({ title: "No intake data", description: "Load the M/Q/Y search first.", variant: "destructive" });
      return;
    }

    const labels: Record<string, string> = {
      total: "Total",
      omni_one: "Omni One",
      omni_arena: "Omni Arena",
      other: "Other Brands",
    };
    const periodLabels: Record<string, string> = {
      month: "Monthly",
      quarter: "Quarterly",
      year: "Yearly",
    };
    const orderedPeriods = ["month", "quarter", "year"];
    const orderedBrands = ["total", "omni_one", "omni_arena", "other"];
    const byKey = new Map(receivedRollupRows.map((row) => [`${row.period_type}:${row.brand}`, row]));

    const lines: string[] = [
      `Ticket Intake Search Summary (reference date: ${formatDateShort(receivedRollupReferenceDate)})`,
      "Spam/deleted tickets excluded.",
      "",
    ];

    orderedPeriods.forEach((period) => {
      const total = byKey.get(`${period}:total`);
      if (!total) return;

      lines.push(
        `${periodLabels[period] ?? period} (${formatDateShort(total.period_start_date)} - ${formatDateShort(total.period_end_date)}): ${total.received_count} received, previous ${total.previous_received_count}, delta ${formatSignedIntDelta(total.delta)} (${formatPercentDelta(total.delta_pct)}).`,
      );
      orderedBrands.filter((brand) => brand !== "total").forEach((brand) => {
        const row = byKey.get(`${period}:${brand}`);
        if (!row) return;
        lines.push(
          `- ${labels[brand] ?? brand}: ${row.received_count} (prev ${row.previous_received_count}, delta ${formatSignedIntDelta(row.delta)} / ${formatPercentDelta(row.delta_pct)})`,
        );
      });
      lines.push("");
    });

    try {
      await navigator.clipboard.writeText(lines.join("\n").trim());
      toast({ title: "Copied", description: "M/Q/Y intake summary copied." });
      void trackHubEvent("received_rollup_summary_copied", {
        reference_date: receivedRollupReferenceDate,
        rows: receivedRollupRows.length,
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
        reference_date: receivedRollupReferenceDate || toIsoDateOnly(new Date()),
      });

      if (!payload.ok) {
        throw new Error(payload.error || "Failed to generate weekly dispatch preview.");
      }

      const preview = payload.preview_slack || payload.preview_text || "No preview content returned.";
      setWeeklyDispatchPreview(preview);
      toast({ title: "Preview ready", description: "Slack preview generated below." });
      void trackHubEvent("weekly_dispatch_preview_generated", {
        week_start: payload.week_start_date || weeklyReportStartDate,
        reference_date: payload.reference_date || receivedRollupReferenceDate,
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
        reference_date: receivedRollupReferenceDate || toIsoDateOnly(new Date()),
      });

      if (!payload.ok) {
        throw new Error(payload.error || "Weekly dispatch send failed.");
      }

      toast({ title: "Weekly dispatch sent", description: "Slack and email delivery were triggered." });
      setWeeklyDispatchPreview(null);
      void trackHubEvent("weekly_dispatch_sent_manual", {
        week_start: payload.week_start_date || weeklyReportStartDate,
        reference_date: payload.reference_date || receivedRollupReferenceDate,
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

    supabase.storage.from(SUPPORT_DOCUMENTS_BUCKET).createSignedUrl(selectedDocumentPath, 60 * 60 * 12)
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
    if (!authorized || !inReportsRoute) {
      return;
    }

    void refreshReceivedRollup();
  }, [authorized, inReportsRoute, refreshKey, receivedRollupReferenceDate]);

  useEffect(() => {
    if (!authorized) {
      setTicketDataCoverage(null);
      setTicketDataCoverageError(null);
      setTicketDataCoverageLoading(false);
      return;
    }

    if (!inReportsRoute) {
      return;
    }

    void refreshTicketDataCoverage();
  }, [authorized, inReportsRoute, refreshKey]);

  useEffect(() => {
    if (!authorized) {
      setHubAnalyticsBaseline(null);
      setHubAnalyticsBaselineError(null);
      setHubAnalyticsBaselineLoading(false);
      return;
    }

    if (!inReportsRoute) {
      return;
    }

    void refreshHubAnalyticsBaseline();
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
    setSelectedDocumentPath(file.path);
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
      const { data, error } = await supabase.storage.from(SUPPORT_DOCUMENTS_BUCKET).download(file.path);
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

  const allTicketCount = omniOneTickets.length + omniArenaTickets.length;
  const routeTabs = [
    { label: "Tickets", path: "/hub", active: inTicketRoute },
    { label: "Digests", path: "/hub/digests", active: inDigestRoute },
    { label: "Documents", path: "/hub/documents", active: inDocumentsRoute },
    { label: "Reports", path: "/hub/reports", active: inReportsRoute },
  ];

  if (loadingSession) {
    return (
      <main className="relative min-h-screen overflow-hidden bg-background">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(132,202,65,0.22),transparent_40%)]" />
        <div className="pointer-events-none absolute inset-0 ambient-grid opacity-[0.14]" />

        <div className="relative z-10 border-b border-border/50 bg-gradient-to-b from-primary/28 via-primary/10 to-transparent backdrop-blur-sm">
          <div className="container max-w-[2200px] px-4 py-4">
            <Link to="/" className="inline-flex items-center gap-3">
              <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
              <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
            </Link>
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
          <div className="container max-w-[2200px] px-4 py-4">
            <Link to="/" className="inline-flex items-center gap-3">
              <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
              <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
            </Link>
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
            <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
            <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden text-[12px] text-muted-foreground lg:inline">{userEmail}</span>
            <Button size="sm" variant="outline" className="gap-2" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
              <Menu className="h-4 w-4" />
              <span className="hidden sm:inline">Menu</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="container relative z-10 max-w-[2200px] px-4 py-6">
        <section className="space-y-5">
          <section className="surface-panel reveal-up relative overflow-hidden p-6 md:p-7">
            <div className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-primary/18 blur-3xl" />
            <div className="relative space-y-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1.5">
                  <p className="brand-kicker">Operations Console</p>
                  <h1 className="font-display text-3xl font-semibold leading-tight tracking-tight md:text-4xl">Support Hub</h1>
                  <p className="text-[15px] leading-6 text-muted-foreground md:text-[16px]">
                    {allTicketCount} cached tickets across Omni One and Omni Arena.
                  </p>
                  <p className="text-[12px] text-muted-foreground">
                    {lastSync?.finishedAt
                      ? `Last sync: ${new Date(lastSync.finishedAt).toLocaleString()} • Status: ${lastSync.status} • Updated: ${lastSync.ticketsUpserted}`
                      : "Last sync: not available yet"}
                  </p>
                  {syncMessage ? <p className="text-[12px] text-muted-foreground">{syncMessage}</p> : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
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
          </section>

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
              analyticsBaseline={hubAnalyticsBaseline}
              analyticsBaselineLoading={hubAnalyticsBaselineLoading}
              analyticsBaselineError={hubAnalyticsBaselineError}
              coverage={ticketDataCoverage}
              coverageLoading={ticketDataCoverageLoading}
              coverageError={ticketDataCoverageError}
              loading={weeklyReportLoading}
              error={weeklyReportError}
              weekStartDate={weeklyReportStartDate}
              rollupReferenceDate={receivedRollupReferenceDate}
              onWeekStartDateChange={setWeeklyReportStartDate}
              onRollupReferenceDateChange={setReceivedRollupReferenceDate}
              onRefresh={refreshWeeklyReport}
              onRefreshReceivedRollup={refreshReceivedRollup}
              onCopySummary={handleCopyWeeklySummary}
              onCopyReceivedRollupSummary={handleCopyReceivedRollupSummary}
              dispatchPreview={weeklyDispatchPreview}
              dispatchLoading={weeklyDispatchLoading}
              onPreviewDispatch={handlePreviewWeeklyDispatch}
              onSendDispatch={handleSendWeeklyDispatchNow}
              onClearDispatchPreview={() => setWeeklyDispatchPreview(null)}
              onTrackEvent={(eventName, metadata) => {
                void trackHubEvent(eventName, metadata ?? {});
              }}
            />
          ) : (
            <section className="grid gap-5 xl:gap-6 2xl:grid-cols-2">
              <section className="surface-panel space-y-4 p-5 md:p-6">
                <div className="flex items-center justify-between border-b border-border/55 pb-3">
                  <img src={omniOneLogo} alt="Omni One" className="h-7 w-auto" />
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
                  <img src={omniArenaLogo} alt="Omni Arena" className="h-7 w-auto" />
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
                  <div className="flex items-center gap-2">
                    <img src={omniArenaLogo} alt="Omni Arena" className="h-7 w-auto" />
                    <span className="text-sm text-muted-foreground">Sites</span>
                  </div>
                  <span className="brand-chip">{sites.length} venues</span>
                </div>
                <ArenaSitesTable sites={sites} loading={sitesLoading} error={sitesError} />
              </section>
            </section>
          )}
        </section>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[320px] sm:w-[360px] p-0">
          <div className="h-full p-4">
            <SideNavigation
              userEmail={userEmail}
              onSignOut={() => void handleSignOut()}
              onNavigate={() => setMobileNavOpen(false)}
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
