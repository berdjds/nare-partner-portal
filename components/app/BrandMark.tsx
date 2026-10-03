"use client";

import Link from "next/link";

/**
 * Portal brand mark (W4). Default: mark + two-line label for the sidebar
 * header; compact: mark + one-line label for the mobile top bar.
 */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/nare-icon.webp" alt="" width={32} height={32} className="h-8 w-8 rounded-lg object-contain" />
      {compact ? (
        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">Nare Travel and Tours</span>
      ) : (
        <span className="leading-tight">
          <span className="block text-sm font-semibold tracking-tight text-sidebar-foreground">Nare Travel and Tours</span>
          <span className="block text-xs text-sidebar-foreground/60">Portal</span>
        </span>
      )}
    </Link>
  );
}
