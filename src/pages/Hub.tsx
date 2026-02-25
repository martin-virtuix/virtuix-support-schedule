import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { Copy, Download, ExternalLink, FileText, Loader2, Menu, RefreshCw, Send, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ArenaSitesTable } from "@/components/schedule/ArenaSitesTable";
import { CopilotChatDock, type CopilotChatInputMessage } from "@/components/hub/CopilotChatDock";
import { getArenaSites, type ArenaSite } from "@/lib/scheduleData";
import { useToast } from "@/hooks/use-toast";
import type {
  CopilotChatResponse,
  CreateDigestResponse,
  Digest,
  SendToSlackResponse,
  SummarizeTicketResponse,
  SyncZendeskResponse,
  Ticket,
  TicketSummary,
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

function SideNavigation({ userEmail, onSignOut }: { userEmail: string; onSignOut: () => void }) {
  const linkClasses =
    "rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground";
  const activeClasses = "bg-muted text-foreground";

  return (
    <div className="flex h-full flex-col rounded-2xl border bg-card/60 p-4 backdrop-blur-sm">
      <div className="mb-4 flex items-center gap-2">
        <img src={virtuixLogoWhite} alt="Virtuix" className="h-6 w-auto" />
        <span className="text-xs text-muted-foreground">Support Hub</span>
      </div>
      <nav className="flex flex-col gap-1">
        <NavLink to="/hub" end className={({ isActive }) => `${linkClasses} ${isActive ? activeClasses : ""}`}>
          Ticket Operations
        </NavLink>
        <NavLink to="/hub/digests" className={({ isActive }) => `${linkClasses} ${isActive ? activeClasses : ""}`}>
          Digests
        </NavLink>
        <NavLink to="/hub/documents" className={({ isActive }) => `${linkClasses} ${isActive ? activeClasses : ""}`}>
          Documents
        </NavLink>
      </nav>
      <div className="mt-auto space-y-3">
        <p className="text-xs text-muted-foreground break-all">{userEmail}</p>
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
      <div className="flex flex-col gap-3 rounded-lg border bg-background/40 p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search subject or requester..."
            className="h-8 w-full sm:w-[260px]"
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

      <div className="overflow-x-auto rounded-xl border bg-card/80 backdrop-blur-sm">
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur-sm">
              <tr>
                <th className="px-3 py-2 text-left">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={(checked) => onSelectAllVisible(visibleIds, checked === true)}
                    aria-label="Select all visible tickets"
                  />
                </th>
                <th className="px-4 py-2 text-left">Ticket</th>
                <th className="px-4 py-2 text-left">Subject</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Requester</th>
                <th className="px-4 py-2 text-left">Updated</th>
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
                      <td className="px-4 py-2 font-medium whitespace-nowrap">#{row.ticket_id}</td>
                      <td className="px-4 py-2 min-w-[280px]">
                        <button className="text-left underline decoration-muted-foreground/40 hover:decoration-foreground" onClick={() => onOpenTicket(row)}>
                          {row.subject}
                        </button>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span
                          className={[
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide",
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
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{ticket ? `Ticket #${ticket.ticket_id}` : "Ticket"}</SheetTitle>
          <SheetDescription>{ticket?.subject || "No ticket selected"}</SheetDescription>
        </SheetHeader>

        {ticket ? (
          <div className="mt-6 space-y-4">
            <div className="grid gap-3 rounded-lg border bg-card/60 p-4 text-sm sm:grid-cols-2">
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

            <div className="rounded-lg border bg-background/50 p-4">
              <h3 className="mb-2 text-sm font-semibold">Summary</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
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
    <section className="grid gap-4 xl:h-[calc(100vh-15rem)] xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="rounded-2xl border bg-card/50 p-4 backdrop-blur-sm xl:flex xl:min-h-0 xl:h-full xl:flex-col">
        <h2 className="mb-3 text-sm font-semibold">Recent Digests</h2>
        {loading ? <p className="text-sm text-muted-foreground">Loading digests...</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!loading && !error ? (
          <div className="space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-auto pr-1">
            {digests.map((digest) => (
              <button
                key={digest.id}
                onClick={() => onSelectDigest(digest.id)}
                className={[
                  "w-full rounded-lg border px-3 py-2 text-left text-sm transition",
                  selectedDigestId === digest.id ? "bg-muted border-primary/40" : "hover:bg-muted/40",
                ].join(" ")}
              >
                <p className="font-medium">{digest.title}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(digest.created_at)} • {digest.ticket_ids.length} tickets</p>
              </button>
            ))}
            {digests.length === 0 ? <p className="text-sm text-muted-foreground">No digests yet.</p> : null}
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border bg-card/50 p-4 backdrop-blur-sm xl:flex xl:min-h-0 xl:h-full xl:flex-col">
        {selected ? (
          <div className="space-y-4 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">{selected.title}</h2>
                <p className="text-xs text-muted-foreground">{formatDateTime(selected.created_at)} • Source: {selected.source}</p>
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

            <div className="rounded-xl border border-primary/25 bg-gradient-to-b from-[#161616] to-[#0f0f0f] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] overflow-hidden xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
              <div className="border-b border-primary/20 px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary/90">
                Digest Result
              </div>
              <pre className="max-h-[75vh] overflow-y-auto px-5 py-5 text-sm md:text-[15px] leading-7 whitespace-pre-wrap font-sans text-foreground/95 xl:max-h-none xl:min-h-0 xl:flex-1">
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
  previewLoading,
  previewError,
  downloadingDocumentPath,
  onRefresh,
  onSelectBrand,
  onSelectTopLevelFolder,
  onSelectDocument,
  onDownloadDocument,
}: {
  documentsByBrand: Record<DocumentBrand, SupportDocument[]>;
  loading: boolean;
  error: string | null;
  activeBrand: DocumentBrand;
  activeTopLevelFolder: string | null;
  selectedDocumentPath: string | null;
  previewUrl: string | null;
  previewLoading: boolean;
  previewError: string | null;
  downloadingDocumentPath: string | null;
  onRefresh: () => Promise<void>;
  onSelectBrand: (brand: DocumentBrand) => void;
  onSelectTopLevelFolder: (folder: string | null) => void;
  onSelectDocument: (document: SupportDocument) => void;
  onDownloadDocument: (document: SupportDocument) => Promise<void>;
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

  return (
    <section className="grid gap-4 xl:h-[calc(100vh-15rem)] xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="rounded-2xl border bg-card/50 p-4 backdrop-blur-sm xl:flex xl:min-h-0 xl:h-full xl:flex-col">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Documents</h2>
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
              className="h-9 gap-2"
              onClick={() => onSelectBrand(brand)}
            >
              <img src={brandMeta[brand].logo} alt={brandMeta[brand].label} className="h-4 w-auto" />
              {brandMeta[brand].label}
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

        <p className="mb-3 text-xs text-muted-foreground">
          Bucket: <span className="font-medium text-foreground">{SUPPORT_DOCUMENTS_BUCKET}</span> • Expected folders:
          {" "}omni_one, omni_arena
        </p>

        <div className="xl:min-h-0 xl:flex-1 xl:overflow-auto space-y-2 pr-1">
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
                  "w-full rounded-lg border px-3 py-2 text-left transition",
                  selectedDocumentPath === document.path ? "bg-muted border-primary/40" : "hover:bg-muted/40",
                ].join(" ")}
                onClick={() => onSelectDocument(document)}
              >
                <div className="flex items-start gap-2">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{document.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Updated {formatDateTime(document.updatedAt)} • {formatFileSize(document.sizeBytes)}
                    </p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="rounded-2xl border bg-card/50 p-4 backdrop-blur-sm xl:flex xl:min-h-0 xl:h-full xl:flex-col">
        {selectedDocument ? (
          <div className="space-y-4 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">{selectedDocument.name}</h2>
                <p className="text-xs text-muted-foreground">Path: {selectedDocument.path}</p>
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
                {previewUrl ? (
                  <Button size="sm" variant="outline" asChild>
                    <a href={previewUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Open PDF
                    </a>
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="relative min-h-[68vh] overflow-hidden rounded-xl border bg-background/70 shadow-inner xl:min-h-0 xl:flex-1">
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

              {!previewLoading && !previewError && previewUrl ? (
                <iframe
                  key={previewUrl}
                  src={previewUrl}
                  title={`Preview ${selectedDocument.name}`}
                  className="h-[68vh] w-full xl:h-full"
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
  const [documentsPreviewLoading, setDocumentsPreviewLoading] = useState(false);
  const [downloadLoadingPath, setDownloadLoadingPath] = useState<string | null>(null);

  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [generatingDigest, setGeneratingDigest] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const inDigestRoute = location.pathname === "/hub/digests";
  const inDocumentsRoute = location.pathname === "/hub/documents";
  const inTicketRoute = !inDigestRoute && !inDocumentsRoute;

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
    const message = data.skipped ? data.reason || "Sync skipped." : `Sync completed. ${upserted} tickets updated.`;
    setSyncMessage(message);
    toast({ title: "Zendesk sync", description: message });
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
    setSelectedDocumentPath(getFirstDocumentPath(documentsByBrand, brand, documentsFolderByBrand[brand]));
  }

  function handleSelectDocumentsTopLevelFolder(folder: string | null) {
    setDocumentsFolderByBrand((previous) => ({ ...previous, [activeDocumentsBrand]: folder }));
    const matchingDocuments = filterDocumentsByFolder(documentsByBrand[activeDocumentsBrand] || [], activeDocumentsBrand, folder);
    setSelectedDocumentPath(matchingDocuments[0]?.path || null);
  }

  function handleSelectDocument(file: SupportDocument) {
    setActiveDocumentsBrand(file.brand);
    setSelectedDocumentPath(file.path);
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

  async function handleCopilotAsk(messages: CopilotChatInputMessage[]): Promise<string> {
    const data = await invokeFunctionRobust<CopilotChatResponse>("copilot_chat", {
      messages,
      context: {
        omni_one_ticket_count: omniOneTickets.length,
        omni_arena_ticket_count: omniArenaTickets.length,
        digest_count: digests.length,
      },
    });

    if (!data.ok) {
      throw new Error(data.error || "Copilot response failed.");
    }

    return data.reply;
  }

  const allTicketCount = omniOneTickets.length + omniArenaTickets.length;

  if (loadingSession) {
    return (
      <main className="min-h-screen bg-background">
        <div className="container max-w-7xl py-4 px-4">
          <Link to="/" className="inline-flex items-center gap-3">
            <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
            <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
          </Link>
        </div>
        <div className="container max-w-4xl py-12 px-4">
          <p className="text-sm text-muted-foreground">Loading Support Hub...</p>
        </div>
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="min-h-screen bg-background">
        <div className="container max-w-7xl py-4 px-4">
          <Link to="/" className="inline-flex items-center gap-3">
            <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
            <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
          </Link>
        </div>

        <div className="container max-w-4xl py-12 px-4">
          <section className="space-y-4 rounded-lg border bg-card p-6">
            <h1 className="text-2xl font-bold">Support Hub Sign In</h1>
            {recoveryMode ? (
              <>
                <p className="text-sm text-muted-foreground">Set your new password below to complete recovery.</p>
                <form className="space-y-3" onSubmit={handleUpdatePassword}>
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
                  <Button type="submit" disabled={submitting}>{submitting ? "Updating..." : "Update password"}</Button>
                </form>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">Internal access for Virtuix employees.</p>
                <form className="space-y-3" onSubmit={handleSignIn}>
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
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" disabled={submitting}>{submitting ? "Signing in..." : "Sign in"}</Button>
                    <Button asChild type="button" variant="ghost"><Link to="/">Back to Schedule</Link></Button>
                  </div>
                </form>
              </>
            )}
            {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
          </section>
        </div>
      </main>
    );
  }

  const activeSummary = activeTicket ? summaryMap[activeTicket.ticket_id] || null : null;

  return (
    <main className="min-h-screen bg-background relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(86,130,3,0.12),transparent_42%)]" />
      <div className="relative z-10 border-b bg-background/70 backdrop-blur-sm">
        <div className="container max-w-[1900px] py-3 px-4 flex items-center justify-between gap-3">
          <Link to="/" className="inline-flex items-center gap-3">
            <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
            <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
          </Link>
          <div className="flex items-center gap-2 lg:hidden">
            <Button size="icon" variant="outline" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
              <Menu className="h-4 w-4" />
            </Button>
          </div>
          <span className="hidden lg:inline text-xs text-muted-foreground">{userEmail}</span>
        </div>
      </div>

      <div className="container max-w-[1900px] py-6 px-4 relative z-10">
        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <SideNavigation userEmail={userEmail} onSignOut={() => void handleSignOut()} />
          </aside>

          <section className="space-y-4">
            <section className="rounded-2xl border bg-card/70 p-5 backdrop-blur-sm">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="space-y-1">
                  <h1 className="text-2xl font-semibold tracking-tight">Support Hub</h1>
                  <p className="text-sm text-muted-foreground">
                    {allTicketCount} cached tickets across Omni One and Omni Arena.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {lastSync?.finishedAt
                      ? `Last sync: ${new Date(lastSync.finishedAt).toLocaleString()} • Status: ${lastSync.status} • Updated: ${lastSync.ticketsUpserted}`
                      : "Last sync: not available yet"}
                  </p>
                  {syncMessage ? <p className="text-xs text-muted-foreground">{syncMessage}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleSyncNow} disabled={syncLoading}>
                    {syncLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    {syncLoading ? "Syncing..." : "Sync Zendesk"}
                  </Button>
                  {inTicketRoute ? (
                    <>
                      <Button variant="outline" onClick={() => navigate("/hub/digests")}>Open Digests</Button>
                      <Button variant="outline" onClick={() => navigate("/hub/documents")}>Open Documents</Button>
                    </>
                  ) : null}
                  {inDigestRoute ? (
                    <>
                      <Button variant="outline" onClick={() => navigate("/hub")}>Open Tickets</Button>
                      <Button variant="outline" onClick={() => navigate("/hub/documents")}>Open Documents</Button>
                    </>
                  ) : null}
                  {inDocumentsRoute ? (
                    <>
                      <Button variant="outline" onClick={() => navigate("/hub")}>Open Tickets</Button>
                      <Button variant="outline" onClick={() => navigate("/hub/digests")}>Open Digests</Button>
                    </>
                  ) : null}
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
                previewLoading={documentsPreviewLoading}
                previewError={documentsPreviewError}
                downloadingDocumentPath={downloadLoadingPath}
                onRefresh={refreshDocuments}
                onSelectBrand={handleSelectDocumentsBrand}
                onSelectTopLevelFolder={handleSelectDocumentsTopLevelFolder}
                onSelectDocument={handleSelectDocument}
                onDownloadDocument={handleDownloadDocument}
              />
            ) : (
              <>
                <section className="space-y-3 rounded-2xl border bg-card/50 p-4 backdrop-blur-sm">
                  <div className="h-8 flex items-center">
                    <img src={omniOneLogo} alt="Omni One" className="h-7 w-auto" />
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

                <section className="space-y-3 rounded-2xl border bg-card/50 p-4 backdrop-blur-sm">
                  <div className="h-8 flex items-center">
                    <img src={omniArenaLogo} alt="Omni Arena" className="h-7 w-auto" />
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

                <section className="space-y-3 rounded-2xl border bg-card/50 p-4 backdrop-blur-sm">
                  <div className="h-8 flex items-center">
                    <img src={omniArenaLogo} alt="Omni Arena" className="h-7 w-auto" />
                    <span className="ml-2 text-sm text-muted-foreground">Sites</span>
                  </div>
                  <ArenaSitesTable sites={sites} loading={sitesLoading} error={sitesError} />
                </section>
              </>
            )}
          </section>
        </div>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[300px] p-0">
          <div className="h-full p-4">
            <SideNavigation userEmail={userEmail} onSignOut={() => void handleSignOut()} />
          </div>
        </SheetContent>
      </Sheet>

      <CopilotChatDock onAsk={handleCopilotAsk} />

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
