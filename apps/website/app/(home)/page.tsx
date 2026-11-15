import Link from "next/link";
import { Hero } from "@/components/home/hero";

const features = [
  {
    title: "Declarative by default",
    body: "Validate and render RuntimePlan JSON with state transitions and delegated events.",
    href: "/docs/runtime-plan-ir",
  },
  {
    title: "Reviewed JSX when needed",
    body: "Run React-compatible JSX and browser ESM packages through an explicit trusted lane.",
    href: "/docs/security",
  },
  {
    title: "Bring your own producer",
    body: "Use authored code, your backend, or any model pipeline. The renderer does not require an LLM.",
    href: "/docs/browser-integration",
  },
];

export default function HomePage() {
  return (
    <>
      <Hero />

      <section className="home-container grid gap-4 pb-24 pt-8 md:grid-cols-3">
        {features.map((feature) => (
          <Link
            className="group rounded-2xl border bg-fd-card/80 p-6 shadow-sm backdrop-blur transition hover:-translate-y-0.5 hover:border-[var(--renderify-accent)]/40 hover:shadow-md"
            href={feature.href}
            key={feature.title}
          >
            <h2 className="text-lg font-semibold tracking-tight">
              {feature.title}
            </h2>
            <p className="mt-3 leading-7 text-fd-muted-foreground">
              {feature.body}
            </p>
            <span className="mt-5 inline-flex text-sm font-semibold text-[var(--brand-text)]">
              Read the guide{" "}
              <span className="ml-1 transition group-hover:translate-x-1">
                →
              </span>
            </span>
          </Link>
        ))}
      </section>
    </>
  );
}
