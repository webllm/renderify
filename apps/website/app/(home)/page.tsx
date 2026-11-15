import { CtaSection } from "@/components/home/cta-section";
import { FeatureGrid } from "@/components/home/feature-grid";
import { Hero } from "@/components/home/hero";
import { LanesSection } from "@/components/home/lanes-section";
import { PackagesSection } from "@/components/home/packages-section";
import { RenderPipeline } from "@/components/home/render-pipeline";

export default function HomePage() {
  return (
    <>
      <Hero />
      <RenderPipeline />
      <LanesSection />
      <FeatureGrid />
      <PackagesSection />
      <CtaSection />
    </>
  );
}
