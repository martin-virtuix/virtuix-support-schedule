import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent text-sm font-semibold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-primary/45 bg-primary text-primary-foreground shadow-[0_16px_36px_-20px_hsl(var(--primary)/0.95)] hover:border-primary/70 hover:bg-primary/90",
        destructive: "border-destructive/45 bg-destructive text-destructive-foreground shadow-[0_16px_36px_-20px_hsl(var(--destructive)/0.92)] hover:bg-destructive/90",
        outline: "border-border/80 bg-background/55 text-foreground hover:border-primary/50 hover:bg-primary/10",
        secondary: "border-border/75 bg-secondary/85 text-secondary-foreground hover:border-border/95 hover:bg-secondary",
        ghost: "text-muted-foreground hover:border-border/55 hover:bg-muted/55 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3.5 text-[13px]",
        lg: "h-11 px-8",
        icon: "h-10 w-10 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
