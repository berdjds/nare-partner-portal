// Usage: node ux-audit.mjs --base <url> --label before|after
// Copied from doc/b2b-cycle-1/evidence/redesign-audit.mjs and extended for UX SP-1.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire("/home/aidev/multiagent/acceptance/package.json");
const { chromium } = require("playwright");
const axeSrc = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const ROUTES = ["/", "/partners/apply", "/login", "/forgot-password", "/reset-password", "/terms", "/privacy"];
const MATRIX_WIDTHS = [360, 390, 1440];
const HERO_WIDTHS = [600, 690, 900];
const PERFORMANCE_WIDTHS = [390, 1440];
const LANGUAGES = ["EN", "HY"];
const IMAGE_BUDGET_BYTES = 400 * 1024;
const results = [];
const rectanglesUrl = new URL("../HERO-RECTANGLES.md", import.meta.url);
const beforeUrl = new URL("./audit-before.json", import.meta.url);

const USAGE = "Usage: node doc/ux-polish-1/evidence/ux-audit.mjs --base <url> --label before|after";

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--base" && argument !== "--label") throw new Error(`Unknown argument: ${argument}\n${USAGE}`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}\n${USAGE}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.\n${USAGE}`);
    values.set(argument, value);
    index += 1;
  }
  if (values.size !== 2 || !values.has("--base") || !values.has("--label")) throw new Error(USAGE);
  const label = values.get("--label");
  if (label !== "before" && label !== "after") throw new Error("--label must be before or after.");
  let base;
  try {
    base = new URL(values.get("--base"));
  } catch {
    throw new Error("--base must be an absolute HTTP(S) URL.");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("--base must be an absolute HTTP(S) URL.");
  return { base, label };
}

function readRectangles() {
  const markdown = readFileSync(rectanglesUrl, "utf8");
  const match = markdown.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) throw new Error(`${fileURLToPath(rectanglesUrl)} has no json code block.`);
  const parsed = JSON.parse(match[1]);
  const convert = (rectangle, name) => {
    if (!rectangle || typeof rectangle !== "object") throw new Error(`Missing hero rectangle: ${name}.`);
    const converted = {};
    for (const key of ["x", "y", "width", "height"]) {
      converted[key] = Number(rectangle[key]);
      if (!Number.isFinite(converted[key])) throw new Error(`Hero rectangle ${name}.${key} must be a measured number, not a placeholder.`);
    }
    if (converted.x < 0 || converted.y < 0 || converted.width <= 0 || converted.height <= 0 || converted.x + converted.width > 100 || converted.y + converted.height > 100) {
      throw new Error(`Hero rectangle ${name} is outside the 0-100 percent photo box.`);
    }
    return { name, ...converted };
  };
  if (!Array.isArray(parsed.faces) || parsed.faces.length === 0) throw new Error("HERO-RECTANGLES.md must contain at least one measured face rectangle.");
  return {
    faces: parsed.faces.map((rectangle, index) => convert(rectangle, `faces[${index}]`)),
    standSignage: convert(parsed.standSignage, "standSignage"),
  };
}

const options = parseArgs(process.argv.slice(2));
const BASE = options.base;
const LABEL = options.label;
const protectedRectangles = readRectangles();
const screenshotDirectory = new URL(`./screenshots/${LABEL}/`, import.meta.url);
mkdirSync(screenshotDirectory, { recursive: true });
let beforeResults = [];
if (LABEL === "after") {
  const parsed = JSON.parse(readFileSync(beforeUrl, "utf8"));
  beforeResults = Array.isArray(parsed) ? parsed : parsed.checks;
  if (!Array.isArray(beforeResults)) throw new Error("audit-before.json must contain an array of check entries.");
}

const safeName = (value) => value.replace(/[^a-zA-Z0-9.-]+/g, "-").replace(/^-|-$/g, "");
const screenshotPath = (name) => fileURLToPath(new URL(`${safeName(name)}.png`, screenshotDirectory));
const routeName = (route) => route === "/" ? "landing" : route.slice(1).replaceAll("/", "-");
const motionName = (reducedMotion) => reducedMotion ? "reduced-motion" : "normal-motion";

function check(requirement, name, pass, details = {}) {
  const fullName = `${requirement} ${name}`;
  const entry = { id: fullName, requirement, name: fullName, pass: Boolean(pass), details };
  results.push(entry);
  const suffix = Object.keys(details).length > 0 ? ` - ${JSON.stringify(details)}` : "";
  console.log(`${entry.pass ? "PASS" : "FAIL"} ${fullName}${suffix}`);
  return entry;
}

async function guarded(requirement, name, callback) {
  try {
    await callback();
  } catch (error) {
    check(requirement, name, false, { error: error instanceof Error ? error.message : String(error) });
  }
}

function beforeEntry(name) {
  return beforeResults.find((entry) => entry.name === name || entry.id === name);
}

async function settle(page) {
  await page.waitForSelector("main h1, main h2, main h3, main [role=alert]", { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
}

async function createAuditedPage(browser, { route, width, language, reducedMotion = false, cls = false }) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    deviceScaleFactor: 1,
    locale: language === "HY" ? "hy-AM" : "en-US",
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
    extraHTTPHeaders: { "accept-language": language === "HY" ? "hy" : "en" },
  });
  await context.addCookies([{ name: "nare_locale", value: language.toLowerCase(), url: BASE.origin }]);
  const page = await context.newPage();
  const thirdPartyRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!/^https?:/.test(url)) return;
    if (new URL(url).origin !== BASE.origin) thirdPartyRequests.push(url);
  });
  if (cls) {
    await page.addInitScript(() => {
      window.__uxAuditClsSupported = false;
      window.__uxAuditHeroCls = 0;
      let largest = 0;
      let sessionValue = 0;
      let sessionStart = 0;
      let previousTime = 0;
      const observer = new PerformanceObserver((list) => {
        window.__uxAuditClsSupported = true;
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          const hero = document.querySelector("main > section");
          const inHero = entry.sources.some((source) => source.node && hero && hero.contains(source.node));
          if (!inHero) continue;
          if (sessionValue && (entry.startTime - previousTime > 1000 || entry.startTime - sessionStart > 5000)) sessionValue = 0;
          if (sessionValue === 0) sessionStart = entry.startTime;
          previousTime = entry.startTime;
          sessionValue += entry.value;
          largest = Math.max(largest, sessionValue);
          window.__uxAuditHeroCls = largest;
        }
      });
      observer.observe({ type: "layout-shift", buffered: true });
      window.__uxAuditClsSupported = true;
    });
  }
  await page.goto(new URL(route, BASE).href, { waitUntil: "domcontentloaded" });
  await settle(page);
  return { context, page, thirdPartyRequests };
}

async function runAxeAndOverflow(page, contextName) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("TR-UX-002", `${contextName} horizontal scroll`, overflow <= 0, { overflow });
  await page.evaluate(axeSrc);
  const violations = await page.evaluate(async () => {
    const report = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] });
    return report.violations.filter((violation) => ["serious", "critical"].includes(violation.impact)).map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
      target: violation.nodes[0]?.target.join(" ").slice(0, 120) ?? "",
    }));
  });
  const serious = violations.filter((violation) => violation.impact === "serious").length;
  const critical = violations.filter((violation) => violation.impact === "critical").length;
  const seriousNodes = violations.filter((violation) => violation.impact === "serious").reduce((sum, violation) => sum + violation.nodes, 0);
  const criticalNodes = violations.filter((violation) => violation.impact === "critical").reduce((sum, violation) => sum + violation.nodes, 0);
  check("TR-UX-002", `${contextName} axe wcag2a wcag2aa wcag21aa serious and critical`, serious === 0 && critical === 0, { serious, critical, seriousNodes, criticalNodes, violations });
}

async function auditOpacity(page, contextName) {
  const hidden = await page.evaluate(() => [...document.body.querySelectorAll("*")].filter((element) => {
    const style = getComputedStyle(element);
    return Number(style.opacity) === 0 && element.getClientRects().length > 0;
  }).map((element) => ({
    tag: element.tagName.toLowerCase(),
    id: element.id,
    class: typeof element.className === "string" ? element.className.slice(0, 120) : "",
  })));
  check("TR-UX-002", `${contextName} reduced-motion opacity-0 elements after load`, hidden.length === 0, { hidden });
}

async function auditGeometry(page, contextName) {
  const geometry = await page.evaluate((rectangles) => {
    const hero = document.querySelector("main > section");
    const heading = hero?.querySelector("h1");
    const panel = hero?.querySelector(".hero-text-panel") ?? heading?.parentElement;
    const photo = hero?.querySelector("img[fetchpriority='high'], img[fetchPriority='high']") ?? hero?.querySelector("img");
    if (!panel || !photo) return { error: "Hero text panel or photograph was not found." };
    const panelBox = panel.getBoundingClientRect();
    const photoBox = photo.getBoundingClientRect();
    const toPixels = (rectangle) => ({
      name: rectangle.name,
      left: photoBox.left + photoBox.width * rectangle.x / 100,
      top: photoBox.top + photoBox.height * rectangle.y / 100,
      width: photoBox.width * rectangle.width / 100,
      height: photoBox.height * rectangle.height / 100,
    });
    const overlap = (rectangle) => {
      const width = Math.max(0, Math.min(panelBox.right, rectangle.left + rectangle.width) - Math.max(panelBox.left, rectangle.left));
      const height = Math.max(0, Math.min(panelBox.bottom, rectangle.top + rectangle.height) - Math.max(panelBox.top, rectangle.top));
      return width * height;
    };
    const protectedBoxes = [...rectangles.faces, rectangles.standSignage].map(toPixels).map((rectangle) => ({ ...rectangle, overlapPixels: overlap(rectangle) }));
    return {
      panel: { left: panelBox.left, top: panelBox.top, width: panelBox.width, height: panelBox.height },
      photo: { left: photoBox.left, top: photoBox.top, width: photoBox.width, height: photoBox.height },
      protectedBoxes,
    };
  }, protectedRectangles);
  check("FR-UX-001", `${contextName} hero-text-panel geometry against HERO-RECTANGLES.md`, !geometry.error && Array.isArray(geometry.protectedBoxes) && geometry.protectedBoxes.every((rectangle) => rectangle.overlapPixels <= 1), geometry);
}

async function measureContrast(page, selector) {
  const styles = await page.evaluate((containerSelector) => {
    const container = document.querySelector(containerSelector);
    if (!container) throw new Error(`Contrast container not found: ${containerSelector}`);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const element = node.parentElement;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.top >= window.innerHeight || box.right <= 0 || box.left >= window.innerWidth) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      nodes.push(node);
    }
    const box = container.getBoundingClientRect();
    return nodes.map((node) => {
      const element = node.parentElement;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        color: style.color,
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
        rect: { left: box.left, top: box.top, width: box.width, height: box.height },
      };
    });
  }, selector);

  await page.evaluate((containerSelector) => {
    const container = document.querySelector(containerSelector);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.textContent.trim() && node.parentElement.getClientRects().length > 0) nodes.push(node);
    }
    for (const node of nodes) {
      const span = document.createElement("span");
      span.dataset.uxAuditHiddenText = "";
      span.style.visibility = "hidden";
      node.replaceWith(span);
      span.append(node);
    }
  }, selector);

  let screenshot;
  try {
    screenshot = await page.screenshot({ type: "png", scale: "css" });
  } finally {
    await page.evaluate(() => {
      for (const span of document.querySelectorAll("[data-ux-audit-hidden-text]")) {
        const parent = span.parentNode;
        span.replaceWith(...span.childNodes);
        parent.normalize();
      }
    });
  }

  return page.evaluate(async ({ png, textStyles }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (red, green, blue) => 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    const ratio = (first, second) => (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    const measurements = textStyles.map((text) => {
      const left = Math.max(0, Math.floor(text.rect.left));
      const top = Math.max(0, Math.floor(text.rect.top));
      const right = Math.min(canvas.width, Math.ceil(text.rect.left + text.rect.width));
      const bottom = Math.min(canvas.height, Math.ceil(text.rect.top + text.rect.height));
      const pixels = context.getImageData(left, top, Math.max(1, right - left), Math.max(1, bottom - top)).data;
      const colorParts = text.color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
      const alpha = colorParts.length > 3 ? colorParts[3] : 1;
      let minimum = Infinity;
      let samples = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const backgroundAlpha = pixels[index + 3] / 255;
        const background = [0, 1, 2].map((offset) => pixels[index + offset] * backgroundAlpha + 255 * (1 - backgroundAlpha));
        const foreground = [0, 1, 2].map((offset) => colorParts[offset] * alpha + background[offset] * (1 - alpha));
        minimum = Math.min(minimum, ratio(luminance(...foreground), luminance(...background)));
        samples += 1;
      }
      const large = text.fontSize >= 24 || (text.fontSize >= 18.66 && text.fontWeight >= 700);
      const required = large ? 3 : 4.5;
      return { tag: text.tag, minimum: Number.isFinite(minimum) ? minimum : 0, required, samples, pass: samples > 0 && minimum + 0.001 >= required };
    });
    return { minimum: Math.min(...measurements.map((measurement) => measurement.minimum)), measurements };
  }, { png: screenshot.toString("base64"), textStyles: styles });
}

async function auditHeroContrast(page, contextName) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const hero = document.querySelector("main > section");
    const panel = hero?.querySelector(".hero-text-panel") ?? hero?.querySelector("h1")?.parentElement;
    if (!panel) throw new Error("Hero text panel was not found.");
    panel.setAttribute("data-ux-audit-hero-panel", "");
  });
  await page.waitForTimeout(100);
  const contrast = await measureContrast(page, "[data-ux-audit-hero-panel]");
  check("FR-UX-001", `${contextName} minimum hero panel contrast with visibility-hidden text`, contrast.measurements.length > 0 && contrast.measurements.every((measurement) => measurement.pass), contrast);
}

async function auditServiceTiles(page, contextName, width) {
  if (width !== 360 && width !== 390) return;
  await page.locator("#services").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const tiles = await page.evaluate(() => [...document.querySelectorAll("#services ul > li")].map((tile, index) => {
    tile.setAttribute("data-ux-audit-service-tile", String(index));
    const paragraphs = [...tile.querySelectorAll("p")];
    const title = tile.querySelector(".mt-10 p:first-child") ?? paragraphs[1];
    const body = paragraphs.at(-1);
    const tileStyle = getComputedStyle(tile);
    const titleStyle = title ? getComputedStyle(title) : null;
    const bodyStyle = body ? getComputedStyle(body) : null;
    const px = (value) => Number.parseFloat(value);
    return {
      index,
      title: titleStyle ? { fontSize: px(titleStyle.fontSize), lineHeight: px(titleStyle.lineHeight), fontWeight: titleStyle.fontWeight } : null,
      body: bodyStyle ? { fontSize: px(bodyStyle.fontSize), lineHeight: px(bodyStyle.lineHeight) } : null,
      padding: { top: px(tileStyle.paddingTop), right: px(tileStyle.paddingRight), bottom: px(tileStyle.paddingBottom), left: px(tileStyle.paddingLeft) },
    };
  }));
  check("FR-UX-002", `${contextName} service tile font size line height and padding`, tiles.length === 3 && tiles.every((tile) => {
    const title = tile.title;
    const body = tile.body;
    return title && body && title.fontSize >= 18 && title.lineHeight / title.fontSize >= 1.15 && body.fontSize >= 16 && body.lineHeight / body.fontSize >= 1.4 && Object.values(tile.padding).every((value) => value >= 24);
  }), { tiles });
  for (const tile of tiles) {
    const selector = `[data-ux-audit-service-tile='${tile.index}']`;
    await page.locator(selector).scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const contrast = await measureContrast(page, selector);
    check("FR-UX-002", `${contextName} service tile ${tile.index + 1} contrast`, contrast.measurements.length > 0 && contrast.measurements.every((measurement) => measurement.pass), contrast);
  }
}

async function auditHeadings(page, contextName, route, width, language) {
  const headings = await page.evaluate(() => [...document.querySelectorAll("main h1, main h2, main h3")].map((heading) => {
    const style = getComputedStyle(heading);
    const legalBody = Boolean(heading.closest("article") && heading.tagName === "H2" && !heading.closest("nav"));
    return {
      tag: heading.tagName.toLowerCase(),
      id: heading.id,
      text: heading.textContent.trim().slice(0, 100),
      className: heading.className,
      legalBody,
      hero: Boolean(heading.closest("main > section") && heading.tagName === "H1" && !heading.closest("article")),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  }));
  const expectedFamily = language === "HY" ? /Noto Serif Armenian/i : /Fraunces/i;
  const expectedSize = (heading) => {
    if (heading.legalBody) return 20;
    if (heading.tag === "h3") return 20;
    if (heading.tag === "h2") return 30;
    return width < 640 ? 30 : 36;
  };
  const measured = headings.map((heading) => ({
    ...heading,
    expectedSize: heading.hero ? null : expectedSize(heading),
    familyPass: expectedFamily.test(heading.fontFamily),
    weightPass: Number(heading.fontWeight) === 600,
    sizePass: heading.hero || Number.parseFloat(heading.fontSize) === expectedSize(heading),
    legalExceptionPass: !heading.legalBody || heading.className.split(/\s+/).includes("legal-body"),
  }));
  check("FR-UX-005", `${contextName} computed h1 h2 h3 family size weight and legal exception`, measured.length > 0 && measured.every((heading) => heading.familyPass && heading.weightPass && heading.sizePass && heading.legalExceptionPass), { headings: measured });

  if (route === "/") {
    const hero = headings.find((heading) => heading.hero);
    const name = `FR-UX-005 ${contextName} landing hero h1 computed font size matches audit-before.json`;
    const before = LABEL === "after" ? beforeEntry(name) : null;
    const pass = hero && (LABEL === "before" || before?.details?.fontSize === hero.fontSize);
    check("FR-UX-005", `${contextName} landing hero h1 computed font size matches audit-before.json`, pass, {
      fontSize: hero?.fontSize ?? null,
      beforeFontSize: LABEL === "after" ? before?.details?.fontSize ?? null : null,
    });
  }

  if (route === "/terms" || route === "/privacy") {
    const classification = await page.evaluate(() => {
      const article = document.querySelector("main article");
      const navigation = article?.querySelector("nav");
      const labelId = navigation?.getAttribute("aria-labelledby");
      const label = labelId ? document.getElementById(labelId) : null;
      const contact = document.getElementById("legal-contact-heading");
      return {
        navigationLabelledBy: labelId,
        labelTag: label?.tagName.toLowerCase() ?? null,
        labelText: label?.textContent.trim() ?? null,
        contactTag: contact?.tagName.toLowerCase() ?? null,
        contactClass: contact?.className ?? null,
      };
    });
    const tocPass = classification.labelTag && classification.labelTag !== "h2" && (language === "HY" || classification.labelText === "On this page");
    const contactPass = classification.contactTag === "h2" && (classification.contactClass ?? "").split(/\s+/).includes("legal-body");
    check("FR-UX-005", `${contextName} LegalPage On this page is a non-h2 TOC label and Contact us is a legal-body h2`, Boolean(tocPass && contactPass), classification);
  }
}

async function auditAboutDecoration(page, contextName) {
  const details = await page.evaluate(() => {
    const about = document.querySelector("#about");
    const decoration = about?.querySelector(".about-decoration") ?? about?.querySelector("[aria-hidden='true']");
    if (!about || !decoration) return { error: "About section or about-decoration was not found." };
    const section = about.getBoundingClientRect();
    const box = decoration.getBoundingClientRect();
    return {
      decoration: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      section: { left: section.left, right: section.right, top: section.top, bottom: section.bottom },
      contained: box.left >= section.left - 1 && box.right <= section.right + 1 && box.top >= section.top - 1 && box.bottom <= section.bottom + 1,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  check("FR-UX-011", `${contextName} about-decoration containment and scrollWidth`, !details.error && details.contained && details.scrollWidth <= details.innerWidth, details);
}

async function auditCls(page, contextName, width) {
  if (!PERFORMANCE_WIDTHS.includes(width)) return;
  const cls = await page.evaluate(() => ({ supported: window.__uxAuditClsSupported === true, value: window.__uxAuditHeroCls ?? 0 }));
  const name = `FR-UX-001 ${contextName} hero CLS within before + 0.01 and 0.1`;
  const before = LABEL === "after" ? beforeEntry(name) : null;
  const beforeValue = before?.details?.cls ?? before?.value;
  const withinBefore = LABEL === "before" || (Number.isFinite(beforeValue) && cls.value <= beforeValue + 0.01);
  check("FR-UX-001", `${contextName} hero CLS within before + 0.01 and 0.1`, cls.supported && cls.value <= 0.1 && withinBefore, {
    cls: cls.value,
    supported: cls.supported,
    beforeCls: LABEL === "after" ? beforeValue ?? null : null,
    beforeLimit: LABEL === "after" && Number.isFinite(beforeValue) ? beforeValue + 0.01 : null,
    absoluteLimit: 0.1,
  });
}

async function auditAnchors(page, contextName, route, width) {
  if ((route !== "/terms" && route !== "/privacy") || (width !== 360 && width !== 1440)) return;
  const links = await page.locator("main article nav a[href^='#']").evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")));
  const positions = [];
  for (const hash of links) {
    await page.locator(`main article nav a[href='${hash}']`).click();
    await page.waitForTimeout(150);
    positions.push(await page.evaluate((targetHash) => {
      const target = document.getElementById(decodeURIComponent(targetHash.slice(1)));
      const stickyHeaders = [...document.querySelectorAll("header")].filter((header) => {
        const style = getComputedStyle(header);
        return (style.position === "sticky" || style.position === "fixed") && header.getClientRects().length > 0;
      });
      const headerBottom = Math.max(0, ...stickyHeaders.map((header) => header.getBoundingClientRect().bottom));
      return { hash: targetHash, headingTop: target?.getBoundingClientRect().top ?? null, headerBottom, hashMatches: window.location.hash === targetHash };
    }, hash));
  }
  check("FR-UX-003", `${contextName} TOC anchor headings below sticky header`, links.length > 0 && positions.every((position) => position.hashMatches && position.headingTop !== null && position.headingTop > position.headerBottom), { positions });
}

async function captureMatrixPage(browser, route, width, language, reducedMotion) {
  const contextName = `${motionName(reducedMotion)} ${language} ${route} ${width}px`;
  const needsCls = route === "/" && PERFORMANCE_WIDTHS.includes(width);
  const { context, page, thirdPartyRequests } = await createAuditedPage(browser, { route, width, language, reducedMotion, cls: needsCls });
  try {
    await runAxeAndOverflow(page, contextName);
    if (reducedMotion) await auditOpacity(page, contextName);
    if (route === "/" && needsCls) await guarded("FR-UX-001", `${contextName} hero CLS`, () => auditCls(page, contextName, width));
    if (route === "/") {
      await guarded("FR-UX-001", `${contextName} geometry`, () => auditGeometry(page, contextName));
      await guarded("FR-UX-001", `${contextName} contrast`, () => auditHeroContrast(page, contextName));
      await guarded("FR-UX-002", `${contextName} service tiles`, () => auditServiceTiles(page, contextName, width));
      await guarded("FR-UX-011", `${contextName} about decoration`, () => auditAboutDecoration(page, contextName));
    }
    await guarded("FR-UX-005", `${contextName} headings`, () => auditHeadings(page, contextName, route, width, language));
    if (!reducedMotion) {
      check("TR-UX-003", `${contextName} third-party request count`, thirdPartyRequests.length === 0, { count: thirdPartyRequests.length, requests: thirdPartyRequests });
      await page.screenshot({ path: screenshotPath(`${contextName}-${routeName(route)}`), fullPage: true });
      await page.evaluate(() => window.scrollTo(0, 0));
      await guarded("FR-UX-003", `${contextName} anchors`, () => auditAnchors(page, contextName, route, width));
    }
  } finally {
    await context.close();
  }
}

async function capturePerformance(browser, width, language) {
  const contextName = `normal-motion ${language} / ${width}px cold-cache-no-scroll`;
  const { context, page } = await createAuditedPage(browser, { route: "/", width, language });
  const cdp = await context.newCDPSession(page);
  const imageRequests = new Map();
  let imageBytes = 0;
  cdp.on("Network.responseReceived", ({ requestId, type, response }) => {
    if (type === "Image") imageRequests.set(requestId, response.url);
  });
  cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
    if (imageRequests.has(requestId)) imageBytes += encodedDataLength;
  });
  try {
    await cdp.send("Network.enable");
    await cdp.send("Network.clearBrowserCache");
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle(page);
    const images = await page.evaluate(() => [...document.images].map((image) => ({ src: image.currentSrc, complete: image.complete, naturalWidth: image.naturalWidth })));
    const hero = await page.evaluate(() => {
      const image = document.querySelector("main > section img");
      return image ? { src: image.getAttribute("src"), srcSet: image.getAttribute("srcset"), sizes: image.getAttribute("sizes"), loading: image.getAttribute("loading"), fetchPriority: image.getAttribute("fetchpriority") } : null;
    });
    check("TR-UX-003", `${contextName} transferred image bytes at most 400 KB`, imageBytes <= IMAGE_BUDGET_BYTES, { imageBytes, budgetBytes: IMAGE_BUDGET_BYTES, images });
    check("TR-UX-003", `${contextName} hero image loading attributes unchanged`, hero?.src === "/brand/photos/hero-expo-1920.webp" && hero.srcSet === "/brand/photos/hero-expo-960.webp 960w, /brand/photos/hero-expo-1920.webp 1920w" && hero.sizes === "100vw" && (hero.loading === null || hero.loading === "eager") && hero.fetchPriority === "high", hero ?? {});
  } finally {
    await cdp.detach();
    await context.close();
  }
}

const browser = await chromium.launch();
try {
  for (const reducedMotion of [false, true]) {
    for (const language of LANGUAGES) {
      for (const width of MATRIX_WIDTHS) {
        for (const route of ROUTES) await captureMatrixPage(browser, route, width, language, reducedMotion);
      }
      for (const width of HERO_WIDTHS) await captureMatrixPage(browser, "/", width, language, reducedMotion);
    }
  }
  for (const language of LANGUAGES) {
    for (const width of PERFORMANCE_WIDTHS) await capturePerformance(browser, width, language);
  }
} finally {
  await browser.close();
}

const outputUrl = new URL(`./audit-${LABEL}.json`, import.meta.url);
writeFileSync(outputUrl, `${JSON.stringify(results, null, 2)}\n`, "utf8");
const passed = results.filter((result) => result.pass).length;
console.log(`\n${passed}/${results.length} passed`);
console.log(`Wrote ${fileURLToPath(outputUrl)}`);
console.log(`Screenshots: ${fileURLToPath(screenshotDirectory)}`);
if (passed !== results.length) process.exitCode = 1;
