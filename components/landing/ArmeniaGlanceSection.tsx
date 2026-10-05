/**
 * W5e landing section: renders the approved "Armenia at a glance" copy from
 * lib/portal-content.ts — never hardcode marketing strings here.
 */
import { ARMENIA_GLANCE, LANDING_SECTION_TITLES } from "@/lib/portal-content";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

export function ArmeniaGlanceSection() {
  return (
    <section
      id="armenia"
      aria-labelledby="armenia-heading"
      className="bg-muted"
    >
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-24">
        <h2
          id="armenia-heading"
          className="text-center text-3xl font-semibold tracking-tight text-foreground"
        >
          {LANDING_SECTION_TITLES.armenia.title}
        </h2>
        <span
          aria-hidden="true"
          className="mx-auto mt-4 block h-1 w-12 rounded-full bg-warm"
        />
        <p className="mx-auto mt-4 max-w-2xl text-center text-lg leading-relaxed text-muted-foreground">
          {ARMENIA_GLANCE.intro}
        </p>
        <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {ARMENIA_GLANCE.items.map((item) => (
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
