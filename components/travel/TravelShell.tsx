"use client";

import { PageHeader, type BreadcrumbItem } from "@/components/app/PageHeader";

/**
 * Compatibility re-exports: PageHeader and BreadcrumbItem live in
 * components/app/PageHeader.tsx (the W4 shared shell) since the travel module
 * moved onto AppShell. Existing travel imports from "./TravelShell" keep
 * working unchanged.
 */
export { PageHeader };
export type { BreadcrumbItem };

interface TravelShellProps {
  title: string;
  subtitle?: string;
  role: string;
  breadcrumb?: BreadcrumbItem[];
  /** @deprecated Active nav state is derived from the pathname in the app Sidebar. */
  current?: string;
  children: React.ReactNode;
}

/**
 * Compatibility wrapper: the chrome (sidebar/nav) lives in
 * app/travel/layout.tsx via AppShell, so this renders only the page header +
 * content. Pages migrate to PageHeader directly as they are restyled;
 * role/current are accepted so untouched callers keep compiling.
 */
export default function TravelShell({ title, subtitle, breadcrumb, children }: TravelShellProps) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} breadcrumb={breadcrumb} />
      {children}
    </>
  );
}
