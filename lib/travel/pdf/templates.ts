/**
 * Pure HTML builders for the travel quotation PDF.
 *
 * Security: every user/content string is escaped through escapeHtml — the
 * HTML is rendered by a headless browser with full script execution, so an
 * unescaped agency name or hotel label would be an XSS/injection vector
 * inside our own renderer.
 *
 * The CLIENT document must never leak costing internals. That includes the
 * CSS: the shared stylesheet deliberately avoids the `margin` property
 * (padding is used for all spacing) so that substring checks for "margin"
 * cannot false-positive on layout rules.
 */
import Decimal from "decimal.js";
import type {
  EngineInput,
  EngineIssue,
  ScenarioEngineInput,
  ScenarioResult,
  ServiceLineInput,
  TravelerSetup,
} from "@/lib/travel/contracts";
import { buildTraceRows } from "../trace-table";
import { DEFAULT_BRAND_COLOR } from "../branding";
import type { QuotationPdfInput } from "./types";
import { formatDisplayDate, formatDisplayDateRange } from "../engine/dates";
import { displayMoneyCeil, groupMoney } from "../engine/money";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Money is authoritative as a decimal string — decimals are rendered exactly,
 * but the integer part is comma-grouped for readability (v0.13.2). Used by the
 * CLIENT quotation, where unit rates may legitimately carry decimals.
 */
function money(amount: string, currency: string): string {
  return `${escapeHtml(groupMoney(amount))} ${escapeHtml(currency)}`;
}

/**
 * INTERNAL costing document figures (v0.14.0): rounded UP to whole units and
 * comma-grouped — the internal sheet reads totals, not fractions.
 */
function internalMoney(amount: string | Decimal, currency: string): string {
  return `${escapeHtml(displayMoneyCeil(amount))} ${escapeHtml(currency)}`;
}

/** Margin is a ratio — ceiling is meaningless, so render "12.3%" (v0.14.0). */
function marginPercent(margin: string): string {
  return `${new Decimal(margin).times(100).toFixed(1)}%`;
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Scenarios are alternatives, so they are labelled Option A / B / C … */
function optionLetter(index: number): string {
  return index < 26 ? `Option ${String.fromCharCode(65 + index)}` : `Option ${index + 1}`;
}

const BASE_CSS = `
  /* Font stack carries DejaVu/Noto fallbacks because Armenian text may
     appear in destinations and hotel names. */
  html { -webkit-print-color-adjust: exact; }
  body {
    font-family: "DejaVu Sans", "Noto Sans", "Noto Sans Armenian", "Segoe UI", Arial, sans-serif;
    font-size: 11px;
    color: #1a1a1a;
    line-height: 1.45;
    padding: 0 2mm;
  }
  h1 { font-size: 19px; padding-bottom: 2mm; }
  h2 { font-size: 14px; padding-top: 5mm; padding-bottom: 1.5mm; border-bottom: 1px solid #999; }
  h3 { font-size: 12px; padding-top: 3mm; padding-bottom: 1mm; }
  p { padding-bottom: 1.5mm; }
  table { border-collapse: collapse; width: 100%; padding-top: 1mm; padding-bottom: 2mm; }
  th, td { border: 1px solid #d0d0d0; padding: 1.2mm 1.8mm; text-align: left; vertical-align: top; }
  th { background: #efefef; }
  table:not(.borderless) tbody tr:nth-child(even) { background: #f7f7f7; }
  .borderless th, .borderless td { border: none; }
  .two-col td { width: 50%; padding: 0; }
  .two-col td + td { padding-left: 3mm; }
  /* Repeat header rows when a table spans pages. */
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .scenario-block { break-inside: avoid; page-break-inside: avoid; padding-top: 2mm; }
  .header-bar { border-bottom: 2px solid #1a1a1a; padding-bottom: 2.5mm; }
  .header-meta { text-align: right; }
  .company-name { padding-bottom: 1mm; }
  .doc-title { font-size: 14px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; padding-bottom: 1mm; }
  .display-title { font-size: 24px; font-weight: bold; padding-top: 3.5mm; padding-bottom: 0.8mm; line-height: 1.2; }
  .display-subtitle { font-size: 12px; color: #555; padding-bottom: 2mm; }
  .pill-row { padding-top: 0.5mm; }
  .pill-wrap { display: inline-block; padding-right: 1.5mm; padding-bottom: 1mm; }
  .pill {
    display: inline-block;
    border: 1px solid #c9c9c9;
    border-radius: 3mm;
    padding: 0.8mm 2.5mm;
    font-size: 9px;
    font-weight: bold;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    background: #ffffff;
  }
  .section-bar {
    color: #ffffff;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-size: 12px;
    padding: 2mm 3mm;
    break-inside: avoid;
    break-after: avoid;
  }
  .day-block { padding-top: 1.5mm; padding-bottom: 1mm; }
  .day-bar {
    font-weight: bold;
    padding: 1.5mm 3mm;
    break-inside: avoid;
    break-after: avoid;
  }
  .day-bar .overnight { float: right; font-weight: normal; }
  .option-heading { border-bottom: 2px solid #1a1a1a; }
  .notes-box { border: 1px solid #d0d0d0; background: #fafafa; padding: 2mm 3mm 1mm; }
  .thanks-banner {
    text-align: center;
    font-size: 15px;
    font-weight: bold;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: #ffffff;
    padding: 4mm 3mm;
  }
  .footer-contact { text-align: center; color: #555; font-size: 10px; padding-top: 2mm; }
  /* Closing block (notes + thanks + footer) stays on one page — an orphaned
     thank-you banner on an otherwise empty page looks broken. */
  .keep-together { break-inside: avoid; page-break-inside: avoid; }
  .muted { color: #555; }
  .price-box {
    border: 2px solid #1a1a1a;
    padding: 2.5mm 3mm;
    display: inline-block;
    background: #f7f7f7;
  }
  .price-total { font-size: 15px; font-weight: bold; }
  .internal-banner {
    border: 2px solid #b00020;
    color: #b00020;
    font-weight: bold;
    text-align: center;
    padding: 2mm;
    letter-spacing: 1px;
  }
  .internal-section { border: 1px dashed #b00020; padding: 2mm 2.5mm; }
  .issue-blocker { color: #b00020; }
  .issue-warning { color: #8a6d00; }
  .doc-footer {
    border-top: 1px solid #999;
    padding-top: 1.5mm;
    font-size: 9px;
    color: #555;
  }
  .watermark {
    /* position: fixed repeats the element on every printed page in Chromium. */
    position: fixed;
    top: 42%;
    left: 5%;
    width: 90%;
    text-align: center;
    transform: rotate(-28deg);
    font-size: 58px;
    font-weight: bold;
    color: rgba(176, 0, 32, 0.13);
    z-index: 1000;
    pointer-events: none;
  }
  ul, ol { padding-left: 5mm; padding-bottom: 1.5mm; }
  li { padding-bottom: 0.6mm; }
  .keep-wrap { overflow-wrap: break-word; word-wrap: break-word; }
`;

/** Brand colors arrive from settings/snapshots — only a strict #rrggbb is ever
 *  interpolated into CSS; anything else falls back to the default navy. */
const BRAND_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function brandColor(input: QuotationPdfInput): string {
  const c = input.branding?.brandColor;
  return c && BRAND_COLOR_RE.test(c) ? c : DEFAULT_BRAND_COLOR;
}

/** Mixes the brand color with white (ratio = white share) for tinted bars. */
function tint(hex: string, ratio: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (v: number) => Math.round(v + (255 - v) * ratio);
  const channels = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)];
  return `#${channels.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function brandCss(color: string): string {
  const light = tint(color, 0.88);
  return `
  .section-bar { background: ${color}; }
  .thanks-banner { background: ${color}; }
  .display-title, .doc-title { color: ${color}; }
  .option-heading { border-bottom-color: ${color}; }
  .day-bar { background: ${light}; border-left: 1.2mm solid ${color}; }
  .notes-box { border-left: 1.2mm solid ${color}; }
  .pill { border-color: ${color}; color: ${color}; }
`;
}

/** Full-width branded bar introducing a document section. */
function sectionBar(titleHtml: string): string {
  return `<div class="section-bar">${titleHtml}</div>`;
}

function watermarkHtml(draft: boolean): string {
  return draft ? `<div class="watermark">DRAFT — NOT APPROVED</div>` : "";
}

function travelerSummary(t: TravelerSetup): string {
  const parts = [
    `${t.adults} adult${t.adults === 1 ? "" : "s"}`,
    `${t.children} child${t.children === 1 ? "" : "ren"}`,
    `${t.infants} infant${t.infants === 1 ? "" : "s"}`,
  ];
  return escapeHtml(parts.join(", "));
}

function brandingContacts(input: QuotationPdfInput): string[] {
  const b = input.branding;
  const lines = [b?.companyPhone, b?.companyEmail, b?.companyWebsite, b?.companyAddress]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v)
    .map((v) => escapeHtml(v));
  if (lines.length > 0) return lines;
  // No branding contacts configured: fall back to the agency contact line.
  const a = input.agency;
  const agencyContacts = [a.contactName, a.contactEmail, a.contactPhone]
    .filter((v): v is string => !!v)
    .map((v) => escapeHtml(v))
    .join(" · ");
  return agencyContacts ? [agencyContacts] : [];
}

function pillHtml(label: string, value: string | number): string {
  return `<span class="pill-wrap"><span class="pill">${escapeHtml(label)}: ${escapeHtml(String(value))}</span></span>`;
}

function statPillsHtml(input: QuotationPdfInput): string {
  const r = input.request;
  const t = r.travelers;
  const nights = daysBetween(r.startDate, r.endDate);
  const pills = [
    pillHtml("Total pax", t.adults + t.children + t.infants),
    pillHtml("Adults", t.adults),
    pillHtml("Children", t.children),
  ];
  if (t.infants > 0) pills.push(pillHtml("Infants", t.infants));
  pills.push(pillHtml("Nights", nights), pillHtml("Days", nights + 1));
  return `<div class="pill-row">${pills.join("")}</div>`;
}

function headerHtml(input: QuotationPdfInput, docTitle: string): string {
  const a = input.agency;
  const companyName = input.branding?.companyName?.trim() ? input.branding.companyName.trim() : a.name;
  const contacts = brandingContacts(input)
    .map((line) => `<p class="muted">${line}</p>`)
    .join("");
  // issuedAt is a full ISO timestamp; the document shows the calendar date only.
  const issued = formatDisplayDate((input.issuedAt ?? new Date().toISOString()).slice(0, 10));
  const destinations =
    input.request.destinations && input.request.destinations.length > 0
      ? `<p class="display-subtitle">${input.request.destinations.map(escapeHtml).join(" · ")}</p>`
      : "";
  return `
    <div class="header-bar">
      <table class="borderless">
        <tr>
          <td style="width: 55%;">
            <h1 class="company-name">${escapeHtml(companyName)}</h1>
          </td>
          <td class="header-meta">
            <div class="doc-title">${escapeHtml(docTitle)}</div>
            <p><strong>#${escapeHtml(input.packageCode)}</strong> ${escapeHtml(input.versionLabel)}</p>
            <p class="muted">Issued: ${escapeHtml(issued)}</p>
            ${input.validUntil ? `<p class="muted">Valid until: ${escapeHtml(formatDisplayDate(input.validUntil))}</p>` : ""}
            ${contacts}
          </td>
        </tr>
      </table>
      <div class="display-title">${escapeHtml(input.request.title)}</div>
      ${destinations}
      ${statPillsHtml(input)}
    </div>`;
}

function travelSummaryHtml(input: QuotationPdfInput): string {
  const r = input.request;
  const nights = daysBetween(r.startDate, r.endDate);
  const days = nights + 1;
  const destinations =
    r.destinations && r.destinations.length > 0
      ? r.destinations.map(escapeHtml).join(", ")
      : "—";
  return `
    ${sectionBar("Travel Summary")}
    <table>
      <tbody>
        <tr><th>Travel dates</th><td>${escapeHtml(formatDisplayDateRange(r.startDate, r.endDate))}</td>
            <th>Duration</th><td>${days} days / ${nights} nights</td></tr>
        <tr><th>Destinations</th><td>${destinations}</td>
            <th>Travelers</th><td>${travelerSummary(r.travelers)}</td></tr>
        <tr><th>Paying travelers</th><td>${r.travelers.paying}</td>
            <th>Agency reference</th><td>${r.agencyRef ? escapeHtml(r.agencyRef) : "—"}</td></tr>
        ${
          r.flightDetails
            ? `<tr><th>Flight details</th><td colspan="3" class="keep-wrap">${escapeHtml(r.flightDetails)}</td></tr>`
            : ""
        }
      </tbody>
    </table>`;
}

function roomSetupHtml(sc: ScenarioEngineInput): string {
  const rows: string[] = [];
  for (const stay of sc.stays) {
    for (const ra of stay.roomAllocations) {
      if (ra.rooms <= 0) continue;
      rows.push(`<tr>
        <td>${escapeHtml(stay.hotelName)}</td>
        <td>${escapeHtml(ra.roomType)}</td>
        <td>${ra.rooms}</td>
        <td>${ra.adults} ad / ${ra.children} ch / ${ra.infants} inf</td>
        <td>${ra.extraBeds}</td>
      </tr>`);
    }
  }
  if (rows.length === 0) return "";
  return `
    <h3>Room Setup</h3>
    <table>
      <thead><tr><th>Hotel</th><th>Room type</th><th>Rooms</th><th>Occupancy per allocation</th><th>Extra beds</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>`;
}

function itineraryHtml(sc: ScenarioEngineInput): string {
  if (sc.stays.length === 0) return "";
  const rows = sc.stays
    .map((stay) => {
      const nights = daysBetween(stay.checkIn, stay.checkOut);
      return `<tr>
        <td>${escapeHtml(formatDisplayDate(stay.checkIn))}</td>
        <td>${escapeHtml(formatDisplayDate(stay.checkOut))}</td>
        <td>${nights}</td>
        <td>${escapeHtml(stay.hotelName)}</td>
        <td>${escapeHtml(stay.city ?? "—")}</td>
        <td>${escapeHtml(stay.board ?? "—")}</td>
      </tr>`;
    })
    .join("");
  return `
    <h3>Itinerary</h3>
    <table>
      <thead><tr><th>Check-in</th><th>Check-out</th><th>Nights</th><th>Hotel</th><th>City</th><th>Board</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Version-level day-by-day itinerary, rendered above the per-scenario stay
 * tables. Days arrive frozen and pre-normalized (see QuotationPdfInput), so
 * this only formats — legacy string items never reach the renderer.
 */
function dayByDayHtml(input: QuotationPdfInput): string {
  const days = input.itineraryDays;
  if (!days || days.length === 0) return "";
  const blocks = days
    .map((day) => {
      const services =
        day.services.length > 0
          ? `<ul>${day.services
              .map((s) => `<li>${escapeHtml(s.label)}${s.details ? ` — ${escapeHtml(s.details)}` : ""}</li>`)
              .join("")}</ul>`
          : "";
      const overnight = day.overnightCity
        ? `<span class="overnight">Overnight: ${escapeHtml(day.overnightCity)}</span>`
        : "";
      return `
        <div class="day-block">
          <div class="day-bar">${overnight}Day ${day.dayOffset + 1} — ${escapeHtml(formatDisplayDate(day.date))}</div>
          ${day.narrative ? `<p class="keep-wrap">${escapeHtml(day.narrative)}</p>` : ""}
          ${services}
        </div>`;
    })
    .join("");
  return `${sectionBar("Day-by-Day Itinerary")}${blocks}`;
}

/** Client-facing price box: selling totals only, never any cost detail. */
function clientPriceHtml(res: ScenarioResult, travelers: TravelerSetup, quoteCurrency: string): string {
  const perPerson =
    res.perPayingPerson !== null
      ? `<p class="muted">Informational price per paying traveler: ${money(res.perPayingPerson, quoteCurrency)}
           (basis: ${travelers.paying} paying travelers)</p>`
      : "";
  return `
    <div class="price-box">
      <p class="price-total">Group total: ${money(res.sell, quoteCurrency)}</p>
      ${perPerson}
    </div>`;
}

function scenarioInputByRef(inputs: EngineInput, ref: string): ScenarioEngineInput | undefined {
  return inputs.scenarios.find((s) => s.ref === ref);
}

/**
 * Compact room summary for the comparison table: rooms needed simultaneously,
 * i.e. the max per room type across the sequential stays ("8×STANDARD, 2×TRIPLE").
 */
function roomSetupSummary(sc: ScenarioEngineInput): string {
  const byType = new Map<string, number>();
  for (const stay of sc.stays) {
    const perStay = new Map<string, number>();
    for (const ra of stay.roomAllocations) {
      if (ra.rooms <= 0) continue;
      perStay.set(ra.roomType, (perStay.get(ra.roomType) ?? 0) + ra.rooms);
    }
    perStay.forEach((rooms, type) => {
      byType.set(type, Math.max(byType.get(type) ?? 0, rooms));
    });
  }
  if (byType.size === 0) return "—";
  return Array.from(byType.entries())
    .map(([type, rooms]) => `${rooms}×${escapeHtml(type)}`)
    .join(", ");
}

/**
 * Comparison table of the scenario alternatives: one row per option with
 * hotels, room summary and selling totals. Never a grand total — scenarios
 * are alternatives, not additive.
 */
function packageOptionsHtml(input: QuotationPdfInput): string {
  if (input.snapshot.scenarios.length === 0) return "";
  const q = input.inputs.fx.quoteCurrency;
  const rows = input.snapshot.scenarios
    .map((res, i) => {
      const sc = scenarioInputByRef(input.inputs, res.ref);
      const hotels = sc
        ? Array.from(new Set(sc.stays.map((s) => s.hotelName)))
            .map((h) => escapeHtml(h))
            .join(" · ") || "—"
        : "—";
      return `<tr>
        <td><strong>${escapeHtml(optionLetter(i))}</strong> — ${escapeHtml(res.label)}</td>
        <td>${hotels}</td>
        <td>${sc ? roomSetupSummary(sc) : "—"}</td>
        <td><strong>${money(res.sell, q)}</strong></td>
        <td>${res.perPayingPerson !== null ? money(res.perPayingPerson, q) : "—"}</td>
      </tr>`;
    })
    .join("");
  return `
    ${sectionBar("Package Options")}
    <table>
      <thead><tr><th>Option</th><th>Hotels</th><th>Room setup</th><th>Group total</th><th>Per paying traveler</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function clientScenarioHtml(
  input: QuotationPdfInput,
  res: ScenarioResult,
  index: number,
): string {
  const sc = scenarioInputByRef(input.inputs, res.ref);
  const quoteCurrency = input.inputs.fx.quoteCurrency;
  const travelers = sc?.travelers ?? input.request.travelers;
  return `
    <section class="scenario-block">
      <h2 class="option-heading">${escapeHtml(optionLetter(index))} — ${escapeHtml(res.label)}</h2>
      ${sc ? roomSetupHtml(sc) : ""}
      ${sc ? itineraryHtml(sc) : ""}
      ${clientPriceHtml(res, travelers, quoteCurrency)}
    </section>`;
}

function inclusionsHtml(input: QuotationPdfInput): string {
  const charged: string[] = [];
  const bundled: string[] = [];
  for (const sc of input.inputs.scenarios) {
    for (const svc of sc.services) {
      const target = svc.includedElsewhere ? bundled : charged;
      if (!target.includes(svc.label)) target.push(svc.label);
    }
  }
  const items: string[] = [];
  if (input.request.flightDetails) {
    items.push(`Flights as specified: ${escapeHtml(input.request.flightDetails)}`);
  }
  for (const label of charged) items.push(escapeHtml(label));
  for (const label of bundled) items.push(`${escapeHtml(label)} — included via bundle/board`);
  if (items.length === 0) items.push("Services as per itinerary above");
  return `
    ${sectionBar("Inclusions")}
    <ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
}

function exclusionsHtml(input: QuotationPdfInput): string {
  const items = [
    ...(input.request.flightDetails ? [] : ["International flights (unless explicitly listed under inclusions)"]),
    "Personal expenses (laundry, minibar, phone calls, souvenirs)",
    "Visas and travel insurance",
  ];
  return `
    ${sectionBar("Exclusions")}
    <ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
}

/** Side-by-side Inclusions / Exclusions (50/50, borderless inner layout). */
function inclusionsExclusionsHtml(input: QuotationPdfInput): string {
  return `
    <table class="borderless two-col">
      <tbody><tr>
        <td>${inclusionsHtml(input)}</td>
        <td>${exclusionsHtml(input)}</td>
      </tr></tbody>
    </table>`;
}

function termsHtml(input: QuotationPdfInput): string {
  if (!input.terms) return "";
  const items = input.terms
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<li class="keep-wrap">${escapeHtml(p)}</li>`)
    .join("");
  if (!items) return "";
  return `${sectionBar("Terms &amp; Conditions")}<ol>${items}</ol>`;
}

/** Fixed "offer only" disclaimers every client document carries. */
function importantNotesHtml(input: QuotationPdfInput): string {
  const items = [
    "This is an offer only; no services have been booked at this stage.",
    "Availability and rates are subject to change until confirmation.",
  ];
  if (input.validUntil) items.push(`Valid until ${escapeHtml(formatDisplayDate(input.validUntil))}.`);
  return `
    ${sectionBar("Important Notes")}
    <div class="notes-box">
      <ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>
    </div>`;
}

function closingHtml(input: QuotationPdfInput): string {
  const companyName = input.branding?.companyName?.trim();
  const contact = [input.branding?.companyPhone, input.branding?.companyEmail, input.branding?.companyWebsite]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v)
    .map((v) => escapeHtml(v))
    .join(" · ");
  return `
    <div class="thanks-banner">Thank you for choosing ${companyName ? escapeHtml(companyName) : "us"}!</div>
    ${contact ? `<p class="footer-contact">${contact}</p>` : ""}`;
}

function footerHtml(input: QuotationPdfInput): string {
  const hashPrefix = escapeHtml(input.snapshotHash.slice(0, 12));
  return `
    <div class="doc-footer">
      ${escapeHtml(input.packageCode)} · ${escapeHtml(input.versionLabel)} · snapshot ${hashPrefix}
    </div>`;
}

function htmlDocument(title: string, body: string, extraCss = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}${extraCss}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function buildClientQuotationHtml(input: QuotationPdfInput): string {
  const scenarios = input.snapshot.scenarios
    .map((res, i) => clientScenarioHtml(input, res, i))
    .join("");
  const body = `
    ${watermarkHtml(input.draft)}
    ${headerHtml(input, "Quotation")}
    ${travelSummaryHtml(input)}
    ${dayByDayHtml(input)}
    ${packageOptionsHtml(input)}
    ${scenarios}
    ${inclusionsExclusionsHtml(input)}
    ${termsHtml(input)}
    <div class="keep-together">
      ${importantNotesHtml(input)}
      ${closingHtml(input)}
      ${footerHtml(input)}
    </div>`;
  return htmlDocument(
    `${input.packageCode} ${input.versionLabel} — Quotation`,
    body,
    brandCss(brandColor(input)),
  );
}

// ---------------------------------------------------------------------------
// INTERNAL costing document: everything the client doc has, plus full cost
// detail. This is the only place supplier rates, margins and traces appear.
// ---------------------------------------------------------------------------

function internalBannerHtml(): string {
  return `<div class="internal-banner">INTERNAL — NOT FOR CLIENT DISTRIBUTION</div>`;
}

function categoryTotalsHtml(res: ScenarioResult): string {
  const currencies = new Set<string>();
  for (const perCurrency of Object.values(res.totals.byCategory)) {
    for (const c of Object.keys(perCurrency)) currencies.add(c);
  }
  const currencyList = Array.from(currencies).sort();
  const header = `<thead><tr><th>Category</th>${currencyList.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const rows = Object.entries(res.totals.byCategory)
    .map(([category, perCurrency]) => {
      const cells = currencyList
        .map((c) => `<td>${perCurrency[c] !== undefined ? escapeHtml(displayMoneyCeil(perCurrency[c])) : "—"}</td>`)
        .join("");
      return `<tr><td>${escapeHtml(category)}</td>${cells}</tr>`;
    })
    .join("");
  return `
    <h3>Category totals (source currency)</h3>
    <table>${header}<tbody>${rows}</tbody></table>`;
}

function costByCurrencyHtml(res: ScenarioResult, quoteCurrency: string): string {
  const rows = Object.entries(res.totals.costByCurrency)
    .map(([c, amount]) => `<tr><td>${escapeHtml(c)}</td><td>${internalMoney(amount, quoteCurrency)}</td></tr>`)
    .join("");
  return `
    <h3>Cost converted to quote currency</h3>
    <table>
      <thead><tr><th>Source currency</th><th>Total in ${escapeHtml(quoteCurrency)}</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th>costQuote</th><th><strong>${internalMoney(res.totals.costQuote, quoteCurrency)}</strong></th></tr></tfoot>
    </table>`;
}

function policyHtml(input: QuotationPdfInput, res: ScenarioResult): string {
  const p = input.inputs.policy;
  const q = input.inputs.fx.quoteCurrency;
  const rows: string[] = [
    `<tr><th>Policy</th><td>${escapeHtml(p.type)}${p.rate ? ` @ ${escapeHtml(p.rate)}` : ""}${p.feeFraction ? ` + fee ${escapeHtml(p.feeFraction)}` : ""}</td></tr>`,
    `<tr><th>Policy target</th><td>${res.policyTarget !== null ? internalMoney(res.policyTarget, q) : "—"}</td></tr>`,
    `<tr><th>Policy floor</th><td>${res.policyFloor !== null ? internalMoney(res.policyFloor, q) : "—"}</td></tr>`,
    `<tr><th>Unrounded sell</th><td>${internalMoney(res.unroundedSell, q)}</td></tr>`,
    `<tr><th>Rounding (up to ${escapeHtml(p.roundingIncrement)} ${escapeHtml(q)})</th><td>${internalMoney(res.roundingAdjustment, q)}</td></tr>`,
    `<tr><th>Final sell</th><td><strong>${internalMoney(res.sell, q)}</strong></td></tr>`,
    `<tr><th>Profit</th><td>${internalMoney(res.profit, q)}</td></tr>`,
    `<tr><th>Margin</th><td>${res.margin !== null ? marginPercent(res.margin) : "—"}</td></tr>`,
  ];
  if (p.minProfit) {
    rows.push(
      `<tr><th>Min profit per traveler (excl. infants)</th><td>${internalMoney(p.minProfit, p.minProfitCurrency ?? q)}${p.belowFloorExceptionGranted ? " (below-floor exception granted)" : ""}</td></tr>`,
    );
  }
  return `
    <h3>Policy &amp; profit</h3>
    <table><tbody>${rows.join("")}</tbody></table>`;
}

function fxTableHtml(input: QuotationPdfInput): string {
  const fx = input.inputs.fx;
  const rows = Object.entries(fx.rates)
    .map(
      ([c, rate]) =>
        `<tr><td>${escapeHtml(c)}${c === fx.quoteCurrency ? " (quote currency)" : ""}</td><td>${escapeHtml(rate)} AMD</td></tr>`,
    )
    .join("");
  return `
    <h3>FX rates (AMD per 1 unit)</h3>
    <table>
      <thead><tr><th>Currency</th><th>Rate</th></tr></thead>
      <tbody><tr><td>AMD (base)${fx.quoteCurrency === "AMD" ? " (quote currency)" : ""}</td><td>1 AMD</td></tr>${rows}</tbody>
    </table>`;
}

function nightlyTraceHtml(res: ScenarioResult, sc: ScenarioEngineInput | undefined): string {
  if (res.nightly.length === 0) return "";
  const stayName = (ref: string) => sc?.stays.find((s) => s.ref === ref)?.hotelName ?? ref;
  const rows = res.nightly
    .map(
      (n) => `<tr>
        <td>${escapeHtml(formatDisplayDate(n.date))}</td>
        <td>${escapeHtml(stayName(n.stayRef))}</td>
        <td>${escapeHtml(n.roomType)}</td>
        <td>${n.rooms}</td>
        <td>${internalMoney(n.rate, n.currency)}</td>
        <td>${n.extraBeds}</td>
        <td>${internalMoney(n.extraBedCharge, n.currency)}</td>
        <td>${n.sourceRef ? escapeHtml(n.sourceRef) : "—"}</td>
      </tr>`,
    )
    .join("");
  return `
    <h3>Nightly rate trace</h3>
    <table>
      <thead><tr><th>Date</th><th>Stay</th><th>Room type</th><th>Rooms</th><th>Rate</th><th>Extra beds</th><th>Extra bed charge</th><th>Source</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function issuesHtml(issues: EngineIssue[]): string {
  if (issues.length === 0) return "";
  const rows = issues
    .map(
      (i) => `<tr>
        <td class="${i.severity === "BLOCKER" ? "issue-blocker" : "issue-warning"}">${escapeHtml(i.severity)}</td>
        <td>${escapeHtml(i.code)}</td>
        <td>${escapeHtml([i.scenarioRef, i.lineRef, i.field].filter(Boolean).join(" / ") || "—")}</td>
        <td class="keep-wrap">${escapeHtml(i.message)}</td>
      </tr>`,
    )
    .join("");
  return `
    <h3>Issues</h3>
    <table>
      <thead><tr><th>Severity</th><th>Code</th><th>Location</th><th>Message</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function overrideNotesHtml(input: QuotationPdfInput): string {
  const notes: string[] = [];
  for (const sc of input.inputs.scenarios) {
    for (const svc of sc.services) {
      if (!svc.override) continue;
      notes.push(
        `<li><strong>${escapeHtml(svc.label)}</strong> (${escapeHtml(sc.label)}): rate overridden from ` +
          `${svc.override.originalRate !== null ? internalMoney(svc.override.originalRate, svc.currency) : "n/a"} — ` +
          `reason: ${escapeHtml(svc.override.reason)} (actor: ${escapeHtml(svc.override.actorId)})</li>`,
      );
    }
  }
  if (notes.length === 0) return "";
  return `<h3>Override notes</h3><ul>${notes.join("")}</ul>`;
}

// --- Calculation trace table (v0.14.0) --------------------------------------
// Row content comes from buildTraceRows (lib/travel/trace-table.ts) — the same
// rows the web Review tab renders (v0.15.0). This function only renders them.

function calculationTableHtml(
  input: QuotationPdfInput,
  res: ScenarioResult,
  sc: ScenarioEngineInput | undefined,
): string {
  const rows = buildTraceRows({
    quoteCurrency: input.inputs.fx.quoteCurrency,
    fxRates: input.inputs.fx.rates,
    policy: input.inputs.policy,
    result: res,
    scenario: sc,
    fallbackPayingPax: input.request.travelers.paying,
  });
  if (rows.length === 0) return "";
  const header = sc ? `Tour ${formatDisplayDateRange(sc.tourStart, sc.tourEnd)}: ${res.nights} night(s) / ${res.days} day(s)` : "";
  return `
    <h3>Calculation trace</h3>
    ${header ? `<p class="muted">${escapeHtml(header)}</p>` : ""}
    <table>
      <thead><tr><th>Description</th><th>Basis</th><th>Calculation</th><th>Amount</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr>
        <td>${escapeHtml(r.description)}</td>
        <td>${escapeHtml(r.basis)}</td>
        <td>${escapeHtml(r.calculation)}</td>
        <td>${r.bold ? `<strong>${escapeHtml(r.amount)}</strong>` : escapeHtml(r.amount)}</td>
      </tr>`,
        )
        .join("")}</tbody>
    </table>`;
}

function internalScenarioHtml(
  input: QuotationPdfInput,
  res: ScenarioResult,
  index: number,
): string {
  const sc = scenarioInputByRef(input.inputs, res.ref);
  return `
    ${clientScenarioHtml(input, res, index)}
    <section class="scenario-block internal-section">
      <h3>Internal costing — ${escapeHtml(optionLetter(index))} (${escapeHtml(res.label)})</h3>
      ${res.valid ? "" : `<p class="issue-blocker"><strong>Scenario INVALID — validation blockers present.</strong></p>`}
      ${categoryTotalsHtml(res)}
      ${costByCurrencyHtml(res, input.inputs.fx.quoteCurrency)}
      ${policyHtml(input, res)}
      ${nightlyTraceHtml(res, sc)}
      ${issuesHtml(res.issues)}
      ${calculationTableHtml(input, res, sc)}
    </section>`;
}

export function buildInternalCostingHtml(input: QuotationPdfInput): string {
  const scenarios = input.snapshot.scenarios
    .map((res, i) => internalScenarioHtml(input, res, i))
    .join("");
  const staffServices: ServiceLineInput[] = input.inputs.scenarios.flatMap((sc) =>
    sc.services.filter((s) => s.isStaffCost),
  );
  const staffSection =
    staffServices.length > 0
      ? `<h3>Staff cost lines</h3><ul>${staffServices
          .map(
            (s) =>
              `<li>${escapeHtml(s.label)} — ${escapeHtml(s.category)}, basis ${escapeHtml(s.basis)}, ` +
              `rate ${s.unitRate !== null ? internalMoney(s.unitRate, s.currency) : "MISSING"}</li>`,
          )
          .join("")}</ul>`
      : "";
  const body = `
    ${watermarkHtml(input.draft)}
    ${internalBannerHtml()}
    ${headerHtml(input, "Internal Costing Sheet")}
    ${travelSummaryHtml(input)}
    ${scenarios}
    <section class="scenario-block internal-section">
      <h2>Package-level internal data</h2>
      ${fxTableHtml(input)}
      ${staffSection}
      ${overrideNotesHtml(input)}
      ${issuesHtml(input.snapshot.issues.filter((i) => !i.scenarioRef))}
    </section>
    ${inclusionsHtml(input)}
    ${exclusionsHtml(input)}
    ${termsHtml(input)}
    ${footerHtml(input)}`;
  return htmlDocument(
    `${input.packageCode} ${input.versionLabel} — Internal Costing`,
    body,
    brandCss(brandColor(input)),
  );
}

export function buildHtmlForKind(input: QuotationPdfInput): string {
  return input.kind === "INTERNAL"
    ? buildInternalCostingHtml(input)
    : buildClientQuotationHtml(input);
}
