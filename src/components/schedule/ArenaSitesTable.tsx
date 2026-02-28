import { useMemo, useState } from "react";
import { ArrowUpDown } from "lucide-react";
import type { ArenaSite } from "@/lib/scheduleData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ArenaSitesTableProps {
  sites: ArenaSite[];
  loading?: boolean;
  error?: string | null;
}

function normalize(value: string) {
  return (value ?? "").toLowerCase().trim();
}

function statusBadgeClasses(statusRaw: string) {
  const status = normalize(statusRaw);

  if (status === "current") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (status === "closed") return "bg-zinc-500/15 text-zinc-200 border-zinc-500/30";
  if (status === "no support" || status === "nosupport") return "bg-red-500/15 text-red-300 border-red-500/30";

  return "bg-sky-500/15 text-sky-300 border-sky-500/30";
}

function Badge({ status }: { status: string }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] whitespace-nowrap",
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

    if (statusFilter === "current") {
      list = list.filter((site) => normalize(site.currentQuarterStatus) === "current");
    }

    if (statusFilter === "no-support") {
      list = list.filter((site) => {
        const status = normalize(site.currentQuarterStatus);
        return status === "no support" || status === "nosupport";
      });
    }

    if (q) {
      list = list.filter((site) => {
        const haystack = [site.venueName, site.currentQuarterStatus, site.notes, site.primaryContact]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    list.sort((a, b) => {
      const first = (a.venueName ?? "").toLowerCase();
      const second = (b.venueName ?? "").toLowerCase();
      return sortAsc ? first.localeCompare(second) : second.localeCompare(first);
    });

    return list;
  }, [sites, query, statusFilter, sortAsc]);

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading sites...</div>;
  }

  if (error) {
    return <div className="text-sm text-destructive">{error}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-xl border border-border/65 bg-background/45 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search venue, notes, contact..."
            className="h-8 w-full sm:w-[300px]"
          />

          <div className="flex items-center gap-2">
            {([
              { key: "all", label: "All" },
              { key: "current", label: "Current" },
              { key: "no-support", label: "No Support" },
            ] as const).map((filter) => (
              <Button
                key={filter.key}
                size="sm"
                variant={statusFilter === filter.key ? "secondary" : "ghost"}
                onClick={() => setStatusFilter(filter.key)}
              >
                {filter.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <span className="text-xs text-muted-foreground">Showing: {filtered.length}</span>
          <Button size="sm" variant="outline" onClick={() => setSortAsc((value) => !value)} title="Toggle sort order">
            <ArrowUpDown className="mr-2 h-3.5 w-3.5" />
            Sort: {sortAsc ? "A -> Z" : "Z -> A"}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/65 bg-background/55 shadow-inner">
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-[14px] md:text-[15px]">
            <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur-sm">
              <tr>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Venue</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Current Quarter Status</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Notes</th>
                <th className="px-4 py-2 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-semibold">Main Contact</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((site, index) => (
                <tr key={`${site.venueName}-${index}`} className="border-t border-border/35 hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium whitespace-nowrap">{site.venueName}</td>
                  <td className="px-4 py-3">
                    <Badge status={site.currentQuarterStatus} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground min-w-[320px] leading-6">{site.notes || "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{site.primaryContact || "—"}</td>
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
    </div>
  );
}
