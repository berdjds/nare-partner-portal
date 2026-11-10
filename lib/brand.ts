/**
 * Platform APIs (browser theme colour, web manifest) cannot read CSS variables, so the one hex value
 * lives here. It is --primary (203 89% 35%) from app/globals.css; tests/ui/brand-icons.test.ts
 * checks they still agree.
 */
export const BRAND_THEME_COLOR = "#0a6ca9";
/** --background (0 0% 96%). */
export const BRAND_BACKGROUND_COLOR = "#f5f5f5";
