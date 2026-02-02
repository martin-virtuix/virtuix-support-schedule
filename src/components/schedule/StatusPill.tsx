import { cn } from "@/lib/utils";

interface StatusPillProps {
  isOpen: boolean;
  label?: string;
}

export function StatusPill({ isOpen, label }: StatusPillProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider",
        isOpen
          ? "bg-success/15 text-success"
          : "bg-destructive/15 text-destructive"
      )}
    >
      <span
        className={cn(
          "w-2 h-2 rounded-full animate-pulse",
          isOpen ? "bg-success" : "bg-destructive"
        )}
      />
      {label || (isOpen ? "Open" : "Closed")}
    </div>
  );
}
