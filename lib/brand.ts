/**
 * Platform APIs (browser theme colour, web manifest) cannot read CSS variables, so the hex values live here.
 * BRAND_THEME_COLOR is --brand (358 68% 40%, the pomegranate red of the Nare logo); BRAND_BACKGROUND_COLOR is
 * --background (38 40% 97%, ivory). tests/ui/brand-icons.test.ts checks they still agree with app/globals.css.
 */
export const BRAND_THEME_COLOR = "#ab2125";
export const BRAND_BACKGROUND_COLOR = "#faf8f4";
