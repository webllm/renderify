export default function PlaygroundPlaceholder() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-6 py-20">
      <p className="text-sm font-semibold text-[var(--renderify-accent)]">
        Renderer-only Playground
      </p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">
        Paste code. See the result.
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-8 text-fd-muted-foreground">
        This static route is reserved for the browser-only JSX and RuntimePlan
        renderer. It does not connect to an LLM provider.
      </p>
    </main>
  );
}
