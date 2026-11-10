"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TravelerSetupView } from "./types";

/**
 * Booking.com-style occupancy editor: adults/children steppers with a per-child
 * "age at return" dropdown, plus a compact row of plain numeric inputs for the
 * counts the occupancy pickers don't model (infants, paying, complimentary,
 * leaders, staff).
 *
 * `childAges` is kept in sync with `children`: growing pads with a default
 * age, shrinking truncates. `paying` auto-follows `adults + children` only
 * while it still equals the previous sum — a manually overridden value is
 * never clobbered. `infants` auto-follows the count of childAges at or below
 * TravelSettings.infantMaxAge (fetched here) with the same override rule
 * (v0.11.0).
 */

const DEFAULT_CHILD_AGE = 7;
const CHILD_AGE_OPTIONS = Array.from({ length: 13 }, (_, i) => i); // 0–12
const EXTRA_KEYS = ["infants", "paying", "complimentary", "leaders", "staff"] as const;

interface TravelerSetupEditorProps {
  value: TravelerSetupView;
  onChange: (t: TravelerSetupView) => void;
}

export default function TravelerSetupEditor({ value, onChange }: TravelerSetupEditorProps) {
  // The schema default is 2; the fetch refines it to the configured value.
  const [infantMaxAge, setInfantMaxAge] = useState(2);

  useEffect(() => {
    axios
      .get("/api/travel/settings")
      .then((res) => {
        const max = res.data?.settings?.infantMaxAge;
        if (typeof max === "number") setInfantMaxAge(max);
      })
      .catch(() => null); // keep the default when settings are unreachable
  }, []);

  const derivedInfants = (ages: number[]) => ages.filter((a) => a <= infantMaxAge).length;

  function setCount(key: "adults" | "children", next: number) {
    const clamped = Math.max(key === "adults" ? 1 : 0, next);
    const patch: Partial<TravelerSetupView> = { [key]: clamped };
    const prevSum = value.adults + value.children;
    const nextAdults = key === "adults" ? clamped : value.adults;
    const nextChildren = key === "children" ? clamped : value.children;
    if (value.paying === prevSum) patch.paying = nextAdults + nextChildren;
    if (key === "children") {
      const ages = (value.childAges ?? []).slice(0, clamped);
      while (ages.length < clamped) ages.push(DEFAULT_CHILD_AGE);
      patch.childAges = ages;
      if (value.infants === derivedInfants(value.childAges ?? [])) {
        patch.infants = derivedInfants(ages);
      }
    }
    onChange({ ...value, ...patch });
  }

  function setChildAge(index: number, age: number) {
    const ages = [...(value.childAges ?? [])];
    while (ages.length <= index) ages.push(DEFAULT_CHILD_AGE);
    ages[index] = age;
    const patch: Partial<TravelerSetupView> = { childAges: ages };
    if (value.infants === derivedInfants(value.childAges ?? [])) {
      patch.infants = derivedInfants(ages);
    }
    onChange({ ...value, ...patch });
  }

  function setExtra(key: (typeof EXTRA_KEYS)[number], raw: string) {
    const n = Math.max(0, Number.parseInt(raw || "0", 10) || 0);
    onChange({ ...value, [key]: n });
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <StepperRow label="Adults" count={value.adults} onStep={(d) => setCount("adults", value.adults + d)} />
        <StepperRow label="Children" count={value.children} onStep={(d) => setCount("children", value.children + d)} />
      </div>
      {value.children > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: value.children }, (_, i) => (
            <div key={i} className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-1.5">
              <span className="text-sm">Child {i + 1} — age at return</span>
              <Select
                value={String(value.childAges?.[i] ?? DEFAULT_CHILD_AGE)}
                onValueChange={(v) => setChildAge(i, Number(v))}
              >
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHILD_AGE_OPTIONS.map((age) => (
                    <SelectItem key={age} value={String(age)}>
                      {age}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {EXTRA_KEYS.map((k) => (
          <div key={k}>
            <span className="text-xs text-muted-foreground">
              {k === "infants" ? `infants (auto ≤ age ${infantMaxAge})` : k}
            </span>
            <Input type="number" min={0} value={value[k]} aria-label={k === "infants" ? "Infants" : k[0].toUpperCase() + k.slice(1)} onChange={(e) => setExtra(k, e.target.value)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepperRow({ label, count, onStep }: { label: string; count: number; onStep: (delta: number) => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" aria-label={`Decrease ${label.toLowerCase()}`} onClick={() => onStep(-1)}>
          −
        </Button>
        <span className="w-6 text-center text-sm tabular-nums">{count}</span>
        <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" aria-label={`Increase ${label.toLowerCase()}`} onClick={() => onStep(1)}>
          +
        </Button>
      </div>
    </div>
  );
}
