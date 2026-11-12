"use client";

import { primaryEmail, usePublicContact } from "@/lib/contact/react";

/** The "write to us" address from the published contact configuration; renders nothing if none is public. */
export function ContactEmailLink({ className = "text-primary underline underline-offset-4" }: { className?: string }) {
  const email = primaryEmail(usePublicContact());
  return email ? <a href={`mailto:${email}`} className={className}>{email}</a> : null;
}
