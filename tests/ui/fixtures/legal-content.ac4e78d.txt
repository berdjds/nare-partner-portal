/**
 * Legal text for the public pages of the Nare Travel and Tours B2B partner
 * portal: the Terms of Use and the Privacy Notice for partner enrollment.
 *
 * Drafted from the structure of the Nare Travel and Tours website terms and
 * privacy pages (same company, governed by the laws of Armenia) and adapted to
 * the partner portal: business applicants, KYC documents, email and WhatsApp
 * group communication. IMPORTANT: this is a working draft for the owner. It
 * must be reviewed by Nare's legal advisor before the portal is promoted to
 * the public; the wording is kept conservative and promises nothing that the
 * portal does not do today.
 *
 * Pure data (no React, no Next imports) so pages and tests can import it.
 * Contact details are NOT repeated here: pages render the shared CONTACT and
 * OFFICE_ADDRESS from lib/portal-content.ts in a "Contact us" block.
 */

export const LEGAL_LAST_UPDATED = "4 October 2026";

export interface LegalSection {
  readonly title: string;
  readonly paragraphs?: readonly string[];
  readonly items?: readonly string[];
}

export interface LegalDocument {
  readonly title: string;
  readonly subtitle: string;
  readonly intro: string;
  readonly sections: readonly LegalSection[];
}

export const TERMS_OF_USE: LegalDocument = {
  title: "Terms of Use",
  subtitle: "For travel businesses applying to or using the Nare partner portal",
  intro:
    "These Terms of Use apply to the Nare Travel and Tours partner portal (the portal). By applying to become a partner or by using the portal you agree to them. Please read them together with our Privacy Notice.",
  sections: [
    {
      title: "Who may apply",
      paragraphs: [
        "The portal is for businesses in the travel trade. You confirm that you apply on behalf of a registered business and that you are authorised to do so.",
      ],
    },
    {
      title: "Applications and approval",
      paragraphs: [
        "Every application is reviewed by the Nare team. Nare Travel and Tours may approve an application, reject it, or ask for more information, at its discretion and without having to give a reason beyond what it chooses to share.",
        "Approval of an application does not by itself create any obligation to supply services; commercial terms such as prices, payment and cancellation are set out in the written agreement or confirmation between Nare Travel and Tours and the partner.",
      ],
    },
    {
      title: "Information and documents you provide",
      items: [
        "The information and documents you submit, including the trade licence, must be true, complete and current.",
        "You will tell us promptly about changes, for example a renewed or expired trade licence or a change of contact person.",
        "You have the right to share the documents and the personal data of the contact persons you name with us for the purposes described in the Privacy Notice.",
      ],
    },
    {
      title: "Use of the portal",
      items: [
        "Access to the portal is granted by Nare Travel and Tours to approved partners and may be withdrawn at any time.",
        "Keep your sign-in details confidential and tell us at once if you suspect that they have been used by someone else.",
        "Do not misuse the portal: no unlawful use, no attempts to gain access to data that is not yours, no interference with the service, no automated submissions.",
      ],
    },
    {
      title: "Communication",
      paragraphs: [
        "If you consent when you apply, Nare Travel and Tours communicates with your company by email and through a WhatsApp group that includes your contact persons and Nare staff. You can ask us at any time to stop using a channel or to change the contact persons.",
      ],
    },
    {
      title: "Requests and quotations",
      paragraphs: [
        "A request sent through the portal, and a quotation prepared for it, is not a confirmed booking. A booking is confirmed only when Nare Travel and Tours confirms it in writing.",
      ],
    },
    {
      title: "Intellectual property",
      paragraphs: [
        "The portal, its design, text, logos and software belong to Nare Travel and Tours or its licensors and are protected by copyright and other intellectual property laws. You may use them only to work with Nare Travel and Tours through the portal.",
      ],
    },
    {
      title: "Limitation of liability",
      paragraphs: [
        "To the extent permitted by law, Nare Travel and Tours is not liable for indirect or consequential loss arising from the use of, or the unavailability of, the portal. Nothing in these Terms limits liability that cannot be limited by law.",
      ],
    },
    {
      title: "Suspension and ending",
      paragraphs: [
        "Nare Travel and Tours may suspend or end a partner's access if these Terms are broken, if the information provided is found to be inaccurate, or if the trade licence is no longer valid. A partner may ask to end its access at any time.",
      ],
    },
    {
      title: "Changes to these Terms",
      paragraphs: [
        "We may update these Terms. The current version is always on this page with its date. Continued use of the portal after a change means you accept the updated Terms.",
      ],
    },
    {
      title: "Governing law",
      paragraphs: ["These Terms are governed by the laws of Armenia, without regard to its conflict of law provisions."],
    },
  ],
};

export const PRIVACY_NOTICE: LegalDocument = {
  title: "Privacy Notice",
  subtitle: "How we handle the information you give us when you apply to be a partner",
  intro:
    "Nare Travel and Tours is responsible for the personal and business information described in this notice. We explain what we collect when you apply to become a partner through the portal, why we collect it, who can see it and how long we keep it.",
  sections: [
    {
      title: "What we collect",
      items: [
        "Company details: registered name, trading name, country, city, registered address and website.",
        "Trade licence details: licence number, issuing authority, expiry date and the licence document you upload.",
        "Contact details of the people you name: name, role, email address and WhatsApp-capable phone number.",
        "Optionally, an identity document of the authorised signatory and one additional document.",
        "Technical information needed to protect the form: a one-way hashed form of your network address, which cannot be turned back into the address, and the time of submission.",
      ],
    },
    {
      title: "Why we use it",
      items: [
        "To review your application and to know our business partners (KYC review).",
        "To contact you by email about the application and, if you consented, to add your contact persons to a WhatsApp group used for communication about travel requests.",
        "To keep the portal secure and to prevent abuse and fraud.",
        "To meet legal and regulatory obligations.",
      ],
    },
    {
      title: "Consent",
      paragraphs: [
        "Your application asks for two consents: to process the information and documents for the KYC review, and to be contacted by email and added to a WhatsApp group. We do not create a group or add a contact without that consent and an approved application. You can withdraw a consent at any time by contacting us.",
      ],
    },
    {
      title: "Who can see it",
      items: [
        "Only authorised Nare Travel and Tours staff can open the documents you upload. Every opening, download, decision and deletion is recorded in an audit log.",
        "We use service providers to run the portal, deliver email and, if you consented, to operate the WhatsApp group; they process data only on our behalf. WhatsApp is provided by a third party under its own terms.",
        "We disclose information to authorities where the law requires it. We do not sell your information.",
      ],
    },
    {
      title: "How long we keep it",
      items: [
        "For an approved partner, documents are kept while the partnership is active.",
        "For an application that is not approved, the documents are deleted within 90 days of the decision, or earlier if you ask us to delete them.",
      ],
    },
    {
      title: "How we protect it",
      paragraphs: [
        "Documents are stored privately, not on any publicly reachable address, access is restricted to authorised staff, and the portal limits and monitors submissions to prevent abuse. No system is perfectly secure, so we also ask you to share only what is requested.",
      ],
    },
    {
      title: "Your rights",
      paragraphs: [
        "Depending on where you are, you may have the right to access, correct or delete your information, to object to or restrict its use, and to withdraw your consent. To use these rights, contact us using the details below.",
      ],
    },
    {
      title: "Changes to this notice",
      paragraphs: ["We may update this notice. The current version is always on this page with its date."],
    },
  ],
};
