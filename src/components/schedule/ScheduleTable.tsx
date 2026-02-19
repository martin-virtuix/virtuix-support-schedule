import { ScheduleBundle, dayLabel, displayOrder, formatHours, keyByIndex } from "@/lib/scheduleData";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ScheduleTableProps {
  bundle: ScheduleBundle | null;
  highlightToday: boolean;
}

const dayPillLabel: Record<string, string> = {
  monday: "MON",
  tuesday: "TUE",
  wednesday: "WED",
  thursday: "THU",
  friday: "FRI",
  saturday: "SAT",
  sunday: "SUN",
};

export function ScheduleTable({ bundle, highlightToday }: ScheduleTableProps) {
  const now = new Date();
  const todayKey = keyByIndex[now.getDay()];

  if (!bundle) {
    return (
      <div className="glass-card rounded-xl overflow-hidden animate-pulse">
        <div className="p-4 space-y-3">
          {[...Array(7)].map((_, i) => (
            <div key={i} className="h-10 bg-muted rounded" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card rounded-xl overflow-hidden border bg-card/80 backdrop-blur-sm">
      <Table>
        <TableHeader>
          <TableRow className="border-border/50 hover:bg-transparent">
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Day</TableHead>
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Business Hours</TableHead>
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">On Duty</TableHead>
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayOrder.map((key) => {
            const isToday = highlightToday && key === todayKey;
            const people = bundle.schedule[key]?.length
              ? bundle.schedule[key].join(", ")
              : "—";
            const note = bundle.notesByDay[key] || "—";

            return (
              <TableRow
                key={key}
                className={cn(
                  "border-border/30 transition-colors",
                  isToday && "bg-primary/5"
                )}
              >
                <TableCell className={cn("font-medium", isToday && "text-primary")}>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide",
                      isToday ? "bg-primary/10 border-primary/30 text-primary" : "bg-muted/50 border-border text-foreground",
                    )}
                    title={dayLabel[key]}
                  >
                    {dayPillLabel[key] || dayLabel[key].slice(0, 3).toUpperCase()}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatHours(key, bundle.businessHours)}
                </TableCell>
                <TableCell>{people}</TableCell>
                <TableCell className="text-muted-foreground">{note}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
