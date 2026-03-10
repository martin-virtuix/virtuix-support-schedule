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

  const rows = displayOrder.map((key) => {
    const isToday = highlightToday && key === todayKey;
    const people = bundle.schedule[key]?.length ? bundle.schedule[key].join(", ") : "—";
    const note = bundle.notesByDay[key] || "—";

    return {
      key,
      isToday,
      day: dayPillLabel[key] || dayLabel[key].slice(0, 3).toUpperCase(),
      hours: formatHours(key, bundle.businessHours),
      people,
      note,
      title: dayLabel[key],
    };
  });

  return (
    <div className="space-y-3">
      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <article
            key={`card-${row.key}`}
            className={cn(
              "surface-panel-soft space-y-2 p-4",
              row.isToday && "border-primary/55 bg-primary/[0.08]",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.1em]",
                  row.isToday
                    ? "border-primary/45 bg-primary/12 text-primary"
                    : "border-border bg-muted/45 text-foreground",
                )}
                title={row.title}
              >
                {row.day}
              </span>
              {row.isToday ? (
                <span className="brand-chip border-primary/35 bg-primary/12 text-primary">Today</span>
              ) : null}
            </div>
            <p className="text-[13px] leading-5 text-muted-foreground">{row.hours}</p>
            <p className="text-sm font-medium leading-6 text-foreground">{row.people}</p>
            <p className="text-sm leading-6 text-muted-foreground">{row.note}</p>
          </article>
        ))}
      </div>

      <div className="table-shell hidden md:block">
        <Table className="w-full table-fixed text-[15px] md:text-[16px]">
          <TableHeader>
            <TableRow className="border-border/55 bg-background/55 hover:bg-transparent">
              <TableHead className="w-[102px] py-3">Day</TableHead>
              <TableHead className="w-[230px] whitespace-nowrap py-3">Business Hours</TableHead>
              <TableHead className="w-[300px] py-3">On Duty</TableHead>
              <TableHead className="min-w-[220px] py-3">Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.key}
                className={cn(
                  "border-border/35 transition-colors",
                  row.isToday ? "bg-primary/8" : "odd:bg-background/35",
                )}
              >
                <TableCell className={cn("py-4 font-medium", row.isToday && "text-primary")}>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.1em]",
                      row.isToday ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-muted/50 text-foreground",
                    )}
                    title={row.title}
                  >
                    {row.day}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap py-4 text-foreground/95">{row.hours}</TableCell>
                <TableCell className="py-4 text-foreground/95">{row.people}</TableCell>
                <TableCell className="py-4 leading-6 text-muted-foreground">{row.note}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
