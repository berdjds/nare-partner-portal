import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROUTES = [
  "/",
  "/partners/apply",
  "/login",
  "/forgot-password",
  "/reset-password",
  "/terms",
  "/privacy",
];
const FORMAT_HEADER = "headers-fetch evidence v1";
const CSP_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
]);
const USAGE = `Usage:
  node doc/ux-polish-1/evidence/headers-fetch.mjs --base <url> --label before|after
  node doc/ux-polish-1/evidence/headers-fetch.mjs --diff`;

class UsageError extends Error {}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArgs(args) {
  const seen = new Set();
  let base;
  let label;
  let diff = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!["--base", "--label", "--diff"].includes(argument)) {
      throw new UsageError(`Unknown argument: ${argument}`);
    }
    if (seen.has(argument)) {
      throw new UsageError(`Duplicate argument: ${argument}`);
    }
    seen.add(argument);

    if (argument === "--diff") {
      diff = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${argument} requires a value.`);
    }
    index += 1;
    if (argument === "--base") base = value;
    if (argument === "--label") label = value;
  }

  if (diff) {
    if (seen.size !== 1) {
      throw new UsageError("--diff cannot be combined with other arguments.");
    }
    return { mode: "diff" };
  }

  if (!base || !label || seen.size !== 2) {
    throw new UsageError("Both --base and --label are required.");
  }
  if (label !== "before" && label !== "after") {
    throw new UsageError("--label must be either before or after.");
  }

  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new UsageError("--base must be an absolute HTTP(S) URL.");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new UsageError("--base must be an absolute HTTP(S) URL.");
  }

  return { mode: "fetch", baseUrl, label };
}

async function captureEvidence(baseUrl) {
  const evidence = new Map();
  const routes = [...ROUTES].sort(compareText);

  for (const route of routes) {
    // Manual redirects keep the original status and headers available as evidence.
    const response = await fetch(new URL(route, baseUrl), { redirect: "manual" });
    try {
      const headers = new Map();
      for (const [name, value] of response.headers) {
        headers.set(name, value);
      }
      evidence.set(route, { status: response.status, headers });
    } finally {
      if (response.body !== null) await response.body.cancel();
    }
  }

  return evidence;
}

function formatEvidence(evidence) {
  const lines = [FORMAT_HEADER];
  const routes = [...evidence.keys()].sort(compareText);

  for (const route of routes) {
    const response = evidence.get(route);
    lines.push("", `route ${route}`, `status ${response.status}`);
    const headers = [...response.headers.entries()].sort(([left], [right]) =>
      compareText(left, right),
    );
    for (const [name, value] of headers) {
      lines.push(`header ${name}: ${value}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function parseEvidence(text, sourceName) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== FORMAT_HEADER) {
    throw new Error(`${sourceName}: missing or unsupported format header.`);
  }

  const evidence = new Map();
  let currentRoute = null;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line === "") continue;

    if (line.startsWith("route ")) {
      const route = line.slice("route ".length);
      if (!route.startsWith("/") || /\s/.test(route)) {
        throw new Error(`${sourceName}:${lineNumber}: invalid route.`);
      }
      if (evidence.has(route)) {
        throw new Error(`${sourceName}:${lineNumber}: duplicate route ${route}.`);
      }
      evidence.set(route, { status: null, headers: new Map() });
      currentRoute = route;
      continue;
    }

    if (currentRoute === null) {
      throw new Error(`${sourceName}:${lineNumber}: expected a route.`);
    }
    const current = evidence.get(currentRoute);

    if (line.startsWith("status ")) {
      const statusText = line.slice("status ".length);
      if (!/^\d{3}$/.test(statusText) || current.status !== null) {
        throw new Error(`${sourceName}:${lineNumber}: invalid or duplicate status.`);
      }
      current.status = Number(statusText);
      continue;
    }

    if (line.startsWith("header ")) {
      const payload = line.slice("header ".length);
      const colon = payload.indexOf(":");
      const name = colon === -1 ? "" : payload.slice(0, colon);
      const valueWithDelimiter = colon === -1 ? "" : payload.slice(colon + 1);
      if (
        !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name) ||
        !valueWithDelimiter.startsWith(" ")
      ) {
        throw new Error(`${sourceName}:${lineNumber}: invalid header line.`);
      }
      if (current.headers.has(name)) {
        throw new Error(
          `${sourceName}:${lineNumber}: duplicate header ${name} for ${currentRoute}.`,
        );
      }
      current.headers.set(name, valueWithDelimiter.slice(1));
      continue;
    }

    throw new Error(`${sourceName}:${lineNumber}: unrecognized line.`);
  }

  if (evidence.size === 0) {
    throw new Error(`${sourceName}: no responses found.`);
  }
  for (const [route, response] of evidence) {
    if (response.status === null) {
      throw new Error(`${sourceName}: missing status for ${route}.`);
    }
  }

  return evidence;
}

function normalizeCspNonces(value) {
  // Normalize the nonce value wherever it appears, not only in quoted source tokens.
  return value.replace(
    /nonce-[A-Za-z0-9+/_-]+={0,2}/gi,
    "nonce-<normalized>",
  );
}

function parseCsp(value) {
  const directives = new Map();
  for (const part of normalizeCspNonces(value).split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    // CSP uses the first occurrence when a directive is repeated.
    if (!directives.has(name)) directives.set(name, new Set(tokens.slice(1)));
  }
  return directives;
}

function findLoosenedCsp(before, after) {
  const loosened = [];
  const routes = [...new Set([...before.keys(), ...after.keys()])].sort(compareText);

  for (const route of routes) {
    const left = before.get(route);
    const right = after.get(route);
    if (!left || !right) continue;

    for (const name of CSP_HEADERS) {
      const leftValue = left.headers.get(name);
      const rightValue = right.headers.get(name);
      if (leftValue !== undefined && rightValue === undefined) {
        loosened.push(`${route}: ${name} was removed, removing all of its directives.`);
        continue;
      }
      if (leftValue === undefined || rightValue === undefined) continue;

      const beforeDirectives = parseCsp(leftValue);
      const afterDirectives = parseCsp(rightValue);
      for (const directive of beforeDirectives.keys()) {
        if (!afterDirectives.has(directive)) {
          loosened.push(`${route}: ${name} removed directive ${directive}.`);
        }
      }

      for (const [directive, afterSources] of afterDirectives) {
        const beforeSources = beforeDirectives.get(directive) ?? new Set();
        for (const source of afterSources) {
          if (beforeSources.has(source) || source.toLowerCase() === "'none'") continue;
          loosened.push(`${route}: ${name} ${directive} added source ${source}.`);
          const lowerSource = source.toLowerCase();
          if (lowerSource === "'unsafe-inline'" || lowerSource === "'unsafe-eval'") {
            loosened.push(`${route}: ${name} ${directive} introduced ${lowerSource}.`);
          }
          if (source.includes("*")) {
            loosened.push(`${route}: ${name} ${directive} introduced wildcard source ${source}.`);
          }
        }
      }
    }
  }

  return loosened;
}

function compareEvidence(before, after) {
  const differences = [];
  const routes = [...new Set([...before.keys(), ...after.keys()])].sort(compareText);

  for (const route of routes) {
    const left = before.get(route);
    const right = after.get(route);
    if (!left) {
      differences.push(`${route}: route is missing from the before capture.`);
      continue;
    }
    if (!right) {
      differences.push(`${route}: route is missing from the after capture.`);
      continue;
    }
    if (left.status !== right.status) {
      differences.push(
        `${route}: status changed from ${left.status} to ${right.status}.`,
      );
    }

    const headerNames = [
      ...new Set([...left.headers.keys(), ...right.headers.keys()]),
    ].sort(compareText);

    for (const name of headerNames) {
      if (!left.headers.has(name)) {
        differences.push(`${route}: header ${name} is missing from the before capture.`);
        continue;
      }
      if (!right.headers.has(name)) {
        differences.push(`${route}: header ${name} is missing from the after capture.`);
        continue;
      }
      if (name === "date" || name === "etag") continue;

      const leftValue = left.headers.get(name);
      const rightValue = right.headers.get(name);
      const isCsp = CSP_HEADERS.has(name);
      const normalizedLeft = isCsp ? normalizeCspNonces(leftValue) : leftValue;
      const normalizedRight = isCsp ? normalizeCspNonces(rightValue) : rightValue;

      if (normalizedLeft !== normalizedRight) {
        const qualifier = isCsp ? " beyond nonce normalization" : "";
        differences.push(
          `${route}: header ${name} changed${qualifier}.\n` +
            `  before: ${JSON.stringify(normalizedLeft)}\n` +
            `  after:  ${JSON.stringify(normalizedRight)}`,
        );
      }
    }
  }

  return differences;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`Error: ${error.message}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  try {
    if (options.mode === "fetch") {
      const evidence = await captureEvidence(options.baseUrl);
      const outputUrl = new URL(`headers-${options.label}.txt`, import.meta.url);
      await writeFile(outputUrl, formatEvidence(evidence), "utf8");
      console.log(
        `Wrote ${fileURLToPath(outputUrl)} with ${evidence.size} responses.`,
      );
      return;
    }

    const beforeUrl = new URL("headers-before.txt", import.meta.url);
    const afterUrl = new URL("headers-after.txt", import.meta.url);
    const [beforeText, afterText] = await Promise.all([
      readFile(beforeUrl, "utf8"),
      readFile(afterUrl, "utf8"),
    ]);
    const before = parseEvidence(beforeText, fileURLToPath(beforeUrl));
    const after = parseEvidence(afterText, fileURLToPath(afterUrl));
    const differences = compareEvidence(before, after);
    const loosenedCsp = findLoosenedCsp(before, after);

    if (differences.length > 0) {
      console.error(`Found ${differences.length} header difference(s):`);
      for (const difference of differences) console.error(`- ${difference}`);
    }
    if (loosenedCsp.length > 0) {
      console.error(`Found ${loosenedCsp.length} loosened Content-Security-Policy change(s):`);
      for (const change of loosenedCsp) console.error(`- ${change}`);
    }
    if (differences.length > 0 || loosenedCsp.length > 0) {
      process.exitCode = 1;
      return;
    }

    console.log(
      `Headers and statuses match for ${before.size} routes with no CSP loosening; Date and ETag values were ignored and CSP nonces were normalized.`,
    );
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
