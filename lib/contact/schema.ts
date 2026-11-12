/**
 * Company/contact data shape and validation (B2B cycle 1, Phase 4). No secret ever belongs
 * here: maps use a plain Google Maps link, a Place ID or coordinates, all public by nature;
 * the keyless embed is built from coordinates, so no Maps API key exists to leak.
 */
import { z } from "zod";

const PHONE = /^\+?[0-9][0-9\s().-]{6,20}[0-9]$/;
const phone = z.string().trim().regex(PHONE, "enter a valid phone number");
const MAP_HOSTS = ["www.google.com", "google.com", "maps.google.com", "maps.app.goo.gl"];

const mapUrl = z.string().trim().max(500).refine((u) => {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" || !MAP_HOSTS.includes(x.hostname) || x.username || x.password) return false;
    // google.com hosts only for /maps paths (not google.com/url?q= redirects); the share host has short codes
    return x.hostname === "maps.app.goo.gl" ? x.pathname.length > 1 : x.hostname === "maps.google.com" ? true : x.pathname.startsWith("/maps");
  } catch { return false; }
}, "use a Google Maps link (https)");

/** Social profiles: https links on each platform's own domain, so a typo or a lookalike host cannot be published. */
export const SOCIAL_PLATFORMS = ["facebook", "instagram", "linkedin", "tiktok", "youtube", "twitter", "tripadvisor"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
const SOCIAL_HOSTS: Record<SocialPlatform, string[]> = {
  facebook: ["facebook.com", "fb.com"], instagram: ["instagram.com"], linkedin: ["linkedin.com"], tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be"], twitter: ["twitter.com", "x.com"], tripadvisor: ["tripadvisor.com"],
};
const socialUrl = (p: SocialPlatform) => z.string().trim().max(300).refine((u) => {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" || x.username || x.password) return false;
    const h = x.hostname.replace(/^www\./, "");
    return SOCIAL_HOSTS[p].some((d) => h === d || h.endsWith(`.${d}`));
  } catch { return false; }
}, `use an https link on ${SOCIAL_HOSTS[p][0]}`);
export const socialSchema = z.object(Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, socialUrl(p).optional()])) as unknown as Record<SocialPlatform, z.ZodOptional<z.ZodEffects<z.ZodString>>>).strict();

export const mapSchema = z.object({
  url: mapUrl.optional(),
  placeId: z.string().trim().regex(/^[A-Za-z0-9_-]{10,200}$/, "invalid Place ID").optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
}).strict().refine((m) => (m.lat === undefined) === (m.lng === undefined), { message: "give both latitude and longitude" });

export const visibilitySchema = z.object({
  foundedYear: z.boolean(), generalEmail: z.boolean(), b2bEmail: z.boolean(), phones: z.boolean(),
  whatsapp: z.boolean(), address: z.boolean(), hours: z.boolean(), map: z.boolean(),
  social: z.boolean().optional(), // absent in profiles saved before social links existed: treated as shown when links are set
}).strict();

export const contactDataSchema = z.object({
  foundedYear: z.number().int().min(1900).max(new Date().getFullYear()).optional(),
  generalEmail: z.string().trim().toLowerCase().email().max(200),
  b2bEmail: z.string().trim().toLowerCase().email().max(200),
  phones: z.array(z.object({ label: z.string().trim().max(60).optional(), number: phone }).strict()).max(6),
  whatsapp: z.string().trim().regex(/^\+?[0-9]{7,15}$/, "digits only, optional leading +").optional(),
  address: z.string().trim().max(300).optional(),
  hours: z.string().trim().max(300).optional(),
  map: mapSchema.optional(),
  social: socialSchema.optional(),
  visibility: visibilitySchema,
}).strict();

export type ContactData = z.infer<typeof contactDataSchema>;

/** A portal override sets only the fields it wants to change; everything else inherits. */
export const contactOverrideSchema = contactDataSchema.partial({ generalEmail: true, b2bEmail: true, phones: true, visibility: true }).extend({ visibility: visibilitySchema.partial().optional() }).strict();
export type ContactOverride = z.infer<typeof contactOverrideSchema>;

/** Approved business data (owner brief): used until something is published, and as the safe fallback. */
export const DEFAULT_CONTACT: ContactData = {
  foundedYear: 2019,
  generalEmail: "info@nare.am",
  b2bEmail: "reservation@nare.am",
  phones: [{ number: "+374 91 005046" }, { number: "+374 10 545046" }],
  address: "91 Teryan St, Tparan Business Center, Yerevan, Armenia",
  // Nare's own profiles, as configured on staging.nare.am (data_backup/socialLinks.json); editable in Admin > Company and contact.
  social: {
    facebook: "https://www.facebook.com/Nare.Travel.and.Tours/",
    instagram: "https://www.instagram.com/nare_travel/",
    linkedin: "https://www.linkedin.com/company/105172290/",
    tiktok: "https://www.tiktok.com/@nare_travel",
  },
  visibility: { foundedYear: true, generalEmail: true, b2bEmail: true, phones: true, whatsapp: false, address: true, hours: false, map: false, social: true },
};

type MapInput = { url?: string; placeId?: string; lat?: number; lng?: number };

/** Keyless embed: only coordinates can be embedded without an API key. */
export function mapEmbedUrl(m: MapInput | undefined): string | null {
  if (!m || m.lat === undefined || m.lng === undefined) return null;
  return `https://www.google.com/maps?q=${m.lat},${m.lng}&z=16&output=embed`;
}
/** A plain link anyone can open: the given URL, else the Place ID, else the coordinates. */
export function mapLinkUrl(m: MapInput | undefined): string | null {
  if (!m) return null;
  if (m.url) return m.url;
  if (m.placeId) return `https://www.google.com/maps/place/?q=place_id:${m.placeId}`;
  if (m.lat !== undefined && m.lng !== undefined) return `https://www.google.com/maps?q=${m.lat},${m.lng}`;
  return null;
}
