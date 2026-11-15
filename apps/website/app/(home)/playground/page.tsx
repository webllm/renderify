import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { Playground } from "@/components/playground/playground";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Paste or edit JSX, TSX, or RuntimePlan JSON and render it immediately in an isolated browser sandbox. No LLM request is involved.",
};

const FACTS = [
  "JSX / TSX",
  "RuntimePlan JSON",
  "Sandboxed iframe",
  "Shareable URL hash",
];

export default function PlaygroundPage() {
  return (
    <div className="playground-page">
      <div aria-hidden="true" className="playground-page-backdrop" />
      <div className="mx-auto flex w-full max-w-[1680px] flex-1 flex-col px-4 pb-16 pt-10 md:px-6 md:pt-14">
        <header className="playground-page-header">
          <p className="playground-page-badge">
            <ShieldCheck aria-hidden="true" size={14} />
            Renderer-only Playground
          </p>
          <h1>
            Paste code.{" "}
            <span className="renderify-gradient-text">Render immediately.</span>
          </h1>
          <p>
            Edit React-compatible JSX/TSX or a declarative RuntimePlan.
            Rendering happens entirely in your browser; this page has no model
            provider, prompt endpoint, or LLM request.
          </p>
          <ul aria-label="Playground capabilities">
            {FACTS.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </header>
        <Playground />
      </div>
    </div>
  );
}
