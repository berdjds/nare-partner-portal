import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COMPOSE_PATH = path.join(REPO_ROOT, "deploy", "dev", "docker-compose.yml");
const compose = readFileSync(COMPOSE_PATH, "utf8");
const servicesBlock = compose.match(/^services:\n([\s\S]*?)^networks:/m)?.[1] ?? "";

describe("deploy/dev/docker-compose.yml", () => {
  it("defines only portal-dev with its own image, container and memory limit", () => {
    const serviceNames = Array.from(servicesBlock.matchAll(/^  ([A-Za-z0-9_-]+):$/gm), (match) => match[1]);
    expect(serviceNames).toEqual(["portal-dev"]);
    expect(servicesBlock).toMatch(/^    container_name: portal-dev$/m);
    expect(servicesBlock).toMatch(/^    image: portal-dev:latest$/m);
    expect(servicesBlock).toMatch(/^    mem_limit: 1g$/m);
    expect(servicesBlock).not.toMatch(/aliases:\s*\n\s*-\s*portal(?:\s|$)/);
  });

  it("uses the dev URL and guarded credentials from the dev environment file", () => {
    expect(compose).toContain("- NEXTAUTH_URL=https://dev.portal.nare.am");
    for (const variable of ["PORTAL_NEXTAUTH_SECRET", "PORTAL_ADMIN_EMAIL", "PORTAL_ADMIN_PASSWORD"]) {
      expect(compose).toContain(
        `\${${variable}:?${variable} must be set in /opt/stack/dev/.env}`,
      );
    }
  });

  it("keeps WhatsApp disabled by default and uses the dev mail sink settings", () => {
    expect(compose).toContain("- WHATSAPP_DISABLED=${WHATSAPP_DISABLED:-1}");
    for (const variable of ["PORTAL_SMTP_HOST", "PORTAL_SMTP_PORT", "PORTAL_SMTP_USER", "PORTAL_SMTP_PASS", "PORTAL_SMTP_FROM"]) {
      expect(compose).toContain(`\${${variable}:-}`);
    }
  });

  it("isolates dev data under ./portal", () => {
    expect(compose).toContain("- ./portal/data:/app/data");
    expect(compose).toContain("- ./portal/uploads:/app/public/uploads");
    expect(compose).toContain("- ./portal/auth:/app/.wwebjs_auth");
  });

  it("joins only the external production network and publishes no host port", () => {
    expect(compose).toMatch(/^networks:\n  portal:\n(?:    .*\n)*    external: true$/m);
    expect(compose).toContain("name: ${PORTAL_NETWORK:?PORTAL_NETWORK must name the production network");
    expect(compose).not.toMatch(/^\s+ports:\s*$/m);
  });
});
