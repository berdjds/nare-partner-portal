/**
 * Reports whether AI translation is configured, without ever printing the key.
 *   npx tsx scripts/check-translation-provider.ts           -> configuration status only
 *   npx tsx scripts/check-translation-provider.ts --live    -> also translates one harmless fixed sentence
 * Exit codes: 0 configured (and working with --live), 2 not configured, 3 configured but the live call failed.
 */
import { getTranslationProvider } from "../lib/i18n/provider";

async function main() {
  const named = process.env.TRANSLATION_PROVIDER === "deepseek";
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY);
  console.log(`TRANSLATION_PROVIDER set to deepseek: ${named}`);
  console.log(`DEEPSEEK_API_KEY present: ${hasKey}`);
  const provider = getTranslationProvider();
  if (!provider) {
    console.log("status: NOT CONFIGURED (generation stays disabled; the draft/approve workflow still works)");
    process.exit(2);
  }
  console.log(`status: configured (${provider.id})`);
  if (!process.argv.includes("--live")) return;
  try {
    const out = await provider.translate("Welcome to our partner portal.", "hy");
    console.log(`live test: OK (${Array.from(out).length} characters returned)`);
  } catch (e) {
    console.log(`live test: FAILED (${e instanceof Error ? e.message.replace(/Bearer\s+\S+/g, "Bearer ***") : "error"})`);
    process.exit(3);
  }
}
void main();
