/**
 * Typed content for the public landing page, sign-in page and self-service
 * password-reset pages of the Nare Travel and Tours B2B partner portal
 * (phase W5a; reset pages added in W6a).
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
  readonly forgotPassword: string;
  readonly resetPassword: string;
}

export const PAGE_TITLES: PageTitles = {
  home: "Nare Travel and Tours — Partner Portal",
  login: "Sign in — Nare Travel and Tours Portal",
  partnerApply: "Become a partner — Nare Travel and Tours Portal",
  forgotPassword: "Forgot your password — Nare Travel and Tours Portal",
  resetPassword: "Choose a new password — Nare Travel and Tours Portal",
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

/** Office address confirmed by the owner (2026-10-03). */
export const OFFICE_ADDRESS = "91 Teryan St, Tparan Business Center, Yerevan, Armenia";

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
    /** Fourth stage of the application wizard (W5f): read-only summary. */
    readonly review: string;
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
  /** Wizard chrome (W5f): stepper, navigation and review copy. */
  /** Template for the step position, e.g. "Step 2 of 4". */
  readonly stepLabel: string;
  /** Accessible name of the stepper navigation. */
  readonly progressLabel: string;
  readonly backLabel: string;
  readonly nextLabel: string;
  readonly editLabel: string;
  /** Empty option at the top of the country select. */
  readonly countryPlaceholder: string;
  /** Shown above the read-only summary on the review stage. */
  readonly reviewHelper: string;
  /** Placeholder for optional entries left empty, shown on the review stage. */
  readonly notProvided: string;
  /** Announced when a stage cannot be passed because fields are invalid. */
  readonly fixErrorsNotice: string;
  /** Validation message when the required trade licence file is missing. */
  readonly licenceFileRequired: string;
  /** Replaces the file input once a file is chosen (W5f wizard). */
  readonly replaceFileLabel: string;
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
    review: "Review",
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
  stepLabel: "Step {step} of {total}",
  progressLabel: "Application progress",
  backLabel: "Back",
  nextLabel: "Next",
  editLabel: "Edit",
  countryPlaceholder: "Select a country",
  reviewHelper:
    "Check every entry before you send the application. Use Edit to go back to a section and change it.",
  notProvided: "Not provided",
  fixErrorsNotice: "Some fields need your attention before you can continue.",
  licenceFileRequired: "Upload the trade licence document.",
  replaceFileLabel: "Replace",
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
  /** Link label shown under the sign-in form. */
  readonly label: string;
  /** Target of the link — the self-service reset request page (W6a). */
  readonly href: string;
}

export const FORGOT_ACCESS: ForgotAccessContent = {
  label: "Forgot your password?",
  href: "/forgot-password",
} as const;

/**
 * Copy for the public /forgot-password page (W6a) — step 1 of the
 * self-service password reset. The success text is deliberately generic:
 * it is shown for every submission, whether or not the email belongs to an
 * account, so the page cannot be used to probe which emails are registered.
 */
export interface ForgotPageContent {
  readonly headline: string;
  readonly intro: string;
  readonly emailLabel: string;
  readonly submitLabel: string;
  readonly submittingLabel: string;
  readonly successTitle: string;
  readonly successBody: string;
  readonly backToSignIn: string;
  /** Shown when the request itself fails (limit, server or network error). */
  readonly unavailable: string;
}

export const FORGOT_PAGE: ForgotPageContent = {
  headline: "Forgot your password?",
  intro:
    "Enter the email address on your portal account. If an account exists for it, we email you a link to choose a new password. The link works once and expires in 30 minutes.",
  emailLabel: "Email",
  submitLabel: "Send reset link",
  submittingLabel: "Sending…",
  successTitle: "Check your email",
  successBody:
    "If an account exists for that email address, we have sent a link to reset the password. The link works once and expires in 30 minutes.",
  backToSignIn: "Back to sign in",
  unavailable: "Something went wrong. Please try again later.",
} as const;

/**
 * Copy for the public /reset-password page (W6a) — step 2, reached from the
 * emailed link. The requirements line mirrors the shared policy in
 * lib/security/password-policy.ts in plain words.
 */
export interface ResetPageContent {
  readonly headline: string;
  readonly intro: string;
  readonly newLabel: string;
  readonly confirmLabel: string;
  /** Plain-wording summary of the shared password policy. */
  readonly requirements: string;
  readonly mismatchError: string;
  readonly showLabel: string;
  readonly hideLabel: string;
  readonly submitLabel: string;
  readonly submittingLabel: string;
  readonly successTitle: string;
  readonly successBody: string;
  readonly signInLabel: string;
  /** Missing, used or expired link — the same wording the endpoint returns. */
  readonly invalidLink: string;
  readonly requestNewLink: string;
  readonly unavailable: string;
}

export const RESET_PAGE: ResetPageContent = {
  headline: "Choose a new password",
  intro:
    "Choose a new password for your portal account. When it is saved, every other signed-in session ends and you sign in again with the new password.",
  newLabel: "New password",
  confirmLabel: "Repeat new password",
  requirements:
    "Use at least 12 characters. The password cannot be your email address or a very common password.",
  mismatchError: "The two passwords do not match.",
  showLabel: "Show password",
  hideLabel: "Hide password",
  submitLabel: "Change password",
  submittingLabel: "Changing…",
  successTitle: "Password changed",
  successBody: "Your password has been changed. You can now sign in with your new password.",
  signInLabel: "Sign in",
  invalidLink: "This reset link is invalid or has expired. Please request a new one.",
  requestNewLink: "Request a new reset link",
  unavailable: "Something went wrong. Please try again later.",
} as const;

/**
 * The landing page stays out of search engines until the owner approves
 * indexing; robotsDirective() is the single place pages read that decision.
 */
export const INDEXABLE: boolean = false;

export function robotsDirective(): string {
  return INDEXABLE ? "index, follow" : "noindex, nofollow";
}

/**
 * Approved Nare B2B landing copy (phase W5e). Every string below is wording
 * approved from the public nare.am site; no other claims (prices, speed,
 * awards, partner counts or any number beyond "2014" and "24/7") may be
 * added without approval.
 */
export interface TitledContentItem {
  readonly title: string;
  readonly body: string;
}

/** b2b.services — the four B2B service lines. */
export const B2B_SERVICES: readonly TitledContentItem[] = [
  {
    title: "DMC Services",
    body: "Comprehensive Destination Management Company services in Armenia",
  },
  {
    title: "MICE Solutions",
    body: "Complete MICE event planning and management",
  },
  {
    title: "Corporate Travel",
    body: "Efficient business travel management services",
  },
  {
    title: "Group Bookings",
    body: "Specialized services for large group travel",
  },
] as const;

/** home.features / about — why partners choose Nare. */
export const WHY_NARE: readonly TitledContentItem[] = [
  {
    title: "Experience since 2014",
    body: "Crafting unforgettable travel experiences since 2014",
  },
  {
    title: "Global network",
    body: "International partnerships and connections",
  },
  {
    title: "Local expertise",
    body: "In-depth knowledge of destinations and attractions",
  },
  {
    title: "Professional team",
    body: "Experienced multilingual staff",
  },
] as const;

/** b2b.dmc.features — Destination Management Company strengths. */
export const DMC_STRENGTHS: readonly TitledContentItem[] = [
  {
    title: "24/7 Support",
    body: "Round-the-clock assistance for your clients",
  },
  {
    title: "Secure Operations",
    body: "Licensed and insured services",
  },
  {
    title: "Professional Team",
    body: "Experienced multilingual staff",
  },
  {
    title: "Armenia and Georgia",
    body: "Your trusted Destination Management Company in Armenia and Georgia",
  },
] as const;

export interface AboutNareContent {
  readonly title: string;
  readonly body: string;
}

/** about.story — the company story. */
export const ABOUT_NARE: AboutNareContent = {
  title: "Our Story",
  body: "Founded in 2014, Nare Travel and Tours has grown from a small local agency to one of Armenia's leading travel companies. We began with a simple mission: to share Armenia's rich cultural heritage with the world while providing exceptional travel experiences. Today, we're proud to serve thousands of travelers each year, offering both local and international travel solutions with the same dedication to quality and personal attention that has been our hallmark since day one.",
} as const;

export interface ArmeniaGlanceContent {
  readonly intro: string;
  readonly items: readonly TitledContentItem[];
}

/** armeniaTours — Armenia at a glance. */
export const ARMENIA_GLANCE: ArmeniaGlanceContent = {
  intro: "Experience the rich history and stunning landscapes of our ancient land",
  items: [
    {
      title: "Cultural tours",
      body: "Deep dive into Armenian heritage and traditions",
    },
    {
      title: "Day trips",
      body: "Explore Armenia's highlights in one-day excursions",
    },
    {
      title: "Multi-day tours",
      body: "Comprehensive tours covering multiple destinations",
    },
  ],
} as const;

export interface LandingSectionTitles {
  readonly services: { readonly title: string; readonly subtitle: string };
  readonly whyNare: { readonly title: string };
  readonly dmc: { readonly title: string };
  readonly armenia: { readonly title: string };
}

/**
 * Accessible headings for the W5e landing sections; the story heading lives
 * in ABOUT_NARE.title.
 */
export const LANDING_SECTION_TITLES: LandingSectionTitles = {
  services: {
    title: "Our B2B Services",
    subtitle: "Comprehensive solutions for business travel and events",
  },
  whyNare: { title: "Why choose us" },
  dmc: { title: "DMC strengths" },
  armenia: { title: "Armenia at a glance" },
} as const;
