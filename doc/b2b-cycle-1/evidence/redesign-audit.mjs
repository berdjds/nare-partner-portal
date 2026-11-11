// Usage: node redesign-audit.mjs <baseUrl> <outDir>   -- axe (wcag2a/aa, 2.1aa) serious/critical, overflow, reduced motion, Armenian fit.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire("/home/aidev/multiagent/acceptance/package.json");
const { chromium } = require("playwright");
const axeSrc = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const [BASE, OUT] = process.argv.slice(2);
const pw = (n) => readFileSync(`/home/aidev/previews/.pw_${n}`, "utf8").trim();
const VIEWS = { desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1100 }, mobile: { width: 390, height: 844 } };
const results = []; const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " - " + extra : ""}`); };
const browser = await chromium.launch();
async function audit(page, label) {
  await page.waitForSelector("main h1, main h2, main [role=tablist]", { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(1200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${label}: no horizontal scroll`, overflow <= 0, `overflow=${overflow}`);
  await page.evaluate(axeSrc);
  const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.filter((x) => ["serious", "critical"].includes(x.impact)).map((x) => `${x.id}(${x.nodes.length}):${x.nodes[0].target.join(" ").slice(0, 80)}`));
  check(`${label}: axe serious/critical`, v.length === 0, v.join(" | "));
}
async function signIn(ctx, email, password) { const page = await ctx.newPage(); await page.goto(`${BASE}/login`); await page.fill("#email", email); await page.fill("#password", password); await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }), page.click('button[type="submit"]')]); return page; }
for (const [view, size] of Object.entries(VIEWS)) {
  let ctx = await browser.newContext({ viewport: size }); let page = await ctx.newPage();
  for (const [name, path] of [["landing", "/"], ["login", "/login"], ["apply", "/partners/apply"]]) { await page.goto(BASE + path); await audit(page, `${view} ${name}`); }
  await ctx.close();
  ctx = await browser.newContext({ viewport: size }); page = await signIn(ctx, "advisor@preview.test", pw("advisor"));
  await page.goto(BASE + "/travel/requests/new"); await audit(page, `${view} advisor new request`);
  const rows = await (await ctx.request.get(BASE + "/api/travel/requests")).json(); const list = Array.isArray(rows) ? rows : rows.requests ?? [];
  const t = list.find((r) => /recalc/i.test(r.title ?? "")) ?? list[0];
  if (t) { await page.goto(`${BASE}/travel/requests/${t.id}`); await audit(page, `${view} advisor request details`);
}
  await ctx.close();
  ctx = await browser.newContext({ viewport: size }); page = await signIn(ctx, "admin@preview.test", pw("admin"));
  await audit(page, `${view} admin home`); await page.goto(BASE + "/travel"); await audit(page, `${view} admin requests`);
  { const rows = await (await ctx.request.get(BASE + "/api/travel/requests")).json(); const list = Array.isArray(rows) ? rows : rows.requests ?? []; const t = list.find((r) => /recalc/i.test(r.title ?? "")) ?? list[0];
    if (t) { await page.goto(`${BASE}/travel/requests/${t.id}`); await audit(page, `${view} admin request details`); const open = await page.evaluate(() => { const d = [...document.querySelectorAll("details")].find((x) => /Danger zone/.test(x.textContent || "")); return d ? d.open : null; }); check(`${view} danger zone present and collapsed`, open === false, String(open)); } }
  await ctx.close();
  ctx = await browser.newContext({ viewport: size }); page = await signIn(ctx, "partner@preview.test", pw("partner")); await audit(page, `${view} partner home`); await ctx.close();
}
// Armenian: landing, login and the sign-in card must fit (no overflow) at phone width, and reduced motion must not break layout.
for (const [name, path] of [["landing", "/"], ["login", "/login"], ["apply", "/partners/apply"]]) {
  const ctx = await browser.newContext({ viewport: VIEWS.mobile, locale: "hy-AM", reducedMotion: "reduce", extraHTTPHeaders: { "accept-language": "hy" } }); const page = await ctx.newPage();
  await page.goto(BASE + path); await page.waitForTimeout(1200);
  const lang = await page.evaluate(() => document.documentElement.lang); const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`hy mobile ${name}: lang=hy and no overflow`, lang === "hy" && ov <= 0, `lang=${lang} overflow=${ov}`);
  if (OUT) await page.screenshot({ path: `${OUT}/hy-${name}-mobile.png`, fullPage: true }); await ctx.close();
}
await browser.close(); console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
