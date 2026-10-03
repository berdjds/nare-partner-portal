import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Status tints — the single place raw status palette classes live. Mapped
// from request/template statuses in components/travel/utils.tsx and reused by
// the toast; keep these off the primary hue so the red accent stays reserved
// for actions and the active nav state.
export const badgeStatusStyles = {
  neutral: "border-zinc-200 bg-zinc-100 text-zinc-600",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  danger: "border-red-200 bg-red-50 text-red-700",
  info: "border-sky-200 bg-sky-50 text-sky-700",
} as const;

// Text-only companions for inline status messages (error text, unsaved-changes
// hints) that are not badges: same hues as the map above, so status colour
// keeps its single home here instead of leaking raw palette classes into
// feature components.
export const badgeStatusTextStyles = {
  neutral: "text-zinc-600",
  warning: "text-amber-700",
  success: "text-emerald-700",
  danger: "text-red-700",
  info: "text-sky-700",
} as const;

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive/10 text-destructive",
        outline: "text-foreground",
        ...badgeStatusStyles,
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
