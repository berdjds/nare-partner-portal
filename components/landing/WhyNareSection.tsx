/**
 * W5e landing section: renders the approved "Why Nare" copy from
 * lib/portal-content.ts — never hardcode marketing strings here.
 */
import { WHY_NARE, LANDING_SECTION_TITLES } from "@/lib/portal-content";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

export function WhyNareSection() {
  return (
    <section
      id="why-nare"
      aria-labelledby="why-nare-heading"
      className="bg-muted"
    >
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-24">
        <h2
          id="why-nare-heading"
          className="text-center text-3xl font-semibold tracking-tight text-foreground"
        >
          {LANDING_SECTION_TITLES.whyNare.title}
        </h2>
        <span
          aria-hidden="true"
          className="mx-auto mt-4 block h-1 w-12 rounded-full bg-warm"
        />
        <ul className="mt-12 grid gap-6 sm:grid-cols-2">
          {WHY_NARE.map((item) => (
            <li key={item.title}>
              <Card className="h-full">
                <CardHeader>
                  <p className="text-lg font-semibold text-foreground">
                    {item.title}
                  </p>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {item.body}
                  </p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
