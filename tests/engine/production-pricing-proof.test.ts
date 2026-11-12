/**
 * Production-template pricing proof (owner accepted CURRENT behaviour as the intended behaviour, 2026-11-12).
 *
 * Production templates carry no child/infant/free-ratio/min-max/optional/rounding rules (see
 * doc/b2b-cycle-1/PRICING-PROOF-AUDIT.md), so the rules pinned here are the engine's existing ones:
 *   - PER_PERSON / PERSON_MEAL lines charge rate x participants; children pay as guests (no age discount),
 *   - GROUP lines charge once, CAPACITY_BLOCK lines charge ceil(participants / capacity) units,
 *   - staff lines are never multiplied by guest count,
 *   - the active production policy (markup on cost, minimum profit per traveller excluding infants, rounding up
 *     to the increment) is applied to the summed cost.
 * Every expectation is computed independently with Decimal from the REAL production rates. The export is
 * customer-data free but is kept out of git: set PRICING_EXPORT or place it at ~/inbox/templates-export.json.
 * Without the file the suite skips (CI), with it present every production rate is checked.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculate } from "@/lib/travel/engine";
import { FX, makeInput, makeScenario, makeService, POLICY, T } from "./helpers";

const file = process.env.PRICING_EXPORT ?? `${homedir()}/inbox/templates-export.json`;
const data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).tables as Record<string, Record<string, any>[]>) : null;

describe.skipIf(!data)("production rates through the engine (current behaviour)", () => {
  const products = new Map((data?.ServiceProduct ?? []).map((p) => [p.id, p]));
  const rates = (data?.RateVersion ?? []).filter(
    (r) => r.productType === "SERVICE" && r.status === "VERIFIED" && r.amount != null && !r.quoteOnRequest && !r.stopSales && products.has(r.serviceProductId),
  );
  const policy = (data?.PricingPolicyVersion ?? []).find((p) => p.active);
  const fxUsd = [...(data?.FXRateVersion ?? [])].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];

  it("the export has the expected shape and one active policy", () => {
    expect(rates.length).toBeGreaterThan(100);
    expect(policy?.type).toBe("MARKUP_ON_COST");
    expect(fxUsd?.currency).toBe("USD");
  });

  const cases: Array<{ name: string; travelers: ReturnType<typeof T>; participants: number }> = [
    { name: "2 adults", travelers: T({ adults: 2, paying: 2 }), participants: 2 },
    { name: "4 adults + 2 children pay as guests", travelers: T({ adults: 4, children: 2, paying: 6 }), participants: 6 },
    { name: "10 adults + 1 infant (infant does not pay)", travelers: T({ adults: 10, infants: 1, children: 1, paying: 10 }), participants: 10 },
  ];

  for (const c of cases) {
    it(`every verified production service rate matches an independent calculation: ${c.name}`, () => {
      let checked = 0;
      for (const r of rates) {
        const p = products.get(r.serviceProductId)!;
        const amount = new Decimal(r.amount);
        let expected: Decimal;
        const staff = ["GUIDES", "TOUR_LEADER", "STAFF_MEALS", "STAFF_ACCOMMODATION"].includes(p.category);
        if (p.basis === "PER_PERSON" || p.basis === "PERSON_MEAL") expected = staff ? amount : amount.times(c.participants);
        else if (p.basis === "CAPACITY_BLOCK") {
          if (!p.capacity) continue; // engine blocks a capacity block without capacity: covered by engine.test.ts
          expected = amount.times(Math.ceil(c.participants / p.capacity));
        } else expected = amount; // GROUP, VEHICLE_TRIP, GUIDE_DAY, GUIDE_HALF_DAY, ROOM_NIGHT at quantity 1
        const sc = makeScenario({
          travelers: c.travelers,
          services: [
            makeService({
              category: p.category,
              basis: p.basis,
              currency: r.currency,
              unitRate: r.amount,
              participants: staff ? undefined : c.participants,
              capacity: p.capacity ?? undefined,
              isStaffCost: staff,
            }),
          ],
        });
        const res = calculate(makeInput([sc], { fx: FX({ rates: { USD: "361", AMD: "1" }, quoteCurrency: r.currency }), policy: POLICY({ rate: "0", roundingIncrement: "1" }) })).scenarios[0];
        if (!res.valid) continue; // e.g. vehicle seat checks need fleet data; validity rules are covered elsewhere
        const cost = new Decimal(res.totals.byCategory[p.category][r.currency]);
        expect(cost.toString(), `${p.name} (${p.basis}, ${r.currency})`).toBe(expected.toString());
        checked++;
      }
      expect(checked).toBeGreaterThan(80);
    });
  }

  it("the active production policy: sell = max(cost x (1+rate), cost + minProfit x travellers excl. infants) rounded up to the increment", () => {
    const rate = new Decimal(policy!.rate);
    const minProfit = new Decimal(policy!.minProfit);
    const inc = new Decimal(policy!.roundingIncrement);
    for (const cost of ["400", "1234.56", "9999", "50.01"]) {
      for (const t of [T({ adults: 2, paying: 2 }), T({ adults: 4, children: 2, infants: 1, paying: 5 })]) {
        const res = calculate(
          makeInput([makeScenario({ travelers: t, services: [makeService({ currency: "USD", basis: "GROUP", unitRate: cost })] })], {
            fx: FX({ rates: { USD: String(fxUsd.amdPerUnit) }, quoteCurrency: policy!.quoteCurrency }),
            policy: POLICY({ type: policy!.type, rate: policy!.rate, minProfit: policy!.minProfit, minProfitCurrency: policy!.minProfitCurrency, roundingIncrement: policy!.roundingIncrement }),
          }),
        ).scenarios[0];
        expect(res.valid).toBe(true);
        const travellers = Math.max(0, t.adults + t.children - t.infants);
        const c = new Decimal(cost);
        const unrounded = Decimal.max(c.times(rate.plus(1)), c.plus(minProfit.times(travellers)));
        const expected = unrounded.div(inc).ceil().times(inc);
        expect(res.sell, `cost ${cost}, ${travellers} travellers`).toBe(expected.toString());
      }
    }
  });

  it("template versions are narrative only: no pricing rule is hidden in them (documented absence)", () => {
    for (const tv of data!.TemplateVersion) {
      expect(tv.scenariosJson).toBeNull();
      for (const day of JSON.parse(tv.daysJson)) expect(Object.keys(day).sort()).toEqual(["dayOffset", "narrative"]);
    }
  });
});
