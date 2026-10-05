/**
 * W5e landing section: renders the approved "About Nare" copy from
 * lib/portal-content.ts — never hardcode marketing strings here.
 */
import { ABOUT_NARE } from "@/lib/portal-content";

export function AboutNareSection() {
  return (
    <section
      id="about"
      aria-labelledby="about-heading"
      className="bg-background"
    >
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-24">
        <h2
          id="about-heading"
          className="text-center text-3xl font-semibold tracking-tight text-foreground"
        >
          {ABOUT_NARE.title}
        </h2>
        <span
          aria-hidden="true"
          className="mx-auto mt-4 block h-1 w-12 rounded-full bg-warm"
        />
        <p className="mx-auto mt-8 max-w-2xl text-center text-lg leading-relaxed text-muted-foreground">
          {ABOUT_NARE.body}
        </p>
      </div>
    </section>
  );
}
