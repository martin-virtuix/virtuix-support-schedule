import omniOneSquareLogo from "@/assets/omnione_logo_square.png";
import virtuixLogoWhite from "@/assets/virtuix_logo_white.png";
import { cn } from "@/lib/utils";

type BrandLockupProps = {
  size?: "sm" | "md";
  showOmniOne?: boolean;
  accessoryLabel?: string;
  className?: string;
};

export function BrandLockup({
  size = "md",
  showOmniOne = true,
  accessoryLabel,
  className,
}: BrandLockupProps) {
  const virtuixImageClassName = size === "sm" ? "h-6" : "h-7";
  const omniOneImageClassName = size === "sm" ? "h-5" : "h-6";
  const wordmarkClassName = size === "sm" ? "text-[1.35rem]" : "text-[1.65rem]";
  const wordmarkShellClassName = size === "sm" ? "px-3 py-1.5" : "px-4 py-2";
  const omniOneShellClassName = size === "sm" ? "h-9 px-2.5" : "h-10 px-3";
  const accessoryClassName = size === "sm"
    ? "px-2.5 py-1 text-[10px] tracking-[0.16em]"
    : "px-3 py-1.5 text-[11px] tracking-[0.16em]";

  return (
    <div className={cn(size === "sm" ? "flex items-center gap-2.5" : "flex items-center gap-3.5", className)}>
      <img src={virtuixLogoWhite} alt="Virtuix" className={cn("hidden w-auto dark:block", virtuixImageClassName)} />
      <span
        className={cn(
          "inline-flex items-center rounded-full border border-border/80 bg-card/88 shadow-[0_16px_30px_-24px_rgba(15,23,42,0.3)] dark:hidden",
          wordmarkShellClassName,
        )}
      >
        <span className={cn("font-display font-semibold leading-none tracking-[-0.06em] text-foreground", wordmarkClassName)}>
          Virtuix
        </span>
      </span>

      {showOmniOne ? (
        <span className={cn("brand-logo-shell", omniOneShellClassName)}>
          <img src={omniOneSquareLogo} alt="Omni One" className={cn("w-auto", omniOneImageClassName)} />
        </span>
      ) : null}

      {accessoryLabel ? (
        <span className={cn("rounded-full border border-border/70 bg-card/72 font-semibold uppercase text-muted-foreground", accessoryClassName)}>
          {accessoryLabel}
        </span>
      ) : null}
    </div>
  );
}
