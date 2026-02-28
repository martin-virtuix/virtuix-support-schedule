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
      <div className="surface-panel overflow-hidden animate-pulse">
        <div className="p-5 space-y-3">
          {[...Array(7)].map((_, i) => (
            <div key={i} className="h-10 bg-muted rounded" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="surface-panel overflow-hidden">
      <Table className="w-full table-fixed text-[15px] md:text-[16px]">
        <TableHeader>
          <TableRow className="border-border/55 bg-background/55 hover:bg-transparent">
            <TableHead className="w-[102px] py-3 text-[11px] uppercase tracking-[0.13em] text-muted-foreground font-semibold">Day</TableHead>
            <TableHead className="w-[230px] whitespace-nowrap py-3 text-[11px] uppercase tracking-[0.13em] text-muted-foreground font-semibold">Business Hours</TableHead>
            <TableHead className="w-[300px] py-3 text-[11px] uppercase tracking-[0.13em] text-muted-foreground font-semibold">On Duty</TableHead>
            <TableHead className="min-w-[220px] py-3 text-[11px] uppercase tracking-[0.13em] text-muted-foreground font-semibold">Notes</TableHead>
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
                  "border-border/35 transition-colors",
                  isToday ? "bg-primary/8" : "odd:bg-background/35"
                )}
              >
                <TableCell className={cn("py-4 font-medium", isToday && "text-primary")}>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.1em]",
                      isToday ? "bg-primary/10 border-primary/30 text-primary" : "bg-muted/50 border-border text-foreground",
                    )}
                    title={dayLabel[key]}
                  >
                    {dayPillLabel[key] || dayLabel[key].slice(0, 3).toUpperCase()}
                  </span>
                </TableCell>
                <TableCell className="py-4 whitespace-nowrap text-foreground/95">
                  {formatHours(key, bundle.businessHours)}
                </TableCell>
                <TableCell className="py-4 text-foreground/95">{people}</TableCell>
                <TableCell className="py-4 leading-6 text-muted-foreground">{note}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
