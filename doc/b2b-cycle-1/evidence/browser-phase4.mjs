// Phase 4 Chromium checks (isolated trial server, throwaway DB). node browser-phase4.mjs <base> <outDir>
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire("/home/aidev/multiagent/acceptance/");
const { chromium } = require("playwright");
const axeSrc = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const [base = "http://localhost:3112", out = "."] = process.argv.slice(2);
const PW = "Browser-Check-Passw0rd!";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };
const VIEWS = { desktop: { width: 1366, height: 900 }, tablet: { width: 820, height: 1180 }, phone: { width: 390, height: 844 } };
async function axe(page, label) {
  await page.evaluate(axeSrc);
  const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 3) })));
  const serious = r.filter((v) => ["serious", "critical"].includes(v.impact));
  check(`axe ${label}`, serious.length === 0, JSON.stringify(r));
}
async function login(page, email) {
  await page.goto(`${base}/login`); await page.fill("#email", email); await page.fill("#password", PW);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 }), page.click('button[type="submit"]')]);
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const browser = await chromium.launch();

for (const [v, size] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext({ viewport: size, locale: "en-US" });
  const page = await ctx.newPage(); page.setDefaultTimeout(90000);
  await page.goto(`${base}/login`);
  check(`${v}: English by default (lang=en dir=ltr)`, (await page.getAttribute("html", "lang")) === "en" && (await page.getAttribute("html", "dir")) === "ltr");
  if (v === "phone") await page.getByRole("button", { name: "Open menu" }).click(); // the switcher lives in the collapsed navigation on phones
  await page.getByRole("button", { name: "ՀԱՅ" }).click();
  await page.waitForLoadState("load"); await page.waitForSelector("html[lang='hy']", { timeout: 15000 });
  check(`${v}: switching to Armenian sets lang=hy, keeps dir=ltr`, (await page.getAttribute("html", "lang")) === "hy" && (await page.getAttribute("html", "dir")) === "ltr");
  check(`${v}: login labels are Armenian`, (await page.getByText("Մուտք գործընկերների պորտալ").count()) > 0 && (await page.locator("label[for=password]").innerText()) === "Գաղտնաբառ");
  const ff = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  check(`${v}: Armenian font stack leads with Noto Sans Armenian`, /armenian/i.test(ff), ff.slice(0, 80));
  check(`${v}: no horizontal scroll in Armenian`, (await overflow(page)) <= 1);
  await page.screenshot({ path: `${out}/p4-${v}-login-hy.png`, fullPage: true });
  if (v === "desktop") {
    await axe(page, "login (Armenian)");
    // identical localised error for unknown email and wrong password (no account existence leak)
    const msgs = [];
    for (const email of ["nobody@nowhere.test", "advisor@browser.test"]) {
      await page.fill("#email", email); await page.fill("#password", "wrong-password-123"); await page.click('button[type="submit"]');
      await page.waitForSelector('p[role="alert"]'); msgs.push(await page.locator('p[role="alert"]').innerText());
    }
    check("desktop: login failure message is Armenian and identical for unknown email and wrong password", msgs[0] === msgs[1] && /[Ա-֏]/.test(msgs[0]), msgs[0]);
    await page.goto(`${base}/terms`);
    check("desktop: choice persists on other public pages; footer in Armenian", (await page.getAttribute("html", "lang")) === "hy" && (await page.getByText("Գաղտնիություն").count()) > 0);
    await page.screenshot({ path: `${out}/p4-desktop-terms-hy.png`, fullPage: true });
    // Arabic is prepared but disabled: falls back to English
    await ctx.addCookies([{ name: "nare_locale", value: "ar", url: base }]);
    await page.goto(`${base}/login`);
    check("desktop: a disabled locale (ar) falls back to English", (await page.getAttribute("html", "lang")) === "en");
    await ctx.addCookies([{ name: "nare_locale", value: "en", url: base }]);
  }
  await ctx.close();
}

// admin: contact draft/publish, translations workflow
{
  const ctx = await browser.newContext({ viewport: VIEWS.desktop });
  const page = await ctx.newPage(); page.setDefaultTimeout(90000);
  await login(page, "admin@browser.test");
  page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text().slice(0, 200)); });
  await page.goto(`${base}/admin/contact`); await page.waitForSelector("#ct-general");
  await page.waitForFunction(() => document.querySelector("#ct-general")?.value !== "");
  check("admin: contact page loads global defaults (approved business data)", (await page.inputValue("#ct-general")) === "info@nare.am" && (await page.inputValue("#ct-b2b")) === "reservation@nare.am" && (await page.inputValue("#ct-year")) === "2019");
  await page.screenshot({ path: `${out}/p4-admin-contact.png`, fullPage: true });
  await page.fill("#ct-hours", "Mon-Fri 10:00-18:00"); await page.fill("#ct-lat", "40.1792"); await page.fill("#ct-lng", "44.4991");
  await page.getByLabel("Business hours", { exact: true }).first().waitFor();
  for (const lbl of ["Business hours", "Map"]) await page.locator("label", { hasText: new RegExp(`^\\s*${lbl}\\s*$`) }).locator("input").check();
  await page.fill("#ct-note", "browser check");
  await page.getByRole("button", { name: "Save draft" }).click(); await page.waitForSelector("text=v1");
  const before = await page.evaluate(async () => (await fetch("/api/public/contact")).json());
  check("admin: a saved draft is not public yet", !before.hours && !before.mapEmbedUrl);
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/admin/contact/publish") && r.status() === 200), page.getByRole("button", { name: /Publish draft/ }).click()]); await page.waitForTimeout(500);
  const after = await page.evaluate(async () => (await fetch("/api/public/contact", { cache: "no-store" })).json());
  check("admin: publishing makes hours and a keyless map embed public", after.hours === "Mon-Fri 10:00-18:00" && /output=embed/.test(after.mapEmbedUrl) && !/key=/i.test(JSON.stringify(after)));
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/admin/contact?scope=portal")), page.getByRole("button", { name: "Portal override" }).click()]); await page.waitForTimeout(500);
  check("admin: portal override starts inheriting (fields locked until overridden)", (await page.locator('input[type=checkbox]').first().isChecked()) === false);
  await page.screenshot({ path: `${out}/p4-admin-contact-portal.png`, fullPage: true });
  const anon = await browser.newContext({ viewport: VIEWS.desktop }); const pub = await anon.newPage(); pub.setDefaultTimeout(90000); await pub.goto(`${base}/`);
  check("public: landing contact block shows the published hours/map link and the approved emails", (await pub.getByText("Mon-Fri 10:00-18:00").count()) > 0 && (await pub.locator("iframe[title='Map']").count()) === 1);
  await pub.screenshot({ path: `${out}/p4-landing-contact.png`, fullPage: true }); await anon.close();
  await axe(page, "admin contact");

  await page.goto(`${base}/admin/translations`); await page.waitForSelector("text=Armenian");
  await page.getByRole("button", { name: /Garni and Geghard tour/ }).first().click();
  await page.waitForSelector("#tr-text");
  check("admin: AI generation is off by default with an explanation", (await page.getByRole("button", { name: "Generate AI draft" }).isDisabled()) && (await page.getByText("AI generation is switched off").count()) === 1);
  await page.fill("#tr-text", "Գառնիի և Գեղարդի էքսկուրսիա");
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/admin/translations") && r.request().method() === "POST"), page.getByRole("button", { name: "Save draft" }).click()]); await page.waitForSelector("text=Approve draft v1");
  await page.screenshot({ path: `${out}/p4-admin-translations-draft.png`, fullPage: true });
  const pre = await page.evaluate(async () => (await (await fetch("/api/admin/translations?locale=hy")).json()).items.find((i) => i.field === "name" && i.label === "Garni and Geghard tour").state);
  check("admin: a draft is not published (state draft)", pre === "draft");
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/admin/translations") && r.request().method() === "POST" && r.status() === 200), page.getByRole("button", { name: /Approve draft v1/ }).click()]); await page.waitForSelector("text=v1 · approved");
  const post = await page.evaluate(async () => (await (await fetch("/api/admin/translations?locale=hy")).json()).items.find((i) => i.label === "Garni and Geghard tour" && i.field === "name").state);
  check("admin: approval publishes it (state approved) and history records it", post === "approved");
  await page.screenshot({ path: `${out}/p4-admin-translations-approved.png`, fullPage: true });
  await axe(page, "admin translations");
  await ctx.close();
}

// phone width for admin translations, partner page in Armenian
{
  const ctx = await browser.newContext({ viewport: VIEWS.phone });
  const page = await ctx.newPage(); page.setDefaultTimeout(90000); await login(page, "admin@browser.test");
  await page.goto(`${base}/admin/translations`); await page.waitForSelector("text=Armenian");
  check("phone: admin translations has no horizontal scroll", (await overflow(page)) <= 1);
  await page.screenshot({ path: `${out}/p4-phone-admin-translations.png`, fullPage: true });
  await page.goto(`${base}/admin/contact`); await page.waitForSelector("#ct-general");
  check("phone: admin contact has no horizontal scroll", (await overflow(page)) <= 1);
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: VIEWS.desktop });
  await ctx2.addCookies([{ name: "nare_locale", value: "hy", url: base }]);
  const p2 = await ctx2.newPage(); p2.setDefaultTimeout(90000); await login(p2, "partner@browser.test");
  await p2.goto(`${base}/partner`);
  check("partner page renders in Armenian from the cookie", (await p2.getByText("Իմ առաջարկները").count()) > 0);
  await p2.screenshot({ path: `${out}/p4-partner-hy.png`, fullPage: true });
  const adm = await p2.evaluate(async () => [(await fetch("/api/admin/contact")).status, (await fetch("/api/admin/translations?locale=hy")).status]);
  check("partner is refused by the admin APIs", adm.every((s) => s === 401), JSON.stringify(adm));
  await ctx2.close();
}
await browser.close();
const failed = results.filter((r) => !r.ok);
writeFileSync(`${out}/browser-phase4-results.json`, JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
