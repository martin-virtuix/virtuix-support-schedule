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
  const now = new Date();
  const currentTimeLabel = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
    <main className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(132,202,65,0.2),transparent_38%)]" />
      <div className="pointer-events-none absolute inset-0 ambient-grid opacity-[0.16]" />

      <div className="relative z-10 border-b border-border/55 bg-gradient-to-b from-primary/30 via-primary/10 to-transparent backdrop-blur-md">
        <div className="container flex max-w-[2200px] flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div className="flex items-center gap-3">
            <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
            <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
          </div>
          <Button asChild size="sm">
            <Link to="/hub">Login to Support Hub</Link>
          </Button>
        </div>
      </div>

      <div className="container relative z-10 max-w-[2200px] space-y-6 px-4 py-6 md:space-y-7 md:py-9">
        <header className="surface-panel reveal-up relative overflow-hidden p-6 md:p-8 lg:p-10">
          <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/18 blur-3xl" />
          <div className="relative grid gap-7 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-4">
              <p className="brand-kicker">Public Support Schedule</p>
              <h1 className="font-display text-3xl font-semibold leading-[1.03] tracking-tight sm:text-4xl md:text-5xl xl:text-6xl">
                Omni Arena and Omni One
                <span className="block text-gradient">Coverage Calendar</span>
              </h1>
              <p className="max-w-3xl text-[15px] leading-7 text-muted-foreground md:text-[17px]">
                Weekly support staffing for public visibility. Current and upcoming coverage is synced from operations planning.
              </p>
            </div>

            <aside className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-1">
              <div className="surface-panel-soft p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Current Time</p>
                <p className="mt-1 text-xl font-semibold leading-tight">{currentTimeLabel}</p>
              </div>
              <div className="surface-panel-soft p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Coverage Owners</p>
                <p className="mt-1 text-sm font-medium leading-6 text-foreground md:text-[15px]">Martin and Jonathan</p>
              </div>
            </aside>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
          <section className="surface-panel reveal-up reveal-delay-1 space-y-5 p-5 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:text-[13px]">
                Current Week ({getWeekRange(0)})
              </h2>
              <span className="brand-chip border-primary/35 bg-primary/12 text-primary">Live</span>
            </div>
            <WeekCard bundle={currentBundle} isCurrentWeek={true} />
            <ScheduleTable bundle={currentBundle} highlightToday={true} />
          </section>

          <section className="surface-panel reveal-up reveal-delay-2 space-y-5 p-5 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:text-[13px]">
                Next Week ({getWeekRange(1)})
              </h2>
              <span className="brand-chip">Planned</span>
            </div>
            <WeekCard bundle={nextBundle} isCurrentWeek={false} />
            <ScheduleTable bundle={nextBundle} highlightToday={false} />
          </section>
        </div>

        <footer className="surface-panel-soft px-5 py-4 text-center text-[13px] text-muted-foreground md:text-sm">
          Operational schedule feed for Omni support coverage. Data refreshes automatically from the source sheet.
        </footer>
      </div>
    </main>
  );
}
