import { StatusPill } from "./StatusPill";
import { ScheduleBundle, dayLabel, formatHours, isOpenNow, keyByIndex } from "@/lib/scheduleData";
import { Clock } from "lucide-react";

interface WeekCardProps {
  bundle: ScheduleBundle | null;
  isCurrentWeek: boolean;
}

export function WeekCard({ bundle, isCurrentWeek }: WeekCardProps) {
  const now = new Date();
  const todayKey = keyByIndex[now.getDay()];
  const isOpen = bundle ? isOpenNow(todayKey, now, bundle.businessHours) : false;
  const peopleToday = bundle?.schedule[todayKey] || [];
  
  const pad = (n: number) => n.toString().padStart(2, "0");
  const currentTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  if (!bundle) {
    return (
      <div className="surface-panel p-6 md:p-7 animate-pulse">
        <div className="h-6 bg-muted rounded w-24 mb-5" />
        <div className="h-9 bg-muted rounded w-40 mb-3" />
        <div className="h-4 bg-muted rounded w-56" />
      </div>
    );
  }

  return (
    <div className="surface-panel p-6 md:p-7 space-y-5">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <StatusPill 
            isOpen={isCurrentWeek ? isOpen : false} 
            label={isCurrentWeek ? undefined : "Preview"} 
          />
          <h3 className="text-[1.65rem] md:text-3xl font-semibold text-foreground tracking-tight leading-tight">
            {isCurrentWeek ? dayLabel[todayKey] : "Next week"}
          </h3>
          <p className="text-[15px] md:text-[16px] leading-6 text-muted-foreground">
            {isCurrentWeek 
              ? formatHours(todayKey, bundle.businessHours)
              : "Schedule loaded from sheet"
            }
          </p>
        </div>
        {isCurrentWeek && (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/45 px-3 py-1 text-[13px] md:text-sm text-muted-foreground">
            <Clock className="w-4 h-4 text-primary" />
            {currentTime}
          </div>
        )}
      </div>

      <div className="pt-3 border-t border-border/60">
        {isCurrentWeek ? (
          isOpen && peopleToday.length > 0 ? (
            <p className="text-[15px] md:text-[16px] leading-6">
              <span className="text-muted-foreground">On duty now:</span>{" "}
              <span className="font-semibold text-foreground">{peopleToday.join(", ")}</span>
            </p>
          ) : isOpen ? (
            <p className="text-[15px] md:text-[16px] leading-6 text-muted-foreground">No one assigned today.</p>
          ) : (
            <p className="text-[15px] md:text-[16px] leading-6 text-muted-foreground">Outside business hours.</p>
          )
        ) : (
          <p className="text-[15px] md:text-[16px] leading-6 text-muted-foreground">View the upcoming schedule below.</p>
        )}
      </div>
    </div>
  );
}
