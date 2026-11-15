import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";

export default function Layout({ children }: { children: ReactNode }) {
  const options = baseOptions();
  return (
    <HomeLayout {...options} nav={{ ...options.nav, transparentMode: "top" }}>
      {children}
    </HomeLayout>
  );
}
