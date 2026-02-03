import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WeekCard } from "@/components/schedule/WeekCard";
import { ScheduleTable } from "@/components/schedule/ScheduleTable";
import { NoSupportList } from "@/components/schedule/NoSupportList";
import {
  ScheduleBundle,
  CURRENT_WEEK_CSV_URL,
  NEXT_WEEK_CSV_URL,
  loadScheduleBundle,
} from "@/lib/scheduleData";
import omniLogo from "@/assets/omniarena-logo.png";

function getWeekRange(offset: number = 0): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  
  const monday = new Date(now.setDate(diff + offset * 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const formatDate = (date: Date) => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[date.getMonth()]} ${date.getDate()}`;
  };

  return `${formatDate(monday)} - ${formatDate(sunday)}`;
}

export default function Index() {
  const [currentBundle, setCurrentBundle] = useState<ScheduleBundle | null>(null);
  const [nextBundle, setNextBundle] = useState<ScheduleBundle | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    async function loadData() {
      try {
        const [current, next] = await Promise.all([
          loadScheduleBundle(CURRENT_WEEK_CSV_URL),
          loadScheduleBundle(NEXT_WEEK_CSV_URL),
        ]);
        setCurrentBundle(current);
        setNextBundle(next);
      } catch (err) {
        console.error("Error loading schedules:", err);
      }
    }

    loadData();

    // Update time display every minute
    const interval = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-6xl py-8 px-4">
        {/* Header */}
        <header className="text-center mb-10">
          <h1 className="text-3xl md:text-4xl font-bold mb-3">
            Omni Arena & Omni One Support Schedule
          </h1>
          <img
            src={omniLogo}
            alt="Omni Arena"
            className="h-8 md:h-10 mx-auto opacity-80"
          />
        </header>

        {/* Request Time Off Button - Hidden for now, small team */}
        <div className="hidden flex justify-center mb-8">
          <Button asChild size="lg" className="gap-2 animate-pulse-glow">
            <Link to="/request-time-off">
              <Calendar className="w-5 h-5" />
              Request Time Off
            </Link>
          </Button>
        </div>

        {/* Week Panels */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Current Week */}
          <div className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Current week ({getWeekRange(0)})
            </h2>
            <WeekCard bundle={currentBundle} isCurrentWeek={true} />
            <ScheduleTable bundle={currentBundle} highlightToday={true} />
          </div>

          {/* Next Week */}
          <div className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Next week ({getWeekRange(1)})
            </h2>
            <WeekCard bundle={nextBundle} isCurrentWeek={false} />
            <ScheduleTable bundle={nextBundle} highlightToday={false} />
          </div>
        </div>

        {/* No Support List */}
        <NoSupportList />

        {/* Footer */}
        <footer className="mt-8 text-center text-sm text-muted-foreground">
          Schedule for Martin & Jonathan • Autoupdates based on current day and time
        </footer>
      </div>
    </div>
  );
}
