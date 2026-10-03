/**
 * Single home of the default brand color used on generated travel PDF
 * documents when no brand color is configured in settings. Shared by the PDF
 * renderer (lib/travel/pdf/templates.ts) and the settings UI
 * (components/travel/SettingsPanel.tsx) so the settings form can pre-fill and
 * describe the default without duplicating the literal — and without pulling
 * the PDF renderer into the client bundle.
 */
export const DEFAULT_BRAND_COLOR = "#16305b";
