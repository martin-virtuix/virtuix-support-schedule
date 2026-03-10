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
        <div className="mb-5 h-6 w-24 rounded-full bg-muted/80" />
        <div className="mb-3 h-9 w-44 rounded-lg bg-muted/80" />
        <div className="h-4 w-60 rounded bg-muted/75" />
      </div>
    );
  }

  return (
    <div className="surface-panel space-y-5 p-6 md:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <StatusPill 
            isOpen={isCurrentWeek ? isOpen : false} 
            label={isCurrentWeek ? undefined : "Preview"} 
          />
          <h3 className="text-[1.9rem] font-semibold leading-tight tracking-tight text-foreground md:text-3xl">
            {isCurrentWeek ? dayLabel[todayKey] : "Next week"}
          </h3>
          <p className="text-[15px] leading-6 text-muted-foreground md:text-[16px]">
            {isCurrentWeek 
              ? formatHours(todayKey, bundle.businessHours)
              : "Schedule loaded from sheet"
            }
          </p>
        </div>
        {isCurrentWeek && (
          <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/75 bg-background/55 px-3 py-1 text-[13px] text-muted-foreground md:text-sm">
            <Clock className="w-4 h-4 text-primary" />
            {currentTime}
          </div>
        )}
      </div>

      <div className="border-t border-border/60 pt-3">
        {isCurrentWeek ? (
          isOpen && peopleToday.length > 0 ? (
            <p className="text-[15px] leading-6 md:text-[16px]">
              <span className="text-muted-foreground">On duty now:</span>{" "}
              <span className="font-semibold text-foreground">{peopleToday.join(", ")}</span>
            </p>
          ) : isOpen ? (
            <p className="text-[15px] leading-6 text-muted-foreground md:text-[16px]">No one assigned today.</p>
          ) : (
            <p className="text-[15px] leading-6 text-muted-foreground md:text-[16px]">Outside business hours.</p>
          )
        ) : (
          <p className="text-[15px] leading-6 text-muted-foreground md:text-[16px]">View the upcoming schedule below.</p>
        )}
      </div>
    </div>
  );
}
