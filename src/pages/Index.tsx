import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { BrandLockup } from "@/components/BrandLockup";
import { WeekCard } from "@/components/schedule/WeekCard";
import { ScheduleTable } from "@/components/schedule/ScheduleTable";
import { ArenaSitesTable } from "@/components/schedule/ArenaSitesTable";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import {
  CURRENT_WEEK_CSV_URL,
  NEXT_WEEK_CSV_URL,
  getArenaSites,
  type ArenaSite,
  ScheduleBundle,
  displayOrder,
  formatHours,
  isOpenNow,
  keyByIndex,
  loadScheduleBundle,
} from "@/lib/scheduleData";

function getStaffedDayCount(bundle: ScheduleBundle | null): number {
  if (!bundle) return 0;
  return displayOrder.reduce((count, dayKey) => count + (bundle.schedule[dayKey]?.length ? 1 : 0), 0);
}

function getTodaySnapshot(bundle: ScheduleBundle | null) {
  const now = new Date();
  const todayKey = keyByIndex[now.getDay()];
  const people = bundle?.schedule[todayKey] || [];
  const note = bundle?.notesByDay[todayKey] || "No additional coverage note.";

  return {
    hours: bundle ? formatHours(todayKey, bundle.businessHours) : "Loading hours",
    onDutyLabel: people.length > 0 ? people.join(", ") : "No one scheduled",
    note,
    isOpen: bundle ? isOpenNow(todayKey, now, bundle.businessHours) : false,
  };
}

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

function isNoSupportStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "no support" || normalized === "nosupport";
}

export default function Index() {
  const [currentBundle, setCurrentBundle] = useState<ScheduleBundle | null>(null);
  const [nextBundle, setNextBundle] = useState<ScheduleBundle | null>(null);
  const [sites, setSites] = useState<ArenaSite[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const now = new Date();
  const currentTimeLabel = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const todaySnapshot = getTodaySnapshot(currentBundle);
  const currentWeekStaffedDays = getStaffedDayCount(currentBundle);
  const nextWeekStaffedDays = getStaffedDayCount(nextBundle);
  const noSupportSitesCount = sites.filter((site) => isNoSupportStatus(site.currentQuarterStatus)).length;

  const overviewCards = [
    {
      label: "Current Time",
      value: currentTimeLabel,
      detail: todaySnapshot.isOpen ? "Within business hours" : "Outside business hours",
    },
    {
      label: "Today's Hours",
      value: todaySnapshot.hours,
      detail: todaySnapshot.isOpen ? "Support window is live" : "No live coverage right now",
    },
    {
      label: "On Duty Today",
      value: todaySnapshot.onDutyLabel,
      detail: "Pulled directly from the weekly schedule sheet",
    },
    {
      label: "Staffed Days",
      value: `${currentWeekStaffedDays}/7`,
      detail: nextBundle ? `Next week planned: ${nextWeekStaffedDays}/7 days` : "Loading next-week plan",
    },
  ];

  useEffect(() => {
    async function loadData() {
      try {
        setLoadError(null);
        const [current, next] = await Promise.all([
          loadScheduleBundle(CURRENT_WEEK_CSV_URL),
          loadScheduleBundle(NEXT_WEEK_CSV_URL),
        ]);
        setCurrentBundle(current);
        setNextBundle(next);
      } catch (err) {
        console.error("Error loading schedules:", err);
        setLoadError(err instanceof Error ? err.message : "Unable to load the support schedule right now.");
      }
    }

    loadData();

    // Update time display every minute
    const interval = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let mounted = true;
    setSitesLoading(true);
    setSitesError(null);

    getArenaSites()
      .then((data) => {
        if (mounted) setSites(data);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setSitesError(error instanceof Error ? error.message : "Unable to load Omni Arena site coverage right now.");
      })
      .finally(() => {
        if (mounted) setSitesLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(132,202,65,0.2),transparent_38%)]" />
      <div className="pointer-events-none absolute inset-0 ambient-grid opacity-[0.16]" />

      <div className="relative z-10 border-b border-border/55 bg-gradient-to-b from-primary/30 via-primary/10 to-transparent backdrop-blur-md">
        <div className="container flex max-w-[2200px] flex-wrap items-center justify-between gap-3 px-4 py-4">
          <BrandLockup />
          <div className="flex flex-wrap items-center gap-2">
            <ThemeToggle />
            <Button asChild size="sm" variant="outline">
              <a href="#current-week">View Current Week</a>
            </Button>
            <Button asChild size="sm">
              <Link to="/hub">Open Support Hub</Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="container relative z-10 max-w-[2200px] space-y-6 px-4 py-6 md:space-y-7 md:py-9">
        <header className="surface-panel reveal-up relative overflow-hidden p-6 md:p-8 lg:p-10">
          <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/18 blur-3xl" />
          <div className="relative space-y-7">
            <div className="max-w-4xl space-y-4">
              <p className="brand-kicker">Public Support Schedule</p>
              <h1 className="font-display text-3xl font-semibold leading-[1.03] tracking-tight sm:text-4xl md:text-5xl xl:text-6xl">
                Support
                <span className="block text-gradient">Coverage Calendar</span>
              </h1>
              <p className="max-w-3xl text-[15px] leading-7 text-muted-foreground md:text-[17px]">
                Weekly support staffing for Omni Arena and Omni One. Use this page to confirm who is covering support
                this week, what today&apos;s hours are, and what is planned next.
              </p>
              <div className="flex flex-wrap gap-2">
                <span className="brand-chip border-primary/35 bg-primary/12 text-primary">Synced from operations sheet</span>
                <span className="brand-chip">Public visibility only</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button asChild>
                  <a href="#current-week">
                    Review Coverage
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </a>
                </Button>
                <Button asChild variant="ghost">
                  <Link to="/hub">Employee tools</Link>
                </Button>
              </div>
            </div>

            <aside className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
              {overviewCards.map((card) => (
                <div key={card.label} className="surface-panel-soft min-h-[138px] p-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{card.label}</p>
                  <p className="mt-2 text-lg font-semibold leading-snug text-foreground md:text-xl xl:text-[1.35rem]">{card.value}</p>
                  <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{card.detail}</p>
                </div>
              ))}
            </aside>
          </div>

          <div className="relative mt-6 rounded-2xl border border-border/65 bg-card/68 px-4 py-3 text-sm text-muted-foreground md:px-5">
            <span className="font-medium text-foreground">Today&apos;s note:</span> {todaySnapshot.note}
          </div>
        </header>

        {loadError ? (
          <section className="surface-panel-soft px-5 py-4 text-sm text-destructive">
            Schedule data could not be loaded. {loadError}
          </section>
        ) : null}

        <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
          <section id="current-week" className="surface-panel reveal-up reveal-delay-1 space-y-5 p-5 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:text-[13px]">
                  Current Week ({getWeekRange(0)})
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">Best source for who is covering support right now.</p>
              </div>
              <span className="brand-chip border-primary/35 bg-primary/12 text-primary">Live</span>
            </div>
            <WeekCard bundle={currentBundle} isCurrentWeek={true} />
            <ScheduleTable bundle={currentBundle} highlightToday={true} />
          </section>

          <section className="surface-panel reveal-up reveal-delay-2 space-y-5 p-5 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:text-[13px]">
                  Next Week ({getWeekRange(1)})
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">Use this to confirm upcoming handoffs and gaps before the week begins.</p>
              </div>
              <span className="brand-chip">Planned</span>
            </div>
            <WeekCard bundle={nextBundle} isCurrentWeek={false} />
            <ScheduleTable bundle={nextBundle} highlightToday={false} />
          </section>
        </div>

        <section className="surface-panel reveal-up reveal-delay-3 space-y-5 p-5 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:text-[13px]">
                Omni Arena Sites Not Supported (Pending Omni Care Payment)
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Only venues currently flagged with the No Support status are shown here.
              </p>
            </div>
            <span className="brand-chip border-destructive/35 bg-destructive/12 text-destructive">
              {sitesLoading ? "Loading" : `${noSupportSitesCount} No Support`}
            </span>
          </div>
          <ArenaSitesTable
            sites={sites}
            loading={sitesLoading}
            error={sitesError}
            lockedStatusFilter="no-support"
            initialStatusFilter="no-support"
          />
        </section>

        <footer className="surface-panel-soft px-5 py-4 text-center text-[13px] text-muted-foreground md:text-sm">
          Operational schedule feed for Omni support coverage. Data refreshes automatically from the source sheet.
        </footer>
      </div>
    </main>
  );
}
