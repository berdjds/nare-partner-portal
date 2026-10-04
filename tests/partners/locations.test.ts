/**
 * Location data for the partner application form (lib/partners/locations.ts).
 *
 * - COUNTRIES offers the main source markets first ("Main markets" group),
 *   then the complete alphabetical list of sovereign countries and main
 *   territories ("All countries" group).
 * - The full list has no duplicates, is sorted alphabetically, contains every
 *   main market, and has a plausible size for a complete country list.
 * - CITY_SUGGESTIONS covers exactly the main markets (6–12 cities each, no
 *   duplicate cities), and every key is a listed country.
 * - getCitySuggestions returns the suggestions for a known country and []
 *   for anything else.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_COUNTRIES,
  CITY_SUGGESTIONS,
  COUNTRIES,
  MAIN_MARKETS,
  compareCountryNames,
  getCitySuggestions,
} from "@/lib/partners/locations";

function expectNoDuplicates(values: readonly string[], label: string) {
  expect(new Set(values).size, `${label} contains duplicates`).toBe(values.length);
}

describe("COUNTRIES groups", () => {
  it("offers the main markets first, then the full alphabetical list", () => {
    expect(COUNTRIES).toHaveLength(2);
    expect(COUNTRIES[0].label).toBe("Main markets");
    expect(COUNTRIES[1].label).toBe("All countries");
    expect(COUNTRIES[0].countries).toBe(MAIN_MARKETS);
    expect(COUNTRIES[1].countries).toBe(ALL_COUNTRIES);
  });

  it("lists exactly the expected main source markets", () => {
    const expected = [
      "Armenia",
      "Georgia",
      "United Arab Emirates",
      "Saudi Arabia",
      "Qatar",
      "Kuwait",
      "Bahrain",
      "Oman",
      "Iran",
      "Iraq",
      "Jordan",
      "Lebanon",
      "Egypt",
      "Turkey",
      "Russia",
      "Kazakhstan",
      "Uzbekistan",
      "Azerbaijan",
      "India",
      "Pakistan",
      "United Kingdom",
      "Germany",
      "France",
      "Italy",
      "Spain",
      "United States",
      "Canada",
      "China",
    ];
    expect([...MAIN_MARKETS]).toEqual(expected);
  });

  it("has no duplicate countries within either group", () => {
    expectNoDuplicates(MAIN_MARKETS, "MAIN_MARKETS");
    expectNoDuplicates(ALL_COUNTRIES, "ALL_COUNTRIES");
  });
});

describe("ALL_COUNTRIES", () => {
  it("is sorted alphabetically", () => {
    const sorted = [...ALL_COUNTRIES].sort(compareCountryNames);
    expect([...ALL_COUNTRIES]).toEqual(sorted);
  });

  it("contains every main market", () => {
    for (const market of MAIN_MARKETS) {
      expect(ALL_COUNTRIES).toContain(market);
    }
  });

  it("has a plausible size for a complete list of countries and main territories", () => {
    // 193 UN members + observers + the main territories; anything far outside
    // this range means the list is incomplete or padded.
    expect(ALL_COUNTRIES.length).toBeGreaterThanOrEqual(190);
    expect(ALL_COUNTRIES.length).toBeLessThanOrEqual(260);
  });

  it("contains no empty or whitespace-only names", () => {
    for (const country of ALL_COUNTRIES) {
      expect(country.trim().length).toBeGreaterThan(0);
      expect(country).toBe(country.trim());
    }
  });
});

describe("CITY_SUGGESTIONS", () => {
  it("covers exactly the main markets", () => {
    expect(Object.keys(CITY_SUGGESTIONS).sort(compareCountryNames)).toEqual(
      [...MAIN_MARKETS].sort(compareCountryNames),
    );
  });

  it("uses only countries that are in the full list", () => {
    for (const country of Object.keys(CITY_SUGGESTIONS)) {
      expect(ALL_COUNTRIES, `suggestion key ${country} is not a listed country`).toContain(
        country,
      );
    }
  });

  it("has 6-12 unique cities per country", () => {
    for (const [country, cities] of Object.entries(CITY_SUGGESTIONS)) {
      expect(
        cities.length,
        `${country} should have 6-12 city suggestions, has ${cities.length}`,
      ).toBeGreaterThanOrEqual(6);
      expect(cities.length, `${country} should have 6-12 city suggestions`).toBeLessThanOrEqual(
        12,
      );
      expectNoDuplicates(cities, `cities of ${country}`);
    }
  });
});

describe("getCitySuggestions", () => {
  it("returns the suggestions for a known country", () => {
    expect(getCitySuggestions("United Arab Emirates")).toEqual(
      CITY_SUGGESTIONS["United Arab Emirates"],
    );
    expect(getCitySuggestions("Armenia")).toContain("Yerevan");
  });

  it("returns an empty list for unknown countries", () => {
    expect(getCitySuggestions("Atlantis")).toEqual([]);
    expect(getCitySuggestions("")).toEqual([]);
    // A real country that is not a main market has no suggestions.
    expect(getCitySuggestions("Portugal")).toEqual([]);
  });
});
