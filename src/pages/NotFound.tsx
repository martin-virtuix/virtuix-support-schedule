import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { BrandLockup } from "@/components/BrandLockup";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(132,202,65,0.22),transparent_38%)]" />
      <div className="pointer-events-none absolute inset-0 ambient-grid opacity-[0.15]" />

      <div className="relative z-10 border-b border-border/50 bg-gradient-to-b from-primary/28 via-primary/10 to-transparent backdrop-blur-sm">
        <div className="container flex max-w-[2200px] items-center justify-between gap-3 px-4 py-4">
          <BrandLockup />
          <ThemeToggle />
        </div>
      </div>

      <div className="container relative z-10 max-w-3xl px-4 py-14 md:py-16">
        <section className="surface-panel reveal-up relative overflow-hidden p-8 text-center md:p-10">
          <div className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full bg-primary/16 blur-3xl" />
          <p className="brand-kicker">Navigation</p>
          <h1 className="mt-4 font-display text-5xl font-semibold leading-none md:text-6xl">404</h1>
          <p className="mt-4 text-[15px] leading-7 text-muted-foreground md:text-[17px]">
            The requested page does not exist or was moved. Return to the public schedule or support operations hub.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            <Button asChild>
              <Link to="/">Back to Schedule</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/hub">Open Support Hub</Link>
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
};

export default NotFound;
