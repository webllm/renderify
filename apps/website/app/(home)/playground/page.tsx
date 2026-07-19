import type { Metadata } from "next";
import { Playground } from "@/components/playground/playground";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Paste or edit JSX, TSX, or RuntimePlan JSON and render it immediately in an isolated browser sandbox. No LLM request is involved.",
};

export default function PlaygroundPage() {
  return (
    <main className="mx-auto flex w-full max-w-[1680px] flex-1 flex-col px-4 pb-16 pt-10 md:px-6 md:pt-14">
      <div className="mb-8 max-w-3xl">
        <p className="text-sm font-semibold text-[var(--renderify-accent)]">
          Renderer-only Playground
        </p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight md:text-5xl">
          Paste code. Render immediately.
        </h1>
        <p className="mt-4 text-lg leading-8 text-fd-muted-foreground">
          Edit React-compatible JSX/TSX or a declarative RuntimePlan. Rendering
          happens entirely in your browser; this page has no model provider,
          prompt endpoint, or LLM request.
        </p>
      </div>
      <Playground />
    </main>
  );
}
