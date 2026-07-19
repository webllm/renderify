import Link from "next/link";

const features = [
  {
    title: "Declarative by default",
    body: "Validate and render RuntimePlan JSON with state transitions and delegated events.",
  },
  {
    title: "Reviewed JSX when needed",
    body: "Run React-compatible JSX and browser ESM packages through an explicit trusted lane.",
  },
  {
    title: "Bring your own producer",
    body: "Use authored code, your backend, or any model pipeline. The renderer does not require an LLM.",
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 pb-20 pt-20 md:pt-28">
      <section className="max-w-4xl">
        <p className="mb-5 inline-flex rounded-full border bg-fd-card px-3 py-1 text-sm font-medium text-fd-muted-foreground shadow-sm">
          Runtime-first · Browser-native · LLM optional
        </p>
        <h1 className="max-w-4xl text-balance text-5xl font-bold tracking-[-0.055em] text-fd-foreground sm:text-6xl md:text-7xl">
          Render plans and JSX at the moment you need them.
        </h1>
        <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground md:text-xl">
          Renderify turns validated RuntimePlans or reviewed JSX/TSX modules
          into interactive browser UI—without adding an application build or
          deploy step to the render path.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link
            className="rounded-xl bg-[var(--renderify-accent)] px-5 py-3 font-semibold text-white shadow-lg shadow-violet-500/20 transition hover:bg-[var(--renderify-accent-strong)]"
            href="/playground"
          >
            Open Playground
          </Link>
          <Link
            className="rounded-xl border bg-fd-card px-5 py-3 font-semibold text-fd-foreground transition hover:bg-fd-accent"
            href="/docs"
          >
            Read the docs
          </Link>
        </div>
      </section>

      <section className="mt-20 grid gap-4 md:grid-cols-3">
        {features.map((feature) => (
          <article
            className="rounded-2xl border bg-fd-card/80 p-6 shadow-sm backdrop-blur"
            key={feature.title}
          >
            <h2 className="text-lg font-semibold tracking-tight">
              {feature.title}
            </h2>
            <p className="mt-3 leading-7 text-fd-muted-foreground">
              {feature.body}
            </p>
          </article>
        ))}
      </section>
    </main>
  );
}
