import { cn } from "@/lib/utils";

interface StatusPillProps {
  isOpen: boolean;
  label?: string;
}

export function StatusPill({ isOpen, label }: StatusPillProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.11em]",
        isOpen
          ? "border-success/45 bg-success/14 text-emerald-300"
          : "border-destructive/45 bg-destructive/14 text-red-300",
      )}
    >
      <span
        className={cn(
          "w-2 h-2 rounded-full animate-pulse",
          isOpen ? "bg-success" : "bg-destructive",
        )}
      />
      {label || (isOpen ? "Open" : "Closed")}
    </div>
  );
}
