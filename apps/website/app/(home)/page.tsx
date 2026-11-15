import { FeatureGrid } from "@/components/home/feature-grid";
import { Hero } from "@/components/home/hero";
import { LanesSection } from "@/components/home/lanes-section";
import { RenderPipeline } from "@/components/home/render-pipeline";

export default function HomePage() {
  return (
    <>
      <Hero />
      <RenderPipeline />
      <LanesSection />
      <FeatureGrid />
    </>
  );
}
