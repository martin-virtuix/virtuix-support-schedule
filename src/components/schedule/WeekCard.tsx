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
      <div className="glass-card rounded-xl p-6 animate-pulse">
        <div className="h-6 bg-muted rounded w-24 mb-4" />
        <div className="h-8 bg-muted rounded w-32 mb-2" />
        <div className="h-4 bg-muted rounded w-48" />
      </div>
    );
  }

  return (
    <div className="glass-card rounded-xl p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <StatusPill 
            isOpen={isCurrentWeek ? isOpen : false} 
            label={isCurrentWeek ? undefined : "Preview"} 
          />
          <h3 className="text-xl font-bold text-foreground">
            {isCurrentWeek ? dayLabel[todayKey] : "Next week"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {isCurrentWeek 
              ? formatHours(todayKey, bundle.businessHours)
              : "Schedule loaded from sheet"
            }
          </p>
        </div>
        {isCurrentWeek && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="w-4 h-4" />
            {currentTime}
          </div>
        )}
      </div>

      <div className="pt-2 border-t border-border/50">
        {isCurrentWeek ? (
          isOpen && peopleToday.length > 0 ? (
            <p className="text-sm">
              <span className="text-muted-foreground">On duty now:</span>{" "}
              <span className="font-medium text-foreground">{peopleToday.join(", ")}</span>
            </p>
          ) : isOpen ? (
            <p className="text-sm text-muted-foreground">No one assigned today.</p>
          ) : (
            <p className="text-sm text-muted-foreground">Outside business hours.</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">View the upcoming schedule below.</p>
        )}
      </div>
    </div>
  );
}
