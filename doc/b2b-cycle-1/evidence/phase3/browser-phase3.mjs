// Phase 3 browser checks against an isolated trial-mode server (throwaway DB, no WhatsApp).
// node browser-phase3.mjs <baseUrl> <outDir>
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire("/home/aidev/multiagent/acceptance/");
const { chromium } = require("playwright");
const axeSrc = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const [base = "http://127.0.0.1:3111", out = "."] = process.argv.slice(2);
const PW = "Browser-Check-Passw0rd!";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };
const VIEWS = { desktop: { width: 1366, height: 900 }, tablet: { width: 820, height: 1180 }, phone: { width: 390, height: 844 } };

async function login(page, email) {
  await page.goto(`${base}/login`);
  await page.fill("#email", email); await page.fill("#password", PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 }), page.click('button[type="submit"]')]);
}
async function axe(page, label) {
  await page.evaluate(axeSrc);
  const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })));
  const serious = r.filter((v) => ["serious", "critical"].includes(v.impact));
  check(`axe ${label}: no serious/critical violations`, serious.length === 0, JSON.stringify(r));
}
async function pickDay(page, triggerId, day) {
  await page.click(`#${triggerId}`);
  await page.locator(`button:not([disabled]):text-is("${day}")`).first().click();
}
async function pickOption(page, triggerId, text) {
  await page.click(`#${triggerId}`);
  await page.getByRole("option", { name: new RegExp(text) }).first().click();
}

const browser = await chromium.launch();
for (const [vname, size] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext({ viewport: size });
  const page = await ctx.newPage();
  await login(page, "advisor@browser.test");
  await page.goto(`${base}/travel/requests/new`);
  await page.waitForSelector("#nr-agency");
  check(`${vname}: page is a routed page, not a modal`, (await page.locator('[role="dialog"]').count()) === 0 && page.url().endsWith("/travel/requests/new"));
  check(`${vname}: wording "Client messages and notes" present, plain "Notes" label absent`, (await page.getByText("Client messages and notes").count()) > 0 && (await page.locator("label", { hasText: /^Notes$/ }).count()) === 0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${vname}: no horizontal page scroll`, overflow <= 1, `overflow=${overflow}`);
  await page.screenshot({ path: `${out}/${vname}-new-empty.png`, fullPage: true });

  // inline validation + error summary + focus
  await page.click('button[type="submit"]');
  await page.waitForSelector('[role="alert"]');
  check(`${vname}: error summary and field errors appear`, (await page.locator('[role="alert"]').count()) >= 2);
  check(`${vname}: focus moves to the first invalid field`, (await page.evaluate(() => document.activeElement?.id)) === "nr-agency");
  check(`${vname}: invalid control exposes aria-invalid`, (await page.locator("#nr-title[aria-invalid='true']").count()) === 1);
  await page.screenshot({ path: `${out}/${vname}-new-errors.png`, fullPage: true });
  if (vname === "desktop") await axe(page, "new request (errors shown)");

  // draft kept across reload
  await page.fill("#nr-title", `Draft title ${vname}`);
  await page.reload(); await page.waitForSelector("#nr-title");
  await page.getByText("We restored what you had entered").waitFor({ timeout: 10000 }).catch(() => {});
  check(`${vname}: entered values survive a reload`, (await page.inputValue("#nr-title")) === `Draft title ${vname}`);
  check(`${vname}: restored banner shown`, (await page.getByText("We restored what you had entered").count()) === 1);

  if (vname === "desktop") {
    // full happy path with a template, double click, detail notice
    await pickOption(page, "nr-agency", "DEMO");
    await pickDay(page, "nr-start", "18"); await pickDay(page, "nr-end", "21");
    await pickOption(page, "nr-template", "DEMO-3N");
    await page.fill("#nr-title", "Browser check trip");
    await page.fill("#nr-client-notes", "Vegetarian group, window seats");
    await page.fill("#nr-internal-notes", "INTERNAL-ONLY-MARKER");
    await page.screenshot({ path: `${out}/${vname}-new-filled.png`, fullPage: true });
    const before = await page.evaluate(async () => (await (await fetch("/api/travel/requests")).json()).length);
    await page.dblclick('button[type="submit"]');
    await page.waitForURL(/\/travel\/requests\/(?!new$)[a-z0-9-]+$/, { timeout: 45000 });
    const list = await page.evaluate(async () => (await (await fetch("/api/travel/requests")).json()).length);
    check("desktop: double click creates exactly one request", list === before + 1, `before=${before} after=${list}`);
    await page.waitForSelector('[data-testid="template-review"]', { timeout: 30000 });
    const notice = await page.locator('[data-testid="template-review"]').innerText();
    check("desktop: detail page lists template review items (departure day / minimum / not applicable)", /Group tour/.test(notice) && /Leader meal/.test(notice), notice.replace(/\s+/g, " ").slice(0, 200));
    await page.screenshot({ path: `${out}/${vname}-detail-review-notice.png`, fullPage: true });
    await axe(page, "request detail");
    const detailId = page.url().split("/").pop();
    const detail = await page.evaluate(async (id) => (await fetch(`/api/travel/requests/${id}`)).json(), detailId);
    check("desktop: client and internal notes stored separately", detail.clientNotes === "Vegetarian group, window seats" && detail.notes === "INTERNAL-ONLY-MARKER");
    check("desktop: draft cleared after a successful create", (await page.evaluate(() => sessionStorage.getItem("travel:new-request:draft:v1"))) === null);
    writeFileSync(`${out}/created-request-id.txt`, detailId);

    // cancel with unsaved changes asks first, then leaves
    await page.goto(`${base}/travel/requests/new`); await page.waitForSelector("#nr-title");
    await page.fill("#nr-title", "Will be discarded");
    let dialogSeen = "";
    page.once("dialog", async (d) => { dialogSeen = d.message(); await d.dismiss(); });
    await page.getByRole("link", { name: "Cancel" }).click();
    await page.waitForTimeout(300);
    check("desktop: cancel with unsaved input asks for confirmation and stays on dismiss", /Discard/.test(dialogSeen) && page.url().endsWith("/travel/requests/new"));
    page.once("dialog", (d) => d.accept());
    await page.getByRole("link", { name: "Cancel" }).click();
    await page.waitForURL(/\/travel$/, { timeout: 15000 });
    check("desktop: cancel confirmed returns to the list", true);
    check("desktop: list has a New request link (no modal)", (await page.locator('a[href="/travel/requests/new"]').count()) > 0);
    await page.screenshot({ path: `${out}/${vname}-list.png`, fullPage: true });
  } else {
    await page.screenshot({ path: `${out}/${vname}-new-restored.png`, fullPage: true });
  }
  await ctx.close();
}

// partner: redirected away from the staff page, sees own agency only
{
  const ctx = await browser.newContext({ viewport: VIEWS.desktop });
  const page = await ctx.newPage();
  await login(page, "partner@browser.test");
  await page.goto(`${base}/travel/requests/new`);
  await page.waitForURL(/\/partner$/, { timeout: 15000 });
  check("partner: staff request page redirects to /partner", true);
  await page.screenshot({ path: `${out}/partner-landing.png`, fullPage: true });
  const api = await page.evaluate(async () => { const r = await fetch("/api/travel/requests"); return { status: r.status, body: await r.text() }; });
  check("partner: API list works and carries no internal notes", api.status === 200 && !api.body.includes("INTERNAL-ONLY-MARKER"));
  const created = readFileSync(`${out}/created-request-id.txt`, "utf8");
  const d = await page.evaluate(async (id) => { const r = await fetch(`/api/travel/requests/${id}`); return { status: r.status, body: await r.text() }; }, created);
  check("partner: own-agency detail shows client messages, never internal notes", d.status === 200 && d.body.includes("Vegetarian group") && !d.body.includes("INTERNAL-ONLY-MARKER"));
  const rec = await page.evaluate(async (id) => (await fetch(`/api/travel/requests/${id}/recalculate`, { method: "POST", body: "{}" })).status, created);
  check("partner: recalculate endpoint refused", [401, 403].includes(rec), `status=${rec}`);
  await ctx.close();
}
await browser.close();
const failed = results.filter((r) => !r.ok);
writeFileSync(`${out}/browser-results.json`, JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
