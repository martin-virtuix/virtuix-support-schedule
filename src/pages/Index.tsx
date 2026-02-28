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
    <div className="min-h-screen bg-background relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(86,130,3,0.13),transparent_40%)]" />
      <div className="pointer-events-none absolute inset-0 ambient-grid opacity-[0.16]" />

      <div className="relative z-10 border-b border-border/50 bg-gradient-to-b from-[#568203]/28 via-[#568203]/9 to-transparent backdrop-blur-sm">
        <div className="container max-w-[2200px] py-4 px-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
            <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
          </div>
          <Button asChild variant="secondary" size="sm">
            <Link to="/hub">Login to Support Hub</Link>
          </Button>
        </div>
      </div>

      <div className="container max-w-[2200px] py-8 px-4 relative z-10 space-y-7">
        <header className="surface-panel reveal-up p-6 md:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <p className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary md:text-[11px]">
                Public Schedule
              </p>
              <h1 className="font-display text-3xl sm:text-4xl md:text-5xl xl:text-6xl font-semibold tracking-tight leading-[1.05]">
                Omni Arena and Omni One
                <span className="block text-gradient">Support Coverage</span>
              </h1>
              <p className="max-w-3xl text-[15px] leading-7 text-muted-foreground md:text-[17px]">
                Live weekly support staffing for public visibility. Current and upcoming coverage is sourced from the operations sheet and updates automatically.
              </p>
            </div>
            <div className="grid gap-2 text-sm min-w-[220px]">
              <div className="rounded-lg border border-border/70 bg-background/45 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Current time</p>
                <p className="text-lg font-semibold leading-tight md:text-xl">{currentTimeLabel}</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/45 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Coverage owners</p>
                <p className="font-medium leading-tight md:text-[15px]">Martin and Jonathan</p>
              </div>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-7">
          <section className="surface-panel reveal-up reveal-delay-1 p-5 md:p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[12px] md:text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Current Week ({getWeekRange(0)})
              </h2>
              <span className="inline-flex items-center rounded-full border border-primary/35 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-primary">
                Live
              </span>
            </div>
            <WeekCard bundle={currentBundle} isCurrentWeek={true} />
            <ScheduleTable bundle={currentBundle} highlightToday={true} />
          </section>

          <section className="surface-panel reveal-up reveal-delay-2 p-5 md:p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[12px] md:text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Next Week ({getWeekRange(1)})
              </h2>
              <span className="inline-flex items-center rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Planned
              </span>
            </div>
            <WeekCard bundle={nextBundle} isCurrentWeek={false} />
            <ScheduleTable bundle={nextBundle} highlightToday={false} />
          </section>
        </div>

        <footer className="surface-panel py-3.5 px-5 text-center text-[13px] md:text-sm text-muted-foreground">
          Operational schedule feed for Omni support coverage. Data refreshes automatically from the source sheet.
        </footer>
      </div>
    </div>
  );
}
