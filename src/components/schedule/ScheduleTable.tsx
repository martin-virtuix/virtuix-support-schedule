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
    <div className="glass-card rounded-xl overflow-hidden">
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
                  {dayLabel[key]}
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
