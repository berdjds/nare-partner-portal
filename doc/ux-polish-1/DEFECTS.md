# UX SP-1 defect inventory

Baseline: `ac4e78d`. Each defect below is identified by its approved BRD §1.3 FR ID; the defect statement remains in that BRD under the same ID. Before screenshots must come from a local production build of the baseline. After slots are intentionally empty until the branch evidence is captured.

Screenshot paths are relative to `doc/ux-polish-1/`.

## BRD §1.3 defects

| FR ID | Before screenshot | After screenshot |
| --- | --- | --- |
| FR-UX-001 | `evidence/screenshots/fr-ux-001-before.png` | |
| FR-UX-002 | `evidence/screenshots/fr-ux-002-before.png` | |
| FR-UX-003 | `evidence/screenshots/fr-ux-003-before.png` | |
| FR-UX-004 | `evidence/screenshots/fr-ux-004-before.png` | |
| FR-UX-005 | `evidence/screenshots/fr-ux-005-before.png` | |
| FR-UX-006 | `evidence/screenshots/fr-ux-006-before.png` | |
| FR-UX-007 | `evidence/screenshots/fr-ux-007-before.png` | |
| FR-UX-008 | `evidence/screenshots/fr-ux-008-before.png` | |
| FR-UX-009 | `evidence/screenshots/fr-ux-009-before.png` | |
| FR-UX-010 | `evidence/screenshots/fr-ux-010-before.png` | |
| FR-UX-011 | `evidence/screenshots/fr-ux-011-before.png` | |

## Heading inventory

This is the current h1/h2/h3 outline for each public route, including headings mounted in hidden wizard stages and headings rendered only in conditional states. English text is shown; source line numbers refer to the baseline. The shared public header and footer contribute no h1/h2/h3.

### `/`

| Level | Heading | Source |
| --- | --- | --- |
| h1 | Your partner portal with Nare Travel and Tours | `components/landing/Hero.tsx:34` |
| h2 | What partners get (`benefits-heading`; eyebrow-styled h2) | `components/landing/Benefits.tsx:13` |
| h2 | Our B2B services (`services-heading`) | `components/landing/ServicesSection.tsx:20` |
| h2 | How it works (`how-heading`) | `components/landing/HowItWorks.tsx:19` |
| h2 | About Nare (`about-heading`) | `components/landing/AboutNare.tsx:24` |
| h2 | Ready to send your first request? (`contact-heading`) | `components/landing/ContactBlock.tsx:17` |

There are no h3 headings. Service and step titles are paragraphs, not headings.

PO decision (recommended): the landing hero h1 retains the landing-hero exception rather than taking the general page-heading treatment.

### `/partners/apply`

| Level | Heading | Source and state |
| --- | --- | --- |
| h1 | Apply to become a Nare partner | `app/partners/apply/page.tsx:52`; always rendered |
| h2 | Company (`stage-company-heading`) | `components/partners/ApplyWizard.tsx:819-826`; stage 0 |
| h2 | Trade licence (`stage-licence-heading`) | `components/partners/ApplyWizard.tsx:819-826`; stage 1 |
| h2 | Contacts (`stage-contacts-heading`) | `components/partners/ApplyWizard.tsx:819-826`; stage 2 |
| h2 | Review (`stage-review-heading`) | `components/partners/ApplyWizard.tsx:819-826`; stage 3 |
| h3 | Company | `components/partners/ApplyWizard.tsx:684-687`; review summary |
| h3 | Trade licence | `components/partners/ApplyWizard.tsx:684-687`; review summary |
| h3 | Contacts | `components/partners/ApplyWizard.tsx:684-687`; review summary |
| h2 | Application received | `components/partners/ApplyForm.tsx:75-80`; replaces the wizard after successful submission |

All four stage h2s and the three review h3s remain mounted; inactive stages are hidden. If the form token cannot be issued, only the page h1 and a non-heading availability alert are rendered. Consent is a `legend`, not a heading.

### `/login`

| Level | Heading | Source |
| --- | --- | --- |
| h1 | Welcome back to the partner portal | `app/login/page.tsx:83-85` |
| h3 | Sign in to the partner portal | `app/login/page.tsx:99`; `CardTitle` renders h3 via `components/ui/card.tsx:25-28` |

There is no h2. The outer `Suspense` fallback can temporarily render neither heading.

### `/forgot-password`

| Level | Heading | Source and state |
| --- | --- | --- |
| h3 | Forgot your password? | `components/auth/ForgotPasswordForm.tsx:79`; initial/form state |
| h3 | Check your email | `components/auth/ForgotPasswordForm.tsx:56-61`; success state |

These states are mutually exclusive. There is no h1 or h2. Both titles use `CardTitle`, which renders h3.

### `/reset-password`

| Level | Heading | Source and state |
| --- | --- | --- |
| h3 | Choose a new password | `components/auth/ResetPasswordForm.tsx:111`; normal form, and `:78` for the missing-token view |
| h3 | Password changed | `components/auth/ResetPasswordForm.tsx:92-97`; success state |

The success heading replaces the form after a successful confirmation. There is no h1 or h2. Both titles use `CardTitle`, which renders h3.

### `/terms`

| Level | Heading | Source |
| --- | --- | --- |
| h1 | Terms of Use | `components/public/LegalPage.tsx:34-36`; `lib/legal-content.ts:34` |
| h2 | On this page | `components/public/LegalPage.tsx:45` |
| h2 | 1. Who may apply | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:40` |
| h2 | 2. Applications and approval | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:46` |
| h2 | 3. Information and documents you provide | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:53` |
| h2 | 4. Use of the portal | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:61` |
| h2 | 5. Communication | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:69` |
| h2 | 6. Requests and quotations | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:75` |
| h2 | 7. Intellectual property | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:81` |
| h2 | 8. Limitation of liability | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:87` |
| h2 | 9. Suspension and ending | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:93` |
| h2 | 10. Changes to these Terms | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:99` |
| h2 | 11. Governing law | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:105` |
| h2 | Contact us (`legal-contact-heading`) | `components/public/LegalPage.tsx:92-98` |

There are no h3 headings.

### `/privacy`

| Level | Heading | Source |
| --- | --- | --- |
| h1 | Privacy Notice | `components/public/LegalPage.tsx:34-36`; `lib/legal-content.ts:112` |
| h2 | On this page | `components/public/LegalPage.tsx:45` |
| h2 | 1. What we collect | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:118` |
| h2 | 2. Why we use it | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:128` |
| h2 | 3. Consent | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:137` |
| h2 | 4. Who can see it | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:143` |
| h2 | 5. How long we keep it | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:151` |
| h2 | 6. How we protect it | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:158` |
| h2 | 7. Your rights | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:164` |
| h2 | 8. Changes to this notice | `components/public/LegalPage.tsx:69-76`; `lib/legal-content.ts:170` |
| h2 | Contact us (`legal-contact-heading`) | `components/public/LegalPage.tsx:92-98` |

There are no h3 headings.

## Legal heading decisions

These decisions apply to both `/terms` and `/privacy` because both routes use `LegalPage`.

PO decision (recommended): for **On this page** (`components/public/LegalPage.tsx:45`), replace the non-section h2 with a non-h2 labelled element and reference it from the navigation landmark with `aria-labelledby`.

PO decision (recommended): the numbered legal-body h2s retain the legal-body h2 exception.

PO decision (recommended): **Contact us** (`components/public/LegalPage.tsx:96`, `legal-contact-heading`) is part of the legal body and takes the legal-body exception class.

PO approval: ____ (name, date)
