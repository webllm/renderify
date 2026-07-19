import {
  DEFAULT_JSPM_SPECIFIER_OVERRIDES,
  parseRuntimeSourceImportRanges,
  type RuntimeModuleManifest,
  type RuntimePlan,
  type RuntimeSourceImportRange,
} from "@renderify/ir";
import { DefaultRuntimeSourceTranspiler } from "./transpiler";

export interface PlaygroundBrowserExecution {
  plan: RuntimePlan;
  framework: "preact" | "react";
  rendererUrl: string;
  rendererDomClientUrl?: string;
  rendererDomUrl?: string;
}

const PLAYGROUND_SOURCE_TRANSPILER = new DefaultRuntimeSourceTranspiler();
const PLAYGROUND_REACT_VERSION = "19.2.0";

export async function preparePlaygroundBrowserExecution(
  plan: RuntimePlan,
): Promise<PlaygroundBrowserExecution> {
  const source = plan.source;
  if (source?.runtime !== "preact") {
    throw new Error("Browser execution requires source.runtime=preact");
  }

  const sourceImports = await parseRuntimeSourceImportRanges(source.code);
  const framework = sourceImports.some((item) =>
    shouldUseReactBrowserRuntime(item.specifier),
  )
    ? "react"
    : "preact";
  const browserSourceCode =
    framework === "react"
      ? rewriteMaterialUiTextFieldInputHandlers(
          rewritePreactSourceImportsForReact(source.code, sourceImports),
        )
      : source.code;
  const code = await PLAYGROUND_SOURCE_TRANSPILER.transpile({
    code: browserSourceCode,
    language: source.language,
    filename: `renderify-playground-${plan.id}.${source.language}`,
    runtime: source.runtime,
    jsxImportSource: framework,
  });
  const moduleManifest: RuntimeModuleManifest = {
    ...(plan.moduleManifest ?? {}),
  };
  const frameworkModules =
    framework === "react"
      ? configureReactBrowserModules(moduleManifest)
      : configurePreactBrowserModules(moduleManifest);
  const imports = rewritePlanModuleSpecifiers(plan.imports, framework);
  const allowedModules = rewritePlanModuleSpecifiers(
    plan.capabilities?.allowedModules,
    framework,
  );

  return {
    plan: {
      ...plan,
      ...(imports ? { imports } : {}),
      ...(plan.capabilities
        ? {
            capabilities: {
              ...plan.capabilities,
              ...(allowedModules ? { allowedModules } : {}),
            },
          }
        : {}),
      moduleManifest,
      source: {
        ...source,
        language: "js",
        code,
      },
    },
    framework,
    ...frameworkModules,
  };
}

function configurePreactBrowserModules(
  moduleManifest: RuntimeModuleManifest,
): Pick<PlaygroundBrowserExecution, "rendererUrl"> {
  const preactVersion = resolvePlaygroundPreactVersion(moduleManifest);
  const preactBase = `https://esm.sh/preact@${encodeURIComponent(preactVersion)}`;

  setPlaygroundBrowserModule(
    moduleManifest,
    "preact",
    `${preactBase}?target=es2022`,
    preactVersion,
  );
  setPlaygroundBrowserModule(
    moduleManifest,
    "preact/hooks",
    `${preactBase}/hooks?target=es2022`,
    preactVersion,
  );
  setPlaygroundBrowserModule(
    moduleManifest,
    "preact/compat",
    `${preactBase}/compat?target=es2022`,
    preactVersion,
  );
  for (const specifier of ["preact/jsx-runtime", "preact/jsx-dev-runtime"]) {
    setPlaygroundBrowserModule(
      moduleManifest,
      specifier,
      `${preactBase}/jsx-runtime?target=es2022`,
      preactVersion,
    );
  }

  return {
    rendererUrl: moduleManifest.preact?.resolvedUrl ?? preactBase,
  };
}

function configureReactBrowserModules(
  moduleManifest: RuntimeModuleManifest,
): Pick<
  PlaygroundBrowserExecution,
  "rendererUrl" | "rendererDomClientUrl" | "rendererDomUrl"
> {
  const reactVersion = resolvePlaygroundReactVersion(moduleManifest);
  const reactBase = `https://esm.sh/react@${encodeURIComponent(reactVersion)}`;
  const reactDomBase = `https://esm.sh/react-dom@${encodeURIComponent(reactVersion)}`;

  setPlaygroundBrowserModule(
    moduleManifest,
    "react",
    `${reactBase}?target=es2022`,
    reactVersion,
  );
  for (const specifier of ["react/jsx-runtime", "react/jsx-dev-runtime"]) {
    setPlaygroundBrowserModule(
      moduleManifest,
      specifier,
      `${reactBase}/jsx-runtime?target=es2022`,
      reactVersion,
    );
  }
  setPlaygroundBrowserModule(
    moduleManifest,
    "react-dom",
    `${reactDomBase}?deps=react@${encodeURIComponent(reactVersion)}&target=es2022`,
    reactVersion,
  );
  setPlaygroundBrowserModule(
    moduleManifest,
    "react-dom/client",
    `${reactDomBase}/client?deps=react@${encodeURIComponent(reactVersion)}&target=es2022`,
    reactVersion,
  );
  configureReactMaterialUiModules(moduleManifest, reactVersion);

  return {
    rendererUrl: moduleManifest.react?.resolvedUrl ?? reactBase,
    rendererDomClientUrl:
      moduleManifest["react-dom/client"]?.resolvedUrl ??
      `${reactDomBase}/client`,
    rendererDomUrl: moduleManifest["react-dom"]?.resolvedUrl ?? reactDomBase,
  };
}

function shouldUseReactBrowserRuntime(specifier: string): boolean {
  const normalized = specifier.trim().toLowerCase();
  return (
    normalized === "react" ||
    normalized.startsWith("react/") ||
    normalized === "react-dom" ||
    normalized.startsWith("react-dom/") ||
    normalized === "@mui/material" ||
    normalized.startsWith("@mui/material/") ||
    normalized === "@mui/icons-material" ||
    normalized.startsWith("@mui/icons-material/")
  );
}

function rewritePreactSourceImportsForReact(
  source: string,
  imports: RuntimeSourceImportRange[],
): string {
  let rewritten = "";
  let cursor = 0;
  for (const item of imports) {
    rewritten += source.slice(cursor, item.start);
    rewritten += mapPreactSpecifierToReact(item.specifier);
    cursor = item.end;
  }
  return rewritten + source.slice(cursor);
}

function rewritePlanModuleSpecifiers(
  specifiers: string[] | undefined,
  framework: "preact" | "react",
): string[] | undefined {
  if (!specifiers || framework !== "react") {
    return specifiers;
  }

  return [
    ...new Set(
      specifiers.map((specifier) => mapPreactSpecifierToReact(specifier)),
    ),
  ];
}

function mapPreactSpecifierToReact(specifier: string): string {
  switch (specifier.trim()) {
    case "preact":
    case "preact/hooks":
    case "preact/compat":
      return "react";
    case "preact/jsx-runtime":
      return "react/jsx-runtime";
    case "preact/jsx-dev-runtime":
      return "react/jsx-dev-runtime";
    default:
      return specifier;
  }
}

function rewriteMaterialUiTextFieldInputHandlers(source: string): string {
  const tagNames = collectMaterialUiTextFieldTagNames(source);
  let rewritten = source;
  for (const tagName of tagNames) {
    rewritten = rewriteJsxOpeningTagAttribute(
      rewritten,
      tagName,
      "onInput",
      "onChange",
    );
  }
  return rewritten;
}

function collectMaterialUiTextFieldTagNames(source: string): Set<string> {
  const tagNames = new Set<string>();
  const namedImportPattern =
    /\bimport\s*\{([^}]*)\}\s*from\s*["']@mui\/material["']/g;
  for (const match of source.matchAll(namedImportPattern)) {
    for (const rawSpecifier of (match[1] ?? "").split(",")) {
      const specifier = rawSpecifier
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/g, "")
        .trim();
      const textFieldMatch = /^TextField(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
        specifier,
      );
      if (textFieldMatch) {
        tagNames.add(textFieldMatch[1] ?? "TextField");
      }
    }
  }

  const defaultImportPattern =
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*["']@mui\/material\/TextField["']/g;
  for (const match of source.matchAll(defaultImportPattern)) {
    if (match[1]) {
      tagNames.add(match[1]);
    }
  }

  const namespaceImportPattern =
    /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["']@mui\/material["']/g;
  for (const match of source.matchAll(namespaceImportPattern)) {
    if (match[1]) {
      tagNames.add(`${match[1]}.TextField`);
    }
  }

  return tagNames;
}

function rewriteJsxOpeningTagAttribute(
  source: string,
  tagName: string,
  fromAttribute: string,
  toAttribute: string,
): string {
  const needle = `<${tagName}`;
  let rewritten = source;
  let searchFrom = 0;

  while (searchFrom < rewritten.length) {
    const start = rewritten.indexOf(needle, searchFrom);
    if (start < 0) {
      break;
    }
    const boundary = rewritten[start + needle.length];
    if (boundary && !/[\s/>]/.test(boundary)) {
      searchFrom = start + needle.length;
      continue;
    }

    const end = findJsxOpeningTagEnd(rewritten, start + needle.length);
    if (end < 0) {
      break;
    }
    const openingTag = rewritten.slice(start, end + 1);
    const attributes = collectTopLevelJsxAttributes(openingTag);
    const fromPositions = attributes.get(fromAttribute) ?? [];
    if (fromPositions.length > 0 && !attributes.has(toAttribute)) {
      let normalizedTag = openingTag;
      for (const position of [...fromPositions].reverse()) {
        normalizedTag =
          normalizedTag.slice(0, position) +
          toAttribute +
          normalizedTag.slice(position + fromAttribute.length);
      }
      rewritten =
        rewritten.slice(0, start) + normalizedTag + rewritten.slice(end + 1);
      searchFrom = start + normalizedTag.length;
    } else {
      searchFrom = end + 1;
    }
  }

  return rewritten;
}

function findJsxOpeningTagEnd(source: string, start: number): number {
  let quote: string | undefined;
  let braceDepth = 0;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      braceDepth += 1;
    } else if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
    } else if (char === ">" && braceDepth === 0) {
      return index;
    }
  }
  return -1;
}

function collectTopLevelJsxAttributes(
  openingTag: string,
): Map<string, number[]> {
  const attributes = new Map<string, number[]>();
  let quote: string | undefined;
  let braceDepth = 0;
  let escaped = false;
  for (let index = 0; index < openingTag.length; index += 1) {
    const char = openingTag[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }
    if (braceDepth !== 0 || !/[A-Za-z_$]/.test(char ?? "")) {
      continue;
    }
    const previous = openingTag[index - 1];
    if (previous && !/\s/.test(previous)) {
      continue;
    }
    let end = index + 1;
    while (/[\w$:-]/.test(openingTag[end] ?? "")) {
      end += 1;
    }
    let equalsAt = end;
    while (/\s/.test(openingTag[equalsAt] ?? "")) {
      equalsAt += 1;
    }
    if (openingTag[equalsAt] === "=") {
      const attribute = openingTag.slice(index, end);
      const positions = attributes.get(attribute) ?? [];
      positions.push(index);
      attributes.set(attribute, positions);
    }
    index = end - 1;
  }
  return attributes;
}

function configureReactMaterialUiModules(
  moduleManifest: RuntimeModuleManifest,
  reactVersion: string,
): void {
  for (const [specifier, descriptor] of Object.entries(moduleManifest)) {
    const match = /^(@mui\/(?:material|icons-material))(?:\/(.*))?$/.exec(
      specifier,
    );
    if (!match) {
      continue;
    }

    const packageName = match[1];
    const subpath = match[2];
    const packageVersion =
      normalizePlaygroundPackageVersion(descriptor.version) ??
      normalizePlaygroundPackageVersion(
        descriptor.resolvedUrl.match(
          /@mui\/(?:material|icons-material)@([^/?#]+)/i,
        )?.[1],
      );
    if (!packageName || !packageVersion) {
      throw new Error(
        `Material UI browser execution requires a pinned version: ${specifier}`,
      );
    }

    const packagePath = `${packageName}@${encodeURIComponent(packageVersion)}${subpath ? `/${subpath}` : ""}`;
    const resolvedUrl =
      `https://esm.sh/${packagePath}?bundle&` +
      `deps=react@${encodeURIComponent(reactVersion)},react-dom@${encodeURIComponent(reactVersion)}&target=es2022`;
    setPlaygroundBrowserModule(
      moduleManifest,
      specifier,
      resolvedUrl,
      packageVersion,
    );
  }
}

function setPlaygroundBrowserModule(
  moduleManifest: RuntimeModuleManifest,
  specifier: string,
  resolvedUrl: string,
  version: string,
): void {
  const descriptor = {
    ...(moduleManifest[specifier] ?? {}),
    resolvedUrl,
    version,
  };
  delete descriptor.integrity;
  delete descriptor.signer;
  moduleManifest[specifier] = descriptor;
}

function resolvePlaygroundPreactVersion(
  moduleManifest: RuntimeModuleManifest | undefined,
): string {
  const descriptors = [
    moduleManifest?.preact,
    moduleManifest?.["preact/hooks"],
    moduleManifest?.["preact/jsx-runtime"],
  ];
  for (const descriptor of descriptors) {
    const declared = normalizePlaygroundPackageVersion(descriptor?.version);
    if (declared) {
      return declared;
    }
    const fromUrl = normalizePlaygroundPackageVersion(
      descriptor?.resolvedUrl.match(/(?:\/|npm:)preact@([^/?#]+)/i)?.[1],
    );
    if (fromUrl) {
      return fromUrl;
    }
  }

  const defaultPreactUrl = DEFAULT_JSPM_SPECIFIER_OVERRIDES.preact ?? "";
  return (
    normalizePlaygroundPackageVersion(
      defaultPreactUrl.match(/(?:\/|npm:)preact@([^/?#]+)/i)?.[1],
    ) ?? "10.28.3"
  );
}

function resolvePlaygroundReactVersion(
  moduleManifest: RuntimeModuleManifest,
): string {
  for (const specifier of ["react", "react-dom", "react-dom/client"]) {
    const descriptor = moduleManifest[specifier];
    const fromUrl = normalizePlaygroundPackageVersion(
      descriptor?.resolvedUrl.match(
        /(?:\/|npm:)react(?:-dom)?@([^/?#]+)/i,
      )?.[1],
    );
    if (fromUrl) {
      return fromUrl;
    }
  }
  return PLAYGROUND_REACT_VERSION;
}

function normalizePlaygroundPackageVersion(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^[0-9]+(?:\.[0-9A-Za-z-]+){1,3}$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}
