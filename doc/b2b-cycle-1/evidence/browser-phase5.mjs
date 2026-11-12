// Phase 5 Chromium audit: public pages, sign-in validation and every main authenticated page at three widths.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire("/home/aidev/multiagent/acceptance/");
const { chromium } = require("playwright");
const axeSrc = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const [base = "http://localhost:3113", out = "."] = process.argv.slice(2);
const PW = "Browser-Check-Passw0rd!";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };
const VIEWS = { desktop: { width: 1366, height: 900 }, tablet: { width: 820, height: 1180 }, phone: { width: 390, height: 844 } };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function axe(page) {
  await page.evaluate(axeSrc);
  return page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length}):${v.nodes[0].target.join(" ").slice(0, 70)}`));
}
async function login(page, email) {
  await page.goto(`${base}/login`); await page.fill("#email", email); await page.fill("#password", PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 }), page.click('button[type="submit"]')]);
}
async function audit(page, label, url, { shot = false, ready } = {}) {
  await page.goto(`${base}${url}`);
  if (ready) await page.waitForSelector(ready, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const ov = await overflow(page); const v = await axe(page);
  check(`${label}: no horizontal page scroll`, ov <= 1, `overflow=${ov}`);
  check(`${label}: axe serious/critical`, v.length === 0, v.join(" | "));
  if (shot) await page.screenshot({ path: `${out}/p5-${label.replace(/[^a-z0-9]+/gi, "-")}.png`, fullPage: true });
}
const browser = await chromium.launch();

// ---- public
for (const [vn, size] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext({ viewport: size, locale: "en-US" }); const page = await ctx.newPage(); page.setDefaultTimeout(120000);
  await audit(page, `${vn} landing`, "/", { shot: true });
  check(`${vn} landing: one h1`, (await page.locator("h1").count()) === 1);
  check(`${vn} landing: in the hero, Sign in comes before Become a partner`, await page.evaluate(() => { const a = [...document.querySelector("main section").querySelectorAll("a")].map((x) => x.getAttribute("href")); return a.indexOf("/login") > -1 && a.indexOf("/partners/apply") > a.indexOf("/login"); }));
  check(`${vn} landing: three service cards and four steps`, (await page.locator("#services li").count()) === 3 && (await page.locator("#how-it-works li").count()) === 4);
  const text = await page.locator("body").innerText();
  check(`${vn} landing: no retired claims; founded 2019 shown`, !/2014|24\/7|thousands|licensed|insured/i.test(text) && /Founded in 2019/.test(text));
  await audit(page, `${vn} login`, "/login", { shot: true });
  await page.goto(`${base}/login`); await page.click('button[type="submit"]');
  check(`${vn} login: empty submit shows field messages, marks fields invalid, focuses email`, (await page.locator("#email-error").count()) === 1 && (await page.locator("#password-error").count()) === 1 && (await page.locator("#email[aria-invalid='true'][aria-describedby='email-error']").count()) === 1 && (await page.evaluate(() => document.activeElement?.id)) === "email");
  await page.fill("#email", "not-an-email"); await page.fill("#password", "x"); await page.click('button[type="submit"]');
  check(`${vn} login: malformed email is a format message, no request is sent`, (await page.locator("#email-error").innerText()).length > 0 && (await page.locator('p[role="alert"]').count()) === 0);
  if (vn === "desktop") await page.screenshot({ path: `${out}/p5-desktop-login-errors.png`, fullPage: true });
  await audit(page, `${vn} partner apply`, "/partners/apply");
  await audit(page, `${vn} terms`, "/terms");
  const ico = await page.evaluate(async () => (await fetch("/favicon.ico")).status);
  const links = await page.evaluate(() => [...document.querySelectorAll("link[rel*=icon]")].map((l) => l.getAttribute("href")));
  check(`${vn}: favicon.ico served and icon links declared`, ico === 200 && links.some((h) => h.includes("icon-32.png")) && links.some((h) => h.includes("nare-icon.webp")) && links.some((h) => h.includes("apple-touch")), links.join(","));
  await ctx.close();
}

// ---- admin pages
const ADMIN = [["/admin", "admin home"], ["/admin/permissions", "permissions report"], ["/admin/partners", "partner applications"], ["/admin/contact", "company and contact"], ["/admin/translations", "translations"], ["/travel", "requests"], ["/travel/templates", "templates"], ["/travel/catalog", "catalog"], ["/travel/agencies", "agencies"], ["/travel/settings", "settings"], ["/travel/notifications", "notifications"], ["/travel/review", "review queue"], ["/calculator", "calculator"]];
for (const [vn, size] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext({ viewport: size }); const page = await ctx.newPage(); page.setDefaultTimeout(120000);
  await login(page, "admin@browser.test");
  for (const [url, name] of ADMIN) await audit(page, `${vn} admin ${name}`, url, { shot: vn !== "tablet" && ["requests", "templates", "catalog", "settings", "admin home"].includes(name) });
  await ctx.close();
}
// ---- advisor: request list, new request, detail
{
  const ctx = await browser.newContext({ viewport: VIEWS.desktop }); const page = await ctx.newPage(); page.setDefaultTimeout(120000);
  await login(page, "advisor@browser.test");
  const id = await page.evaluate(async () => {
    const tpl = (await (await fetch("/api/travel/templates")).json())[0];
    const agency = (await (await fetch("/api/travel/agencies")).json())[0];
    const r = await fetch(`/api/travel/templates/${tpl.id}/instantiate`, { method: "POST", body: JSON.stringify({ agencyId: agency.id, title: "Audit trip", startDate: "2026-12-02", endDate: "2026-12-05", travelers: { adults: 2, children: 0, infants: 0, childAges: [], paying: 2, complimentary: 0, leaders: 0, staff: 0 } }) });
    return (await r.json()).request?.id;
  });
  check("advisor: request created for the audit", Boolean(id));
  await ctx.close();
  for (const [vn, size] of Object.entries(VIEWS)) {
    const c = await browser.newContext({ viewport: size }); const p = await c.newPage(); p.setDefaultTimeout(120000);
    await login(p, "advisor@browser.test");
    await audit(p, `${vn} advisor requests`, "/travel", { shot: vn !== "tablet" });
    await audit(p, `${vn} advisor new request`, "/travel/requests/new", { ready: "#nr-agency" });
    await audit(p, `${vn} advisor request detail`, `/travel/requests/${id}`, { shot: true, ready: '[data-testid="template-review"]' });
    // tabs usable by keyboard
    if (vn === "phone") {
      await p.goto(`${base}/travel/requests/${id}`); await p.waitForTimeout(2500);
      const tabs = p.getByRole("tab"); const n = await tabs.count();
      let ok = n >= 4; for (let i = 0; i < n && ok; i++) { await tabs.nth(i).click(); ok = (await tabs.nth(i).getAttribute("aria-selected")) === "true"; }
      check("phone advisor detail: every tab can be selected", ok, `tabs=${n}`);
      check("phone advisor detail: tab bar scrolls inside itself (no page overflow)", (await overflow(p)) <= 1);
    }
    await c.close();
  }
}
// ---- partner
{
  const ctx = await browser.newContext({ viewport: VIEWS.phone }); const page = await ctx.newPage(); page.setDefaultTimeout(120000);
  await login(page, "partner@browser.test"); await audit(page, "phone partner landing", "/partner", { shot: true }); await ctx.close();
}
await browser.close();
const failed = results.filter((r) => !r.ok);
writeFileSync(`${out}/browser-phase5-results.json`, JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
