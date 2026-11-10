"use client";

import { createContext, useContext } from "react";
import type { PublicContact } from "@/lib/contact/service";
import { CONTACT, OFFICE_ADDRESS } from "@/lib/portal-content";

/** Without a provider (tests, previews) the static portal content is shown, exactly as before. */
const DEFAULT_PUBLIC_CONTACT: PublicContact = {
  foundedYear: 2019, // owner-confirmed; the published contact configuration may override it
  generalEmail: "info@nare.am",
  b2bEmail: CONTACT.email,
  phones: CONTACT.phones.map((number) => ({ number })),
  address: OFFICE_ADDRESS,
};

const Ctx = createContext<PublicContact>(DEFAULT_PUBLIC_CONTACT);

export function PublicContactProvider({ contact, children }: { contact: PublicContact; children: React.ReactNode }) {
  return <Ctx.Provider value={contact}>{children}</Ctx.Provider>;
}
export const usePublicContact = (): PublicContact => useContext(Ctx);

/** The address for "write to us" links: the B2B portal email, else the general one, else nothing. */
export const primaryEmail = (c: PublicContact): string | undefined => c.b2bEmail ?? c.generalEmail;

export const telHref = (n: string) => `tel:${n.replace(/[^+\d]/g, "")}`;
