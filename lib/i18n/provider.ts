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

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+|\b)\d[\d\s().-]{7,}\d/g;
const BOOKING = /\b[A-Z]{2,8}-\d{4}-\d{2}-\d{2}-\d{4}\b/;
const URL_LIKE = /https?:\/\//i;

/** Returns a reason when the text must not leave the server, else null. */
export function sensitiveReason(text: string): string | null {
  if (EMAIL.test(text)) return "email address";
  // A phone-like run needs at least 9 digits, so ordinary year ranges such as "2019-2026" pass.
  for (const m of text.match(PHONE) ?? []) if (m.replace(/\D/g, "").length >= 9) return "phone number";
  if (BOOKING.test(text)) return "booking reference";
  if (URL_LIKE.test(text)) return "link";
  return null;
}
