import { useState, useMemo } from "react";
import { NO_SUPPORT_SITES } from "@/lib/scheduleData";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, AlertTriangle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

export function NoSupportList() {
  const [search, setSearch] = useState("");

  const filteredSites = useMemo(() => {
    const q = search.trim().toLowerCase();
    return NO_SUPPORT_SITES
      .filter(s => `${s.name} ${s.note || ""} ${s.flag || ""}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [search]);

  return (
    <section className="glass-card rounded-xl p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-destructive/10">
            <AlertTriangle className="w-5 h-5 text-destructive" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Excluded Sites</h2>
            <p className="text-sm text-muted-foreground">Sites not covered by Omni Care</p>
          </div>
        </div>
        <span className="text-sm text-muted-foreground">
          {filteredSites.length} / {NO_SUPPORT_SITES.length} shown
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        Sites currently excluded from support.{" "}
        <Badge variant="outline" className="text-primary border-primary/30 bg-primary/5">*</Badge>
        {" "}sites are behind on an old invoice and will not receive a shipment even if they submit payment.
      </p>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search a site..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10 bg-background/50"
        />
      </div>

      <ScrollArea className="h-[180px]">
        {filteredSites.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No matches found.</p>
        ) : (
          <ul className="space-y-1">
            {filteredSites.map((site) => (
              <li
                key={site.name}
                className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors"
              >
                <span className="text-sm truncate">{site.name}</span>
                <div className="flex items-center gap-2">
                  {site.flag && (
                    <Badge variant="outline" className="text-primary border-primary/30 bg-primary/5 text-xs">
                      {site.flag}
                    </Badge>
                  )}
                  {site.note && (
                    <Badge variant="outline" className="text-warning border-warning/30 bg-warning/5 text-xs">
                      {site.note}
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </section>
  );
}
