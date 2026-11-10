/**
 * AI translation provider, behind a provider-independent interface. Generation is OFF unless
 * the server environment names a provider AND holds its key. The adapter mirrors the one the
 * Nare staging site already uses (DeepSeek's OpenAI-compatible chat endpoint) so the same
 * account can be reused, but nothing is coupled to that site: no code, storage or runtime call.
 *
 * Data minimisation: the only things sent are a fixed instruction and the English text of ONE
 * admin-managed field. assertSafeToSend() additionally refuses text that looks like personal,
 * contact or booking data, so a mistake in content cannot leak it to a third party.
 */

export interface TranslationProvider {
  /** Recorded on every AI draft (provider and model). */
  id: string;
  translate(text: string, locale: string): Promise<string>;
}

const LANGUAGE_NAMES: Record<string, string> = { hy: "Armenian (Հայերեն)", ar: "Arabic (العربية)" };

export function getTranslationProvider(env: Record<string, string | undefined> = process.env): TranslationProvider | null {
  if (env.TRANSLATION_PROVIDER === "deepseek" && env.DEEPSEEK_API_KEY) return deepSeekProvider(env.DEEPSEEK_API_KEY);
  return null;
}

export function deepSeekProvider(apiKey: string, fetchImpl: typeof fetch = fetch): TranslationProvider {
  return {
    id: "deepseek:deepseek-chat",
    async translate(text, locale) {
      const language = LANGUAGE_NAMES[locale] ?? locale;
      const res = await fetchImpl("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.2,
          max_tokens: 1200,
          messages: [
            {
              role: "system",
              content: `You are a professional translator for travel and tourism content. Translate the user's English text into ${language}. Keep proper nouns and brand names, preserve line breaks, return only the translation.`,
            },
            { role: "user", content: text },
          ],
        }),
      });
      if (!res.ok) throw new Error(`provider status ${res.status}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const out = data.choices?.[0]?.message?.content?.trim();
      if (!out) throw new Error("empty provider answer");
      return out;
    },
  };
}

const EMAIL = /[A-Z0-9._%+-]+\s*@\s*[A-Z0-9.-]+\.[A-Z]{2,}/i;
const EMAIL_WORDS = /\b[\w.-]+\s*[([]?\s*at\s*[)\]]?\s*[\w-]+\s*[([]?\s*dot\s*[)\]]?\s*[a-z]{2,}\b/i;
const PHONE = /(?:\+|\b)\d[\d\s().-]{5,}\d/g;
const BOOKING = /\b[A-Z]{2,8}-\d{4}-\d{2}-\d{2}-\d{4}\b/i;
const URL_LIKE = /https?:\/\/|www\./i;
const MONEY = /\d[\d.,\s]*\s?(?:usd|eur|amd|rub|gel|dram|dollars?|euros?)\b|[$€£֏₽₾]\s?\d|\d\s?[$€£֏₽₾]|\b(?:margin|markup|mark-up|commission|net rate|net price|supplier rate|cost price|purchase price|wholesale)\b|\d\s?%/i;

/** NFKC plus every Unicode decimal digit (Arabic-Indic, fullwidth, ...) mapped to ASCII, so patterns cannot be dodged. */
export function normaliseForCheck(text: string): string {
  const nfkc = text.normalize("NFKC");
  const cps = Array.from(nfkc);
  const ND = new RegExp("^\\p{Nd}$", "u"); // built from a string: the repo tsconfig targets pre-ES6
  const isNd = (c: string) => ND.test(c);
  return cps.map((c, i) => {
    if (!isNd(c)) return c;
    let start = i;
    while (start > 0 && isNd(cps[start - 1])) start -= 1;
    return String(((c.codePointAt(0)! - cps[start].codePointAt(0)!) % 10 + 10) % 10);
  }).join("");
}

/** Returns a reason when the text must not leave the server, else null. Fail-safe: when in doubt, refuse. */
export function sensitiveReason(raw: string): string | null {
  const text = normaliseForCheck(raw);
  if (EMAIL.test(text) || EMAIL_WORDS.test(text)) return "email address";
  if (BOOKING.test(text)) return "booking reference";
  if (URL_LIKE.test(text)) return "link";
  if (MONEY.test(text)) return "price, cost, rate or margin";
  // A phone-like run needs at least 7 digits; plain year ranges such as "2019-2026" are fine.
  for (const m of text.match(PHONE) ?? []) {
    if (/^\d{4}\s*[-–]\s*\d{4}$/.test(m.trim())) continue;
    if (m.replace(/\D/g, "").length >= 7) return "phone number";
  }
  return null;
}
