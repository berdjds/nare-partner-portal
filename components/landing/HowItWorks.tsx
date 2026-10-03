import { HOW_IT_WORKS_STEPS } from "@/lib/portal-content";

export function HowItWorks() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-4xl px-6 py-20 sm:py-24">
        <h2 className="text-center text-3xl font-semibold tracking-tight text-foreground">
          How it works
        </h2>
        <ol className="mt-12 space-y-10">
          {HOW_IT_WORKS_STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-6">
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-base font-semibold text-primary-foreground"
              >
                {index + 1}
              </span>
              <div>
                <h3 className="text-xl font-semibold text-foreground">
                  {step.title}
                </h3>
                <p className="mt-2 text-base leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
