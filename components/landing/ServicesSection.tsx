/**
 * W5e landing section: renders the approved B2B services and DMC strengths
 * copy from lib/portal-content.ts — never hardcode marketing strings here.
 */
import {
  B2B_SERVICES,
  DMC_STRENGTHS,
  LANDING_SECTION_TITLES,
} from "@/lib/portal-content";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

export function ServicesSection() {
  return (
    <section
      id="services"
      aria-labelledby="services-heading"
      className="bg-background"
    >
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-24">
        <h2
          id="services-heading"
          className="text-center text-3xl font-semibold tracking-tight text-foreground"
        >
          {LANDING_SECTION_TITLES.services.title}
        </h2>
        <span
          aria-hidden="true"
          className="mx-auto mt-4 block h-1 w-12 rounded-full bg-warm"
        />
        <p className="mx-auto mt-4 max-w-2xl text-center text-lg leading-relaxed text-muted-foreground">
          {LANDING_SECTION_TITLES.services.subtitle}
        </p>
        <ul className="mt-12 grid gap-6 sm:grid-cols-2">
          {B2B_SERVICES.map((item) => (
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
        <section aria-labelledby="dmc-heading" className="mt-16 sm:mt-20">
          <h3
            id="dmc-heading"
            className="text-center text-2xl font-semibold tracking-tight text-foreground"
          >
            {LANDING_SECTION_TITLES.dmc.title}
          </h3>
          <span
            aria-hidden="true"
            className="mx-auto mt-4 block h-1 w-12 rounded-full bg-warm"
          />
          <ul className="mt-8 grid gap-6 sm:grid-cols-2">
            {DMC_STRENGTHS.map((item) => (
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
        </section>
      </div>
    </section>
  );
}
