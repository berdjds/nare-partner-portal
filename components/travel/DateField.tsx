"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDisplayDate, isValidISODate } from "@/lib/travel/engine/dates";

export interface DateFieldProps {
  /** ISO "YYYY-MM-DD" or "" when empty. */
  value: string;
  onChange: (iso: string) => void;
  /** ISO bounds — days outside [min, max] are disabled in the calendar. */
  min?: string;
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]; // Monday-first, ISO convention

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoOf(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

function todayIso(): string {
  const now = new Date();
  return isoOf(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Parses an ISO month ("2026-09-04" → {year: 2026, month: 8}); undefined when invalid. */
function parseMonth(iso: string | undefined): { year: number; month: number } | undefined {
  if (!iso || !isValidISODate(iso)) return undefined;
  const [y, m] = iso.split("-").map(Number);
  return { year: y, month: m - 1 };
}

/**
 * Controlled calendar picker replacing `<Input type="date">`: an Input-styled
 * trigger showing the formatted date, opening a dependency-free month calendar
 * (the project has no popover primitive, so this is a self-contained dropdown
 * with an outside-click/Escape dismiss).
 */
export default function DateField({
  value,
  onChange,
  min,
  max,
  placeholder = "Select date",
  disabled,
  id,
  className,
}: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const initial = parseMonth(value) ?? parseMonth(min) ?? parseMonth(todayIso())!;
  const [view, setView] = useState(initial);

  function openCalendar() {
    if (disabled) return;
    // Re-sync the viewed month to the current value on each open.
    setView(parseMonth(value) ?? parseMonth(min) ?? parseMonth(todayIso())!);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function shiftMonth(delta: number) {
    setView((v) => {
      const d = new Date(Date.UTC(v.year, v.month + delta, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });
  }

  function inRange(iso: string): boolean {
    // ISO strings compare lexicographically.
    if (min && iso < min) return false;
    if (max && iso > max) return false;
    return true;
  }

  function select(iso: string) {
    if (!inRange(iso)) return;
    onChange(iso);
    setOpen(false);
  }

  // Day grid: Monday-first offset + days of the viewed month (UTC math only —
  // the calendar works with calendar dates, never host-timezone instants).
  const firstOffset = (new Date(Date.UTC(view.year, view.month, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const today = todayIso();

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openCalendar())}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 py-2 text-sm shadow-sm ring-offset-background transition-colors hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
          !value && "text-muted-foreground",
        )}
      >
        <span className="truncate">{value ? formatDisplayDate(value) : placeholder}</span>
        <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-64 rounded-lg border bg-card p-3 shadow-md">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium">
              {MONTH_NAMES[view.month]} {view.year}
            </span>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {WEEKDAYS.map((d) => (
              <span key={d} className="py-1 text-[11px] font-medium text-muted-foreground">
                {d}
              </span>
            ))}
            {cells.map((day, i) => {
              if (day === null) return <span key={`blank-${i}`} />;
              const iso = isoOf(view.year, view.month, day);
              const enabled = inRange(iso);
              const selected = iso === value;
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={!enabled}
                  onClick={() => select(iso)}
                  className={cn(
                    "h-8 w-full rounded-md text-sm transition-colors",
                    selected
                      ? "bg-primary font-medium text-primary-foreground"
                      : enabled
                        ? "hover:bg-muted"
                        : "cursor-not-allowed opacity-40",
                    !selected && iso === today && "border border-primary/60 font-medium",
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
