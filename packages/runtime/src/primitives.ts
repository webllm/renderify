import type { ComponentChildren, JSX } from "preact";
import { h } from "preact";

export interface RenderifyTheme {
  name: string;
  colors: {
    background: string;
    surface: string;
    surfaceMuted: string;
    text: string;
    textMuted: string;
    primary: string;
    accent: string;
    border: string;
    success: string;
    warning: string;
    danger: string;
  };
  radii: {
    sm: string;
    md: string;
    lg: string;
    pill: string;
  };
  spacing: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
  };
  shadow: {
    sm: string;
    md: string;
  };
  typography: {
    body: string;
    heading: string;
    mono: string;
  };
}

export interface RenderifyThemeOverride {
  name?: string;
  colors?: Partial<RenderifyTheme["colors"]>;
  radii?: Partial<RenderifyTheme["radii"]>;
  spacing?: Partial<RenderifyTheme["spacing"]>;
  shadow?: Partial<RenderifyTheme["shadow"]>;
  typography?: Partial<RenderifyTheme["typography"]>;
}

export const renderifyThemes = {
  aurora: {
    name: "aurora",
    colors: {
      background: "#06131f",
      surface: "#0f1d2e",
      surfaceMuted: "#1a2d45",
      text: "#f4fbff",
      textMuted: "#9eb5cb",
      primary: "#39d0ff",
      accent: "#5bf2bf",
      border: "#284868",
      success: "#2ac78f",
      warning: "#ffbc42",
      danger: "#ff6b6b",
    },
    radii: {
      sm: "8px",
      md: "12px",
      lg: "18px",
      pill: "999px",
    },
    spacing: {
      xs: "4px",
      sm: "8px",
      md: "12px",
      lg: "18px",
      xl: "28px",
    },
    shadow: {
      sm: "0 6px 18px rgba(0, 0, 0, 0.2)",
      md: "0 18px 48px rgba(0, 0, 0, 0.28)",
    },
    typography: {
      body: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
      heading: "ui-rounded, ui-sans-serif, system-ui, sans-serif",
      mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  },
  slate: {
    name: "slate",
    colors: {
      background: "#0c1117",
      surface: "#151d26",
      surfaceMuted: "#1f2b38",
      text: "#f6f9fc",
      textMuted: "#9baec2",
      primary: "#6cb5ff",
      accent: "#7ee0d3",
      border: "#2f4154",
      success: "#36c48f",
      warning: "#f5b84a",
      danger: "#ff7a7a",
    },
    radii: {
      sm: "6px",
      md: "10px",
      lg: "14px",
      pill: "999px",
    },
    spacing: {
      xs: "4px",
      sm: "8px",
      md: "12px",
      lg: "16px",
      xl: "24px",
    },
    shadow: {
      sm: "0 4px 14px rgba(0, 0, 0, 0.18)",
      md: "0 14px 36px rgba(0, 0, 0, 0.24)",
    },
    typography: {
      body: "Inter, ui-sans-serif, system-ui, sans-serif",
      heading: "Inter, ui-sans-serif, system-ui, sans-serif",
      mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  },
  citrus: {
    name: "citrus",
    colors: {
      background: "#fffaf0",
      surface: "#ffffff",
      surfaceMuted: "#fff2d9",
      text: "#2d2615",
      textMuted: "#786a47",
      primary: "#ff8b2d",
      accent: "#2fb57a",
      border: "#f0d8aa",
      success: "#2ea46f",
      warning: "#d4962f",
      danger: "#d85a5a",
    },
    radii: {
      sm: "8px",
      md: "12px",
      lg: "16px",
      pill: "999px",
    },
    spacing: {
      xs: "4px",
      sm: "8px",
      md: "12px",
      lg: "18px",
      xl: "26px",
    },
    shadow: {
      sm: "0 8px 20px rgba(136, 104, 39, 0.12)",
      md: "0 20px 48px rgba(136, 104, 39, 0.16)",
    },
    typography: {
      body: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
      heading: "ui-serif, Georgia, Cambria, serif",
      mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  },
} as const satisfies Record<string, RenderifyTheme>;

export type RenderifyThemeName = keyof typeof renderifyThemes;

export interface ThemeProviderProps {
  children?: ComponentChildren;
  className?: string;
  style?: JSX.CSSProperties;
  theme?: RenderifyThemeName | RenderifyThemeOverride;
}

export interface StackProps {
  children?: ComponentChildren;
  className?: string;
  style?: JSX.CSSProperties;
  gap?: string;
  align?: "stretch" | "start" | "center" | "end";
}

export interface InlineProps {
  children?: ComponentChildren;
  className?: string;
  style?: JSX.CSSProperties;
  gap?: string;
  align?: "stretch" | "start" | "center" | "end";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
}

export interface GridProps {
  children?: ComponentChildren;
  className?: string;
  style?: JSX.CSSProperties;
  gap?: string;
  columns?: number | string;
  minItemWidth?: string;
}

export interface SurfaceProps {
  children?: ComponentChildren;
  className?: string;
  style?: JSX.CSSProperties;
  padding?: string;
  tone?: "default" | "muted" | "accent";
}

export interface MetricTileProps {
  className?: string;
  style?: JSX.CSSProperties;
  label: string;
  value: string;
  delta?: string;
  tone?: "default" | "success" | "warning" | "danger";
}

export function resolveRenderifyTheme(
  input?: RenderifyThemeName | RenderifyThemeOverride,
): RenderifyTheme {
  if (!input) {
    return renderifyThemes.aurora;
  }

  if (typeof input === "string") {
    return renderifyThemes[input] ?? renderifyThemes.aurora;
  }

  const base = renderifyThemes.aurora;
  return {
    ...base,
    ...(input.name ? { name: input.name } : {}),
    colors: { ...base.colors, ...input.colors },
    radii: { ...base.radii, ...input.radii },
    spacing: { ...base.spacing, ...input.spacing },
    shadow: { ...base.shadow, ...input.shadow },
    typography: { ...base.typography, ...input.typography },
  };
}

export function ThemeProvider(props: ThemeProviderProps) {
  const { children, className, style, theme: themeInput } = props;

  const theme = resolveRenderifyTheme(themeInput);

  return h(
    "div",
    {
      class: className,
      style: mergeStyles(
        themeToCssVariables(theme),
        {
          background: "var(--rf-color-background)",
          color: "var(--rf-color-text)",
          fontFamily: "var(--rf-font-body)",
        },
        style,
      ),
      "data-renderify-theme": theme.name,
    },
    children,
  );
}

export function Stack(props: StackProps) {
  const {
    children,
    className,
    style,
    gap = "var(--rf-space-md)",
    align = "stretch",
  } = props;

  return h(
    "div",
    {
      class: className,
      style: mergeStyles(
        {
          display: "flex",
          flexDirection: "column",
          gap,
          alignItems: mapFlexAlign(align),
        },
        style,
      ),
    },
    children,
  );
}

export function Inline(props: InlineProps) {
  const {
    children,
    className,
    style,
    gap = "var(--rf-space-sm)",
    align = "center",
    justify = "start",
    wrap = true,
  } = props;

  return h(
    "div",
    {
      class: className,
      style: mergeStyles(
        {
          display: "flex",
          gap,
          alignItems: mapFlexAlign(align),
          justifyContent: mapFlexJustify(justify),
          flexWrap: wrap ? "wrap" : "nowrap",
        },
        style,
      ),
    },
    children,
  );
}

export function Grid(props: GridProps) {
  const {
    children,
    className,
    style,
    gap = "var(--rf-space-lg)",
    columns = 3,
    minItemWidth = "220px",
  } = props;

  const gridTemplateColumns =
    typeof columns === "number"
      ? `repeat(${Math.max(1, Math.floor(columns))}, minmax(0, 1fr))`
      : columns;

  return h(
    "div",
    {
      class: className,
      style: mergeStyles(
        {
          display: "grid",
          gap,
          gridTemplateColumns,
          minWidth: 0,
        },
        gridTemplateColumns.includes("auto-fit") ||
          gridTemplateColumns.includes("auto-fill")
          ? undefined
          : {
              gridAutoRows: "minmax(0, auto)",
            },
        columns === "responsive"
          ? {
              gridTemplateColumns: `repeat(auto-fit, minmax(${minItemWidth}, 1fr))`,
            }
          : undefined,
        style,
      ),
    },
    children,
  );
}

export function Surface(props: SurfaceProps) {
  const {
    children,
    className,
    style,
    padding = "var(--rf-space-lg)",
    tone = "default",
  } = props;

  const toneStyle =
    tone === "muted"
      ? { background: "var(--rf-color-surface-muted)" }
      : tone === "accent"
        ? {
            background:
              "linear-gradient(135deg, var(--rf-color-surface) 0%, color-mix(in srgb, var(--rf-color-primary) 14%, var(--rf-color-surface)) 100%)",
          }
        : { background: "var(--rf-color-surface)" };

  return h(
    "section",
    {
      class: className,
      style: mergeStyles(
        {
          border: "1px solid var(--rf-color-border)",
          borderRadius: "var(--rf-radius-md)",
          boxShadow: "var(--rf-shadow-sm)",
          padding,
        },
        toneStyle,
        style,
      ),
    },
    children,
  );
}

export function MetricTile(props: MetricTileProps) {
  const { className, style, label, value, delta, tone = "default" } = props;

  const deltaColor =
    tone === "success"
      ? "var(--rf-color-success)"
      : tone === "warning"
        ? "var(--rf-color-warning)"
        : tone === "danger"
          ? "var(--rf-color-danger)"
          : "var(--rf-color-primary)";

  return h(
    Surface,
    {
      className,
      padding: "var(--rf-space-md)",
      style,
    },
    h(Stack, { gap: "var(--rf-space-xs)" }, [
      h(
        "span",
        {
          style: {
            color: "var(--rf-color-text-muted)",
            fontSize: "0.78rem",
            letterSpacing: "0.02em",
            textTransform: "uppercase",
          },
        },
        label,
      ),
      h(
        "strong",
        {
          style: {
            color: "var(--rf-color-text)",
            fontSize: "1.35rem",
            fontFamily: "var(--rf-font-heading)",
          },
        },
        value,
      ),
      delta
        ? h(
            "span",
            {
              style: {
                color: deltaColor,
                fontSize: "0.82rem",
                fontWeight: 600,
              },
            },
            delta,
          )
        : null,
    ]),
  );
}

function themeToCssVariables(theme: RenderifyTheme): JSX.CSSProperties {
  return {
    "--rf-color-background": theme.colors.background,
    "--rf-color-surface": theme.colors.surface,
    "--rf-color-surface-muted": theme.colors.surfaceMuted,
    "--rf-color-text": theme.colors.text,
    "--rf-color-text-muted": theme.colors.textMuted,
    "--rf-color-primary": theme.colors.primary,
    "--rf-color-accent": theme.colors.accent,
    "--rf-color-border": theme.colors.border,
    "--rf-color-success": theme.colors.success,
    "--rf-color-warning": theme.colors.warning,
    "--rf-color-danger": theme.colors.danger,
    "--rf-radius-sm": theme.radii.sm,
    "--rf-radius-md": theme.radii.md,
    "--rf-radius-lg": theme.radii.lg,
    "--rf-radius-pill": theme.radii.pill,
    "--rf-space-xs": theme.spacing.xs,
    "--rf-space-sm": theme.spacing.sm,
    "--rf-space-md": theme.spacing.md,
    "--rf-space-lg": theme.spacing.lg,
    "--rf-space-xl": theme.spacing.xl,
    "--rf-shadow-sm": theme.shadow.sm,
    "--rf-shadow-md": theme.shadow.md,
    "--rf-font-body": theme.typography.body,
    "--rf-font-heading": theme.typography.heading,
    "--rf-font-mono": theme.typography.mono,
  } as JSX.CSSProperties;
}

function mapFlexAlign(
  align: "stretch" | "start" | "center" | "end",
): JSX.CSSProperties["alignItems"] {
  if (align === "start") {
    return "flex-start";
  }

  if (align === "end") {
    return "flex-end";
  }

  return align;
}

function mapFlexJustify(
  justify: "start" | "center" | "end" | "between",
): JSX.CSSProperties["justifyContent"] {
  if (justify === "start") {
    return "flex-start";
  }

  if (justify === "end") {
    return "flex-end";
  }

  if (justify === "between") {
    return "space-between";
  }

  return justify;
}

function mergeStyles(
  ...styles: Array<JSX.CSSProperties | undefined>
): JSX.CSSProperties {
  const merged: JSX.CSSProperties = {};
  for (const style of styles) {
    if (!style) {
      continue;
    }

    Object.assign(merged, style);
  }

  return merged;
}
