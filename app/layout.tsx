import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { LocaleProvider } from "@/lib/i18n/react";
import { PublicContactProvider } from "@/lib/contact/react";
import { getRequestLocale } from "@/lib/i18n/server";
import { dirOf } from "@/lib/i18n/locales";
import { BRAND_THEME_COLOR } from "@/lib/brand";
import { getPublicContact } from "@/lib/contact/service";

// Fonts are local only (Geist ships in the npm package; the serif display and Armenian stacks are system fonts
// declared in globals.css), so a build or a page view never contacts a font service.

export const metadata: Metadata = {
  title: "Nare Travel and Tours — Portal",
  // Same icon asset as staging.nare.am (public/brand/nare-icon.webp); PNG sizes are derived from it
  // by scripts/gen-brand-icons.mjs, and app/favicon.ico covers the default /favicon.ico request.
  icons: {
    icon: [
      { url: "/brand/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/nare-icon.webp", type: "image/webp" },
    ],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  description:
    "B2B partner portal of Nare Travel and Tours.",
};

export const viewport: Viewport = {
  themeColor: BRAND_THEME_COLOR, // pomegranate red (--brand)
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Language and direction come from the request (cookie, then Accept-Language, else English);
  // the public contact comes from the published admin configuration with safe defaults.
  const locale = await getRequestLocale();
  const contact = await getPublicContact("portal");
  return (
    <html lang={locale} dir={dirOf(locale)} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans">
        <LocaleProvider locale={locale}>
          <PublicContactProvider contact={contact}>
            <ToastProvider>{children}</ToastProvider>
          </PublicContactProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
