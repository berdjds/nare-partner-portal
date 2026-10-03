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
}

export const PAGE_TITLES: PageTitles = {
  home: "Nare Travel and Tours — Partner Portal",
  login: "Sign in — Nare Travel and Tours Portal",
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
  email: "info@nare.am",
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
