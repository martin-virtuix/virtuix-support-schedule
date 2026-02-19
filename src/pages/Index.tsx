import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { WeekCard } from "@/components/schedule/WeekCard";
import { ScheduleTable } from "@/components/schedule/ScheduleTable";
import { Button } from "@/components/ui/button";
import {
  ScheduleBundle,
  CURRENT_WEEK_CSV_URL,
  NEXT_WEEK_CSV_URL,
  loadScheduleBundle,
} from "@/lib/scheduleData";
import omniOneSquareLogo from "@/assets/omnione_logo_square.png";
import virtuixLogoWhite from "@/assets/virtuix_logo_white.png";

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
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(86,130,3,0.12),transparent_44%)]" />
      <div className="bg-gradient-to-b from-[#568203]/30 via-[#568203]/10 to-transparent">
        <div className="container max-w-6xl py-4 px-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
            <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
          </div>
          <Button asChild variant="secondary" size="sm">
            <Link to="/hub">Login to Support Hub</Link>
          </Button>
        </div>
      </div>

      <div className="container max-w-6xl py-8 px-4 relative z-10">
        <header className="text-center mb-8 rounded-2xl border bg-card/70 backdrop-blur-sm px-5 py-7 md:px-8">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight mb-3">
            Omni Arena & Omni One Support Schedule
          </h1>
          <p className="text-sm text-muted-foreground mt-3">
            Live weekly coverage view for public support operations.
          </p>
        </header>

        {/* Week Panels */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Current Week */}
          <div className="space-y-4 rounded-2xl border bg-card/50 backdrop-blur-sm p-4 md:p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Current week ({getWeekRange(0)})
            </h2>
            <WeekCard bundle={currentBundle} isCurrentWeek={true} />
            <ScheduleTable bundle={currentBundle} highlightToday={true} />
          </div>

          {/* Next Week */}
          <div className="space-y-4 rounded-2xl border bg-card/50 backdrop-blur-sm p-4 md:p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Next week ({getWeekRange(1)})
            </h2>
            <WeekCard bundle={nextBundle} isCurrentWeek={false} />
            <ScheduleTable bundle={nextBundle} highlightToday={false} />
          </div>
        </div>

        {/* Footer */}
        <footer className="mt-8 text-center text-sm text-muted-foreground">
          Schedule for Martin & Jonathan • Autoupdates based on current day and time
        </footer>
      </div>
    </div>
  );
}
