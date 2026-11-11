// Usage: node redesign-capture.mjs <baseUrl> <outDir>
// Captures landing, login, new request, request details and admin at desktop/tablet/mobile for the preview.
// Reads the preview passwords from private files (never printed). Synthetic data only.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
const require = createRequire("/home/aidev/multiagent/acceptance/package.json");
const { chromium } = require("playwright");
const [BASE, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const pw = (n) => readFileSync(`/home/aidev/previews/.pw_${n}`, "utf8").trim();
const VIEWS = { desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1100 }, mobile: { width: 390, height: 844 } };
const browser = await chromium.launch();
const autoScroll = async (page) => { await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo(0, 0); }); await page.waitForTimeout(400); };
const log = [];
async function shot(page, name, view) { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForSelector("main h1, main h2, main [role=tablist]", { timeout: 20000 }).catch(() => {}); await autoScroll(page); await page.waitForTimeout(800); await page.screenshot({ path: `${OUT}/${name}-${view}.png`, fullPage: true }); const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); log.push(`${name}-${view}: overflow=${overflow}`); }
async function signIn(ctx, email, password) {
  const page = await ctx.newPage(); await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"], input[name="email"], #email', email); await page.fill("#password", password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }), page.click('button[type="submit"]')]); return page;
}
for (const [view, size] of Object.entries(VIEWS)) {
  // public
  let ctx = await browser.newContext({ viewport: size }); let page = await ctx.newPage();
  await page.goto(BASE + "/"); await shot(page, "landing", view);
  await page.goto(BASE + "/login"); await shot(page, "login", view);
  await ctx.close();
  // advisor: new request + request details
  ctx = await browser.newContext({ viewport: size }); page = await signIn(ctx, "advisor@preview.test", pw("advisor"));
  await page.goto(BASE + "/travel/requests/new"); await shot(page, "new-request", view);
  const list = await (await ctx.request.get(BASE + "/api/travel/requests")).json();
  const rows = Array.isArray(list) ? list : list.requests ?? [];
  const target = rows.find((r) => /recalc/i.test(r.title ?? "")) ?? rows[0];
  if (target) { await page.goto(`${BASE}/travel/requests/${target.id}`); await shot(page, "request-details", view); }
  await ctx.close();
  // admin
  ctx = await browser.newContext({ viewport: size }); page = await signIn(ctx, "admin@preview.test", pw("admin"));
  await shot(page, "admin-home", view);
  await page.goto(BASE + "/travel"); await shot(page, "admin-travel", view);
  await ctx.close();
}
await browser.close(); console.log(log.join("\n"));
