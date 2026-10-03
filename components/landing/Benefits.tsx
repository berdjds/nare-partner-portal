import { BENEFITS } from "@/lib/portal-content";

export function Benefits() {
  return (
    <section className="bg-card">
      <div className="mx-auto max-w-4xl px-6 py-20 sm:py-24">
        <h2 className="text-center text-3xl font-semibold tracking-tight text-card-foreground">
          Why the partner portal
        </h2>
        <ul className="mx-auto mt-12 max-w-2xl space-y-5">
          {BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-start gap-3">
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="mt-1 h-5 w-5 shrink-0 text-primary"
              >
                <path d="M4 10.5l4 4 8-9" />
              </svg>
              <span className="text-base leading-relaxed text-card-foreground">
                {benefit}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
