import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import virtuixLogoWhite from "@/assets/virtuix_logo_white.png";
import omniOneSquareLogo from "@/assets/omnione_logo_square.png";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(86,130,3,0.15),transparent_38%)]" />
      <div className="pointer-events-none absolute inset-0 ambient-grid opacity-[0.15]" />

      <div className="relative z-10 border-b border-border/50 bg-gradient-to-b from-[#568203]/24 via-[#568203]/8 to-transparent backdrop-blur-sm">
        <div className="container max-w-[2200px] py-4 px-4 flex items-center gap-3">
          <img src={virtuixLogoWhite} alt="Virtuix" className="h-7 w-auto" />
          <img src={omniOneSquareLogo} alt="Omni One" className="h-7 w-auto" />
        </div>
      </div>

      <div className="container max-w-3xl px-4 py-16 relative z-10">
        <section className="surface-panel reveal-up p-8 md:p-10 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Navigation</p>
          <h1 className="mt-3 font-display text-5xl md:text-6xl font-semibold leading-none">404</h1>
          <p className="mt-4 text-[15px] md:text-[17px] leading-7 text-muted-foreground">
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
