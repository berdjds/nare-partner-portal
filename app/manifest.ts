import type { MetadataRoute } from "next";
import { BRAND_BACKGROUND_COLOR, BRAND_THEME_COLOR } from "@/lib/brand";

// Lets partners add the portal to a phone home screen with the Nare icon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nare Travel and Tours — Partner Portal",
    short_name: "Nare Portal",
    description: "B2B partner portal of Nare Travel and Tours.",
    start_url: "/",
    display: "standalone",
    background_color: BRAND_BACKGROUND_COLOR,
    theme_color: BRAND_THEME_COLOR,
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
