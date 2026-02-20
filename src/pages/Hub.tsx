import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { Bot, Copy, Loader2, Menu, RefreshCw, Send, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ArenaSitesTable } from "@/components/schedule/ArenaSitesTable";
import { getArenaSites, type ArenaSite } from "@/lib/scheduleData";
import { useToast } from "@/hooks/use-toast";
import type {
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
        if (body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string") {
          return (body as { error: string }).error;
        }
      } catch {
        // Fallback below.
      }
    }
  }

  return fallback;
}

function isInvalidJwtMessage(message: string): boolean {
  return message.toLowerCase().includes("invalid jwt");
}

async function invokeSyncWithAnonKeyFallback(): Promise<SyncZendeskResponse> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase URL or publishable key is missing in frontend env.");
  }

  const response = await fetch(`${url}/functions/v1/sync_zendesk`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ brand: "all" }),
  });

  const text = await response.text();
  let parsed: SyncZendeskResponse | null = null;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text) as SyncZendeskResponse;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed.error === "string" && parsed.error.length > 0
        ? parsed.error
        : `Fallback sync failed (${response.status}).`;
    throw new Error(message);
  }

  return parsed ?? { ok: true };
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

function formatTicketTableForClipboard(rows: Array<Record<string, unknown>>): string {
  const header = ["Ticket", "Brand", "Status", "Priority", "Requester", "Updated", "Subject"];
  const lines = [header.join("\t")];
  rows.forEach((row) => {
    lines.push(
      [
        row.ticket_id,
        row.brand,
        row.status,
        row.priority,
        row.requester,
        row.updated_at,
        row.subject,
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

function CopilotPanel({ omniOneCount, omniArenaCount, digestCount }: { omniOneCount: number; omniArenaCount: number; digestCount: number }) {
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([
    {
      role: "assistant",
      content:
        "I can help with triage. Ask for queue counts, digest strategy, or suggested next actions.",
    },
  ]);
  const [prompt, setPrompt] = useState("");

  function answerFor(input: string): string {
    const text = input.toLowerCase();

    if (text.includes("count") || text.includes("queue") || text.includes("open")) {
      return `Current cached queue: Omni One ${omniOneCount} tickets, Omni Arena ${omniArenaCount} tickets. Total ${omniOneCount + omniArenaCount}.`;
    }

    if (text.includes("digest")) {
      return "Use row selection first when you need a focused digest. If nothing is selected, generate from the current filter to capture queue slices.";
    }

    if (text.includes("slack")) {
      return "Send high-priority ticket summaries to Slack from the ticket drawer, and team-wide rollups from the Digests page.";
    }

    return `Suggested sequence: sync -> summarize blocked tickets -> generate digest -> post to Slack. Stored digests available: ${digestCount}.`;
  }

  function sendPrompt() {
    const value = prompt.trim();
    if (!value) return;
    const reply = answerFor(value);
    setMessages((prev) => [...prev, { role: "user", content: value }, { role: "assistant", content: reply }]);
    setPrompt("");
  }

  return (
    <div className="flex h-full flex-col rounded-2xl border bg-card/60 backdrop-blur-sm">
      <div className="border-b px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Bot className="h-4 w-4 text-primary" />
          AI Copilot
        </p>
        <p className="text-xs text-muted-foreground">Operational assistant for support execution</p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.map((message, idx) => (
          <div
            key={idx}
            className={[
              "rounded-lg border px-3 py-2 text-sm",
              message.role === "assistant" ? "bg-muted/30 text-foreground" : "bg-primary/15 text-primary-foreground border-primary/30",
            ].join(" ")}
          >
            {message.content}
          </div>
        ))}
      </div>

      <div className="space-y-2 border-t px-4 py-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setPrompt("Queue counts")}>Queue counts</Button>
          <Button size="sm" variant="outline" onClick={() => setPrompt("Digest strategy")}>Digest strategy</Button>
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask Copilot..."
            className="min-h-[74px] resize-none"
          />
          <Button size="icon" onClick={sendPrompt} aria-label="Send copilot prompt">
            <Send className="h-4 w-4" />
          </Button>
        </div>
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
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "pending" | "new" | "hold">("all");
  const [query, setQuery] = useState("");

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const statusMatches = statusFilter === "all" ? true : row.status.toLowerCase() === statusFilter;
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

    await onGenerateDigest({
      filters: {
        brand: rows[0]?.brand ?? "all",
        status: statusFilter,
        search: query,
        limit: 50,
      },
    });
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
          {(["all", "open", "pending", "new", "hold"] as const).map((status) => (
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
              <p className="text-sm text-muted-foreground">
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
    <section className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <div className="rounded-2xl border bg-card/50 p-4 backdrop-blur-sm">
        <h2 className="mb-3 text-sm font-semibold">Recent Digests</h2>
        {loading ? <p className="text-sm text-muted-foreground">Loading digests...</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!loading && !error ? (
          <div className="space-y-2">
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

      <div className="rounded-2xl border bg-card/50 p-4 backdrop-blur-sm">
        {selected ? (
          <div className="space-y-4">
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

            <pre className="max-h-[500px] overflow-auto rounded-lg border bg-background/70 p-4 text-xs whitespace-pre-wrap">
              {selected.content_markdown}
            </pre>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Select a digest to view details.</p>
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

  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [generatingDigest, setGeneratingDigest] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileCopilotOpen, setMobileCopilotOpen] = useState(false);

  const inDigestRoute = location.pathname === "/hub/digests";

  async function invokeFunctionWithAuthRetry<T>(name: string, body: Record<string, unknown>) {
    let result = await supabase.functions.invoke<T>(name, { method: "POST", body });
    if (!result.error) {
      return result;
    }

    const firstMessage = await extractFunctionErrorMessage(result.error);
    if (!isInvalidJwtMessage(firstMessage)) {
      return result;
    }

    const { error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) {
      return result;
    }

    result = await supabase.functions.invoke<T>(name, { method: "POST", body });
    return result;
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
        .select("ticket_id,brand,subject,status,priority,requester_email,requester_name,assignee_email,zendesk_updated_at,ticket_url,summary_text")
        .eq("brand", "omni_one")
        .order("zendesk_updated_at", { ascending: false })
        .limit(75),
      supabase
        .from("ticket_cache")
        .select("ticket_id,brand,subject,status,priority,requester_email,requester_name,assignee_email,zendesk_updated_at,ticket_url,summary_text")
        .eq("brand", "omni_arena")
        .order("zendesk_updated_at", { ascending: false })
        .limit(75),
    ])
      .then(async ([omniOneResult, omniArenaResult]) => {
        if (!mounted) return;

        if (omniOneResult.error || omniArenaResult.error) {
          throw new Error(omniOneResult.error?.message || omniArenaResult.error?.message || "Ticket fetch failed.");
        }

        const omniOne = (omniOneResult.data || []) as Ticket[];
        const omniArena = (omniArenaResult.data || []) as Ticket[];

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

    const { data, error } = await invokeFunctionWithAuthRetry<SyncZendeskResponse>("sync_zendesk", { brand: "all" });

    if (error) {
      const details = await extractFunctionErrorMessage(error);
      try {
        const fallbackData = await invokeSyncWithAnonKeyFallback();
        const fallbackUpserted = fallbackData.tickets_upserted ?? 0;
        const fallbackMessage = fallbackData.skipped
          ? fallbackData.reason || "Sync skipped."
          : `Sync completed. ${fallbackUpserted} tickets updated.`;
        setSyncMessage(`${fallbackMessage} (fallback path)`);
        toast({ title: "Zendesk sync", description: `${fallbackMessage} (fallback path)` });
        setSyncLoading(false);
        setRefreshKey((value) => value + 1);
        return;
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "Fallback sync failed.";
        setSyncMessage(`Sync failed: ${details}`);
        toast({
          title: "Sync failed",
          description: `${details} | Fallback failed: ${fallbackMessage}`,
          variant: "destructive",
        });
        if (isInvalidJwtMessage(details)) {
          toast({
            title: "Session expired",
            description: "Please sign out and sign back in, then retry sync.",
            variant: "destructive",
          });
        }
        setSyncLoading(false);
        return;
      }
    }

    const upserted = data?.tickets_upserted ?? 0;
    const message = data?.skipped ? data.reason || "Sync skipped." : `Sync completed. ${upserted} tickets updated.`;
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

  async function refreshTicketSummary(ticketId: number, refresh: boolean) {
    setSummaryLoadingTicketId(ticketId);

    const { data, error } = await invokeFunctionWithAuthRetry<SummarizeTicketResponse>("summarize_ticket", {
      ticket_id: ticketId,
      refresh,
    });

    if (error || !data?.ok) {
      const details = error ? await extractFunctionErrorMessage(error) : data?.error || "Summary generation failed.";
      toast({ title: "Summary error", description: details, variant: "destructive" });
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

    const { data, error } = await invokeFunctionWithAuthRetry<CreateDigestResponse>("create_digest", {
      ticket_ids: request.ticketIds,
      filters: request.filters,
    });

    if (error || !data?.ok) {
      const details = error ? await extractFunctionErrorMessage(error) : data?.error || "Digest generation failed.";
      toast({ title: "Digest error", description: details, variant: "destructive" });
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
    const { data, error } = await invokeFunctionWithAuthRetry<SendToSlackResponse>("send_to_slack", {
      type: "ticket_summary",
      ticket_id: ticketId,
    });

    if (error || !data?.ok) {
      const details = error ? await extractFunctionErrorMessage(error) : data?.error || "Failed to send ticket summary to Slack.";
      toast({ title: "Slack send failed", description: details, variant: "destructive" });
      return;
    }

    toast({ title: "Sent to Slack", description: `Ticket #${ticketId} summary posted.` });
  }

  async function sendDigestToSlack(digestId: string) {
    const { data, error } = await invokeFunctionWithAuthRetry<SendToSlackResponse>("send_to_slack", {
      type: "digest",
      digest_id: digestId,
    });

    if (error || !data?.ok) {
      const details = error ? await extractFunctionErrorMessage(error) : data?.error || "Failed to send digest to Slack.";
      toast({ title: "Slack send failed", description: details, variant: "destructive" });
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
            <Button size="icon" variant="outline" onClick={() => setMobileCopilotOpen(true)} aria-label="Open copilot">
              <Bot className="h-4 w-4" />
            </Button>
          </div>
          <span className="hidden lg:inline text-xs text-muted-foreground">{userEmail}</span>
        </div>
      </div>

      <div className="container max-w-[1900px] py-6 px-4 relative z-10">
        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px] 2xl:grid-cols-[240px_minmax(0,1fr)_320px]">
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
                  {!inDigestRoute ? (
                    <Button variant="outline" onClick={() => navigate("/hub/digests")}>Open Digests</Button>
                  ) : (
                    <Button variant="outline" onClick={() => navigate("/hub")}>Open Tickets</Button>
                  )}
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

          <aside className="hidden xl:block">
            <CopilotPanel omniOneCount={omniOneTickets.length} omniArenaCount={omniArenaTickets.length} digestCount={digests.length} />
          </aside>
        </div>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[300px] p-0">
          <div className="h-full p-4">
            <SideNavigation userEmail={userEmail} onSignOut={() => void handleSignOut()} />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={mobileCopilotOpen} onOpenChange={setMobileCopilotOpen}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-md">
          <div className="h-full p-4">
            <CopilotPanel omniOneCount={omniOneTickets.length} omniArenaCount={omniArenaTickets.length} digestCount={digests.length} />
          </div>
        </SheetContent>
      </Sheet>

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
