import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArenaSitesTable } from "@/components/schedule/ArenaSitesTable";
import { getArenaSites, type ArenaSite } from "@/lib/scheduleData";
import virtuixLogoWhite from "@/assets/virtuix_logo_white.png";
import omniOneSquareLogo from "@/assets/omnione_logo_square.png";
import omniArenaLogo from "@/assets/omniarena-logo.png";
import omniOneLogo from "@/assets/omnione_logo_color.png";

const ALLOWED_DOMAIN = "@virtuix.com";

type TicketRow = {
  ticketNumber: number;
  id: string;
  subject: string;
  status: string;
  requester: string;
  updatedAt: string;
  ticketUrl: string | null;
};

type SyncSummary = {
  finishedAt: string | null;
  ticketsUpserted: number;
  status: string;
};

function isAllowedEmail(email?: string | null): boolean {
  return !!email && email.toLowerCase().endsWith(ALLOWED_DOMAIN);
}

function formatUpdatedAt(value: string | null): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

async function extractFunctionErrorMessage(error: unknown): Promise<string> {
  if (!error || typeof error !== "object") {
    return "Unknown sync error.";
  }

  const fallback =
    "message" in error && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Unknown sync error.";

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
        // Fall through to text/fallback
      }
    }
    if (typeof response.text === "function") {
      try {
        const text = await response.text();
        if (text.trim().length > 0) {
          return text;
        }
      } catch {
        // Fall through to fallback
      }
    }
  }

  return fallback;
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
  return "bg-muted text-muted-foreground border-border";
}

function TicketTable({
  rows,
  loading,
  error,
}: {
  rows: TicketRow[];
  loading: boolean;
  error: string | null;
}) {
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "pending" | "new">("all");
  const filteredRows = rows.filter((row) => {
    if (statusFilter === "all") return true;
    return row.status.toLowerCase() === statusFilter;
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Filter:</span>
        {(["all", "open", "pending", "new"] as const).map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={[
              "h-8 rounded-full border px-3 text-xs uppercase tracking-wide transition-colors",
              statusFilter === status ? "bg-muted text-foreground" : "bg-background/70 text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {status}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card/80 backdrop-blur-sm">
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 sticky top-0 z-10 backdrop-blur-sm">
              <tr>
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
                  <td className="px-4 py-6 text-sm text-muted-foreground" colSpan={5}>
                    Loading tickets...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-destructive" colSpan={5}>
                    {error}
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-muted-foreground" colSpan={5}>
                    No tickets for selected filter.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const href = row.ticketUrl;
                  return (
                    <tr key={row.id} className="border-t hover:bg-muted/40">
                      <td className="px-4 py-2 font-medium whitespace-nowrap">
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer" className="underline decoration-muted-foreground/40 hover:decoration-foreground">
                            {row.id}
                          </a>
                        ) : (
                          row.id
                        )}
                      </td>
                      <td className="px-4 py-2 min-w-[280px]">{row.subject}</td>
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
                      <td className="px-4 py-2 whitespace-nowrap">{row.requester || "—"}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{row.updatedAt}</td>
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

export default function Hub() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sites, setSites] = useState<ArenaSite[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [omniOneTickets, setOmniOneTickets] = useState<TicketRow[]>([]);
  const [omniArenaTickets, setOmniArenaTickets] = useState<TicketRow[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsError, setTicketsError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadSession() {
      const { data, error } = await supabase.auth.getSession();

      if (!mounted) {
        return;
      }

      if (error) {
        setStatus(error.message);
      }

      setSession(data.session ?? null);
      setLoadingSession(false);
    }

    loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }

    const userEmail = session.user.email;
    if (isAllowedEmail(userEmail)) {
      return;
    }

    setStatus("Access is limited to @virtuix.com accounts.");
    void supabase.auth.signOut();
  }, [session]);

  const userEmail = session?.user.email ?? null;
  const authorized = useMemo(() => isAllowedEmail(userEmail), [userEmail]);

  useEffect(() => {
    if (!authorized) {
      setSites([]);
      setSitesLoading(false);
      setSitesError(null);
      return;
    }

    let mounted = true;
    setSitesLoading(true);
    setSitesError(null);

    getArenaSites()
      .then((data) => {
        if (!mounted) {
          return;
        }
        setSites(data);
      })
      .catch((error: unknown) => {
        if (!mounted) {
          return;
        }
        const message = error instanceof Error ? error.message : "Failed to load arena sites.";
        setSitesError(message);
      })
      .finally(() => {
        if (mounted) {
          setSitesLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [authorized]);

  useEffect(() => {
    if (!authorized) {
      setOmniOneTickets([]);
      setOmniArenaTickets([]);
      setTicketsLoading(false);
      setTicketsError(null);
      return;
    }

    let mounted = true;
    setTicketsLoading(true);
    setTicketsError(null);

    Promise.all([
      supabase
        .from("zendesk_tickets")
        .select("ticket_id,subject,status,requester_email,zendesk_updated_at,raw_payload")
        .eq("brand", "omni_one")
        .order("zendesk_updated_at", { ascending: false })
        .limit(50),
      supabase
        .from("zendesk_tickets")
        .select("ticket_id,subject,status,requester_email,zendesk_updated_at,raw_payload")
        .eq("brand", "omni_arena")
        .order("zendesk_updated_at", { ascending: false })
        .limit(50),
    ])
      .then(([omniOneResult, omniArenaResult]) => {
        if (!mounted) {
          return;
        }

        if (omniOneResult.error || omniArenaResult.error) {
          throw new Error(omniOneResult.error?.message || omniArenaResult.error?.message || "Ticket fetch failed.");
        }

        function getStringFromPath(value: unknown, path: string[]): string | null {
          let current: unknown = value;
          for (const key of path) {
            if (!current || typeof current !== "object" || !(key in (current as Record<string, unknown>))) {
              return null;
            }
            current = (current as Record<string, unknown>)[key];
          }
          return typeof current === "string" && current.trim().length > 0 ? current : null;
        }

        function buildAgentTicketUrl(rawPayload: unknown, ticketNumber: number): string | null {
          const apiUrl = getStringFromPath(rawPayload, ["url"]);
          if (apiUrl) {
            try {
              const parsed = new URL(apiUrl);
              return `${parsed.protocol}//${parsed.host}/agent/tickets/${ticketNumber}`;
            } catch {
              // Fallback below when API URL is malformed
            }
          }

          const subdomain = import.meta.env.VITE_ZENDESK_SUBDOMAIN;
          if (subdomain) {
            return `https://${subdomain}.zendesk.com/agent/tickets/${ticketNumber}`;
          }

          return null;
        }

        const toRows = (
          items: Array<{
            ticket_id: number;
            subject: string;
            status: string;
            requester_email: string | null;
            zendesk_updated_at: string | null;
            raw_payload: unknown;
          }>,
        ): TicketRow[] =>
          items.map((item) => ({
            ticketNumber: item.ticket_id,
            id: `#${item.ticket_id}`,
            subject: item.subject || "",
            status: item.status || "new",
            requester:
              getStringFromPath(item.raw_payload, ["requester", "name"]) ||
              getStringFromPath(item.raw_payload, ["via", "source", "from", "name"]) ||
              getStringFromPath(item.raw_payload, ["via", "source", "from", "address"]) ||
              item.requester_email ||
              "",
            updatedAt: formatUpdatedAt(item.zendesk_updated_at),
            ticketUrl: buildAgentTicketUrl(item.raw_payload, item.ticket_id),
          }));

        setOmniOneTickets(toRows(omniOneResult.data || []));
        setOmniArenaTickets(toRows(omniArenaResult.data || []));
      })
      .catch((error: unknown) => {
        if (!mounted) {
          return;
        }
        const message = error instanceof Error ? error.message : "Failed to load Zendesk tickets.";
        setTicketsError(message);
      })
      .finally(() => {
        if (mounted) {
          setTicketsLoading(false);
        }
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
        if (error) {
          setLastSync(null);
          return;
        }
        if (!data) {
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

    const redirectTo = `${window.location.origin}/hub`;
    const { error } = await supabase.auth.signInWithOtp({
      email: normalized,
      options: { emailRedirectTo: redirectTo },
    });

    if (error) {
      setStatus(error.message);
    } else {
      setStatus("Check your email for the sign-in link.");
    }

    setSubmitting(false);
  }

  async function handleSignOut() {
    const { error } = await supabase.auth.signOut();
    if (error) {
      setStatus(error.message);
      return;
    }
    setStatus("Signed out.");
  }

  async function handleSyncNow() {
    setSyncLoading(true);
    setSyncMessage(null);

    const { data, error } = await supabase.functions.invoke("zendesk-sync", {
      method: "POST",
      body: { brand: "all" },
    });

    if (error) {
      const details = await extractFunctionErrorMessage(error);
      setSyncMessage(`Sync failed: ${details}`);
      setSyncLoading(false);
      return;
    }

    const upserted =
      data && typeof data === "object" && "tickets_upserted" in data
        ? Number((data as { tickets_upserted?: number }).tickets_upserted ?? 0)
        : 0;

    setSyncMessage(`Sync completed. ${upserted} tickets updated.`);
    setSyncLoading(false);
    setRefreshKey((value) => value + 1);
  }

  if (loadingSession) {
    return (
      <main className="min-h-screen bg-background">
        <div className="bg-gradient-to-b from-[#568203]/30 via-[#568203]/10 to-transparent">
          <div className="container max-w-7xl py-4 px-4">
            <div className="flex items-center gap-3">
              <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
              <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
            </div>
          </div>
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
        <div className="bg-gradient-to-b from-[#568203]/30 via-[#568203]/10 to-transparent">
          <div className="container max-w-7xl py-4 px-4">
            <div className="flex items-center gap-3">
              <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
              <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
            </div>
          </div>
        </div>

        <div className="container max-w-4xl py-12 px-4">
          <section className="border rounded-lg p-6 space-y-4 bg-card">
            <h1 className="text-2xl font-bold">Support Hub Sign In</h1>
            <p className="text-sm text-muted-foreground">
              Internal access for Virtuix employees. Use your company email to receive a sign-in link.
            </p>
            <form className="space-y-3" onSubmit={handleSignIn}>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@virtuix.com"
                required
              />
              <Button type="submit" disabled={submitting}>
                {submitting ? "Sending link..." : "Send sign-in link"}
              </Button>
            </form>
            {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(86,130,3,0.12),transparent_42%)]" />
      <div className="bg-gradient-to-b from-[#568203]/30 via-[#568203]/10 to-transparent">
        <div className="container max-w-7xl py-4 px-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
            <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-xs text-slate-300">{userEmail}</span>
          </div>
        </div>
      </div>

      <div className="container max-w-7xl py-8 px-4 space-y-8 relative z-10">
        <section className="rounded-2xl border bg-card/70 backdrop-blur-sm p-5 md:p-6 flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Support Hub</h1>
            <p className="text-sm text-muted-foreground">
              Live Zendesk operations dashboard for Omni One and Omni Arena.
            </p>
            <p className="text-xs text-muted-foreground">
              {lastSync?.finishedAt
                ? `Last sync: ${new Date(lastSync.finishedAt).toLocaleString()} • Status: ${lastSync.status} • Updated: ${lastSync.ticketsUpserted}`
                : "Last sync: not available yet"}
            </p>
            {syncMessage ? <p className="text-xs text-muted-foreground">{syncMessage}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleSyncNow} disabled={syncLoading} className="min-w-[120px]">
              {syncLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Sync now
                </>
              )}
            </Button>
            <Button variant="secondary" onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </section>

        <section className="space-y-3 rounded-2xl border bg-card/50 backdrop-blur-sm p-4 md:p-5">
          <div className="h-8 flex items-center">
            <img src={omniOneLogo} alt="Omni One" className="h-7 w-auto" />
          </div>
          <TicketTable rows={omniOneTickets} loading={ticketsLoading} error={ticketsError} />
        </section>

        <section className="space-y-3 rounded-2xl border bg-card/50 backdrop-blur-sm p-4 md:p-5">
          <div className="h-8 flex items-center">
            <img src={omniArenaLogo} alt="Omni Arena" className="h-7 w-auto" />
          </div>
          <TicketTable rows={omniArenaTickets} loading={ticketsLoading} error={ticketsError} />
        </section>

        <section className="space-y-3 rounded-2xl border bg-card/50 backdrop-blur-sm p-4 md:p-5">
          <div className="h-8 flex items-center">
            <img src={omniArenaLogo} alt="Omni Arena" className="h-7 w-auto" />
          </div>
          <ArenaSitesTable sites={sites} loading={sitesLoading} error={sitesError} />
        </section>
      </div>
    </main>
  );
}
