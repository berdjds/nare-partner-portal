import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PAGE_TITLES } from "@/lib/portal-content";

export const metadata: Metadata = {
  title: PAGE_TITLES.login,
  // The sign-in page is always excluded from search engines, independently of
  // the landing page's INDEXABLE flag in lib/portal-content.ts.
  robots: "noindex, nofollow",
};

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
