/**
 * Typed content for the public landing page and sign-in page of the
 * Nare Travel and Tours B2B partner portal (phase W5a).
 *
 * Kept dependency-free and pure so both App Router pages and tests can import
 * it without pulling in React or Next. Wording is deliberately conservative:
 * no pricing, no speed/automation claims, and no self-registration wording —
 * portal access is granted by Nare staff to approved partners.
 */

export const PRODUCT_NAME = "Nare Travel and Tours";

export interface PageTitles {
  readonly home: string;
  readonly login: string;
  readonly partnerApply: string;
}

export const PAGE_TITLES: PageTitles = {
  home: "Nare Travel and Tours — Partner Portal",
  login: "Sign in — Nare Travel and Tours Portal",
  partnerApply: "Become a partner — Nare Travel and Tours Portal",
} as const;

export interface HeroContent {
  readonly headline: string;
  readonly subline: string;
  readonly ctaLabel: string;
}

export const HERO: HeroContent = {
  headline: "Your partner portal with Nare Travel and Tours",
  subline:
    "Send travel requests in one place and follow each one as the Nare team reviews and confirms it.",
  ctaLabel: "Sign in to the partner portal",
} as const;

export interface HowItWorksStep {
  readonly title: string;
  readonly body: string;
}

export const HOW_IT_WORKS_STEPS: readonly HowItWorksStep[] = [
  {
    title: "Send a request",
    body: "Share your client's travel details through the portal as one structured request.",
  },
  {
    title: "Nare validates it",
    body: "The Nare team reviews and validates every request before preparing the offer for your client.",
  },
  {
    title: "Follow the status",
    body: "Track each request with a clear status, from the moment you send it until it is confirmed.",
  },
] as const;

/**
 * Only claims Nare has approved belong here: one place to send requests,
 * validation by the Nare team, and a clear status to follow. Anything beyond
 * that (savings, turnaround times, self-service onboarding) is unverified.
 */
export const BENEFITS: readonly string[] = [
  "One place to send every travel request for your clients.",
  "Each request is reviewed and validated by the Nare team.",
  "A clear status on every request, so you always know where it stands.",
  "Access is granted by the Nare team to approved partners.",
] as const;

export interface LoginPanelContent {
  readonly headline: string;
  readonly bullets: readonly string[];
}

export const LOGIN_PANEL: LoginPanelContent = {
  headline: "Welcome back to the partner portal",
  bullets: [
    "Send and manage all your travel requests in one place.",
    "Every request is validated by the Nare team.",
    "Follow each request with a clear, visible status.",
  ],
} as const;

export interface ContactInfo {
  readonly email: string;
  readonly phones: readonly string[];
}

// Address and phone numbers taken from the public nare.am site —
// owner to confirm before launch.
export const CONTACT: ContactInfo = {
  email: "reservation@nare.am",
  phones: ["+374 10 545046", "+374 91 005046"],
} as const;

export interface MailtoSubjects {
  readonly contact: string;
  readonly partnerAccess: string;
}

export const MAILTO_SUBJECTS: MailtoSubjects = {
  contact: "Nare partner portal — question",
  partnerAccess: "Nare partner portal — access request",
} as const;

/**
 * Copy for the public partner application page /partners/apply (phase W5b).
 * The wording is deliberately plain and makes no promises about review
 * outcomes or dates: the Nare team reviews every application by hand and
 * answers by email.
 */
export interface PartnerApplyContent {
  /** Label of the entry links on the landing and sign-in pages. */
  readonly linkLabel: string;
  readonly headline: string;
  readonly intro: string;
  readonly sections: {
    readonly company: string;
    readonly licence: string;
    readonly contacts: string;
    readonly signatory: string;
    readonly consent: string;
  };
  readonly labels: {
    readonly companyLegalName: string;
    readonly tradingName: string;
    readonly country: string;
    readonly city: string;
    readonly address: string;
    readonly website: string;
    readonly notes: string;
    readonly licenceNumber: string;
    readonly licenceAuthority: string;
    readonly licenceExpiry: string;
    readonly licenceFile: string;
    readonly contactName: string;
    readonly contactRole: string;
    readonly contactEmail: string;
    readonly contactPhone: string;
    readonly secondContact: string;
    readonly secondContactName: string;
    readonly secondContactEmail: string;
    readonly secondContactPhone: string;
    readonly signatoryIdFile: string;
    readonly otherFile: string;
    readonly consentKyc: string;
    readonly consentChannels: string;
  };
  readonly contactPhoneHelper: string;
  readonly fileRules: string;
  readonly submitLabel: string;
  readonly submittingLabel: string;
  readonly successTitle: string;
  readonly successReferenceLabel: string;
  readonly successBody: string;
  /** Shown instead of the form when the signed form token cannot be issued. */
  readonly unavailable: string;
}

export const PARTNER_APPLY: PartnerApplyContent = {
  linkLabel: "Become a partner",
  headline: "Apply to become a Nare partner",
  intro:
    "Tell us about your company and upload your trade licence. The Nare team reviews every application and contacts you by email about the next steps.",
  sections: {
    company: "Company",
    licence: "Trade licence",
    contacts: "Contacts",
    signatory: "Signatory ID (optional)",
    consent: "Consent",
  },
  labels: {
    companyLegalName: "Registered company name",
    tradingName: "Trading name (optional)",
    country: "Country",
    city: "City",
    address: "Registered address",
    website: "Website (optional)",
    notes: "Anything else we should know (optional)",
    licenceNumber: "Trade licence number",
    licenceAuthority: "Issuing authority",
    licenceExpiry: "Licence expiry date",
    licenceFile: "Trade licence document",
    contactName: "Contact person",
    contactRole: "Role (optional)",
    contactEmail: "Email",
    contactPhone: "Phone (WhatsApp)",
    secondContact: "Second contact (optional)",
    secondContactName: "Name",
    secondContactEmail: "Email",
    secondContactPhone: "Phone (WhatsApp)",
    signatoryIdFile: "ID of the person signing (optional)",
    otherFile: "Additional document (optional)",
    consentKyc:
      "I agree that Nare Travel and Tours processes the information and documents I send to check this application (KYC review).",
    consentChannels:
      "I agree that Nare Travel and Tours contacts me by email and adds my contact number to a WhatsApp group used for communication about travel requests.",
  },
  contactPhoneHelper: "Include the country code. This number must be reachable on WhatsApp.",
  fileRules: "PDF, JPG or PNG, up to 10 MB per file.",
  submitLabel: "Submit application",
  submittingLabel: "Submitting…",
  successTitle: "Application received",
  successReferenceLabel: "Your application reference",
  successBody:
    "Thank you — your application has been received. Keep your reference; you will need it whenever you contact us about this application. The Nare team reviews every application and the documents by hand and will write to your email address with the outcome or with any questions.",
  unavailable:
    "The application form is not available right now. Please try again later or email us.",
} as const;

export interface ForgotAccessContent {
  readonly text: string;
  readonly mailto: string;
}

export const FORGOT_ACCESS: ForgotAccessContent = {
  text: "Forgot your password? Contact your Nare account manager",
  mailto: CONTACT.email,
} as const;

/**
 * The landing page stays out of search engines until the owner approves
 * indexing; robotsDirective() is the single place pages read that decision.
 */
export const INDEXABLE: boolean = false;

export function robotsDirective(): string {
  return INDEXABLE ? "index, follow" : "noindex, nofollow";
}
