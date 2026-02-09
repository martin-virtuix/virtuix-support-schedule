import { useMemo, useState } from "react";
import { ArenaSite } from "@/lib/scheduleData";

interface ArenaSitesTableProps {
  sites: ArenaSite[];
  loading?: boolean;
  error?: string | null;
}

function normalize(s: string) {
  return (s ?? "").toLowerCase().trim();
}

function statusBadgeClasses(statusRaw: string) {
  const status = normalize(statusRaw);

  // Ajusta aquí según tus valores reales: Current / Closed / No Support / etc
  if (status === "current") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (status === "closed") return "bg-zinc-500/15 text-zinc-200 border-zinc-500/30";
  if (status === "no support" || status === "nosupport") return "bg-red-500/15 text-red-300 border-red-500/30";

  // default
  return "bg-sky-500/15 text-sky-300 border-sky-500/30";
}

function Badge({ status }: { status: string }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        statusBadgeClasses(status),
      ].join(" ")}
    >
      {status || "—"}
    </span>
  );
}

type StatusFilter = "all" | "current" | "no-support";

export function ArenaSitesTable({ sites, loading, error }: ArenaSitesTableProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortAsc, setSortAsc] = useState(true);

  const filtered = useMemo(() => {
    const q = normalize(query);

    let list = [...(sites || [])];

    // filter: Current
    if (statusFilter === "current") {
      list = list.filter((s) => normalize(s.currentQuarterStatus) === "current");
    }

    if(statusFilter === "no-support") { 
       list = list.filter((s) => {
        const status = normalize(s.currentQuarterStatus);
        return status === "no support" || status === "nosupport";
       });
    }

    // search: venue, notes, contact, status
    if (q) {
      list = list.filter((s) => {
        const haystack = [
          s.venueName,
          s.currentQuarterStatus,
          s.notes,
          s.primaryContact,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    // sort: alphabetical by venue
    list.sort((a, b) => {
      const A = (a.venueName ?? "").toLowerCase();
      const B = (b.venueName ?? "").toLowerCase();
      return sortAsc ? A.localeCompare(B) : B.localeCompare(A);
    });

    return list;
  }, [sites, query, statusFilter, sortAsc]);

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading sites…</div>;
  }

  if (error) {
    return <div className="text-sm text-red-500">{error}</div>;
  }

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* Search */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search venue, notes, contact…"
            className="h-9 w-full sm:w-[320px] rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />

          {/* Filter */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setStatusFilter("all")}
              className={[
                "h-9 rounded-md border px-3 text-sm",
                statusFilter === "all" ? "bg-muted" : "bg-background",
              ].join(" ")}
            >
              All
            </button>
            <button
              onClick={() => setStatusFilter("current")}
              className={[
                "h-9 rounded-md border px-3 text-sm",
                statusFilter === "current" ? "bg-muted" : "bg-background",
              ].join(" ")}
            >
              Current
            </button>
            <button
                onClick={() => setStatusFilter("no-support")}
                className={[
                    "h-9 rounded-md border px-3 text-sm",
                    statusFilter === "no-support" ? "bg-muted" : "bg-background",
                ].join(" ")}
            >
                No Support
            </button>
          </div>
        </div>

        {/* Sort + Count */}
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <span className="text-sm text-muted-foreground">
            Showing: {filtered.length}
          </span>
          <button
            onClick={() => setSortAsc((v) => !v)}
            className="h-9 rounded-md border bg-background px-3 text-sm hover:bg-muted"
            title="Toggle sort order"
          >
            Sort: {sortAsc ? "A → Z" : "Z → A"}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-2 text-left">Venue</th>
              <th className="px-4 py-2 text-left">Current Quarter Status</th>
              <th className="px-4 py-2 text-left">Notes</th>
              <th className="px-4 py-2 text-left">Main Contact</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((site, idx) => (
              <tr
                key={`${site.venueName}-${idx}`}
                className="border-t hover:bg-muted/50"
              >
                <td className="px-4 py-2 font-medium whitespace-nowrap">
                  {site.venueName}
                </td>
                <td className="px-4 py-2">
                  <Badge status={site.currentQuarterStatus} />
                </td>
                <td className="px-4 py-2 text-muted-foreground min-w-[320px]">
                  {site.notes || "—"}
                </td>
                <td className="px-4 py-2 whitespace-nowrap">
                  {site.primaryContact || "—"}
                </td>
              </tr>
            ))}

            {filtered.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-sm text-muted-foreground" colSpan={4}>
                  No results.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
