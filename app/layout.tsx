import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Noto_Sans_Armenian } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { LocaleProvider } from "@/lib/i18n/react";
import { PublicContactProvider } from "@/lib/contact/react";
import { getRequestLocale } from "@/lib/i18n/server";
import { dirOf } from "@/lib/i18n/locales";
import { getPublicContact } from "@/lib/contact/service";

// Geist has no Armenian glyphs. Noto Sans Armenian is self-hosted by next/font at build time (the
// same family the Nare site uses) and, being a unicode-range subset, is downloaded only by pages
// that actually show Armenian text. Arabic (later) will add its own family the same way.
const notoArmenian = Noto_Sans_Armenian({ subsets: ["armenian"], display: "swap", variable: "--font-armenian", preload: false });

export const metadata: Metadata = {
  title: "Nare Travel and Tours — Portal",
  description:
    "One Nare Travel and Tours portal: travel requests, quotes, catalog, and the WhatsApp inbox in a single shared shell.",
};

export const viewport: Viewport = {
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
    <html lang={locale} dir={dirOf(locale)} className={`${GeistSans.variable} ${GeistMono.variable} ${notoArmenian.variable}`}>
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
