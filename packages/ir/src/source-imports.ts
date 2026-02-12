import {
  init as initModuleLexer,
  parse as parseModuleImports,
} from "es-module-lexer";

const SOURCE_IMPORT_REWRITE_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
] as const;

export interface RuntimeSourceImportRange {
  start: number;
  end: number;
  specifier: string;
}

export async function parseRuntimeSourceImportRanges(
  source: string,
): Promise<RuntimeSourceImportRange[]> {
  if (source.trim().length === 0) {
    return [];
  }

  try {
    await initModuleLexer;
    const [imports] = parseModuleImports(source);
    const parsed: RuntimeSourceImportRange[] = [];

    for (const entry of imports) {
      const specifier = entry.n?.trim();
      if (!specifier) {
        continue;
      }

      if (entry.s < 0 || entry.e <= entry.s) {
        continue;
      }

      parsed.push({
        start: entry.s,
        end: entry.e,
        specifier,
      });
    }

    return parsed.sort((left, right) => left.start - right.start);
  } catch {
    return parseRuntimeSourceImportRangesFromRegex(source);
  }
}

export async function collectRuntimeSourceImports(
  source: string,
): Promise<string[]> {
  const ranges = await parseRuntimeSourceImportRanges(source);
  const imports = new Set<string>();

  for (const entry of ranges) {
    imports.add(entry.specifier);
  }

  return [...imports];
}

function parseRuntimeSourceImportRangesFromRegex(
  source: string,
): RuntimeSourceImportRange[] {
  const parsed = new Map<string, RuntimeSourceImportRange>();

  for (const pattern of SOURCE_IMPORT_REWRITE_PATTERNS) {
    const regex = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );

    let match = regex.exec(source);
    while (match) {
      const fullMatch = String(match[0] ?? "");
      const capturedSpecifier = String(match[1] ?? "").trim();
      if (capturedSpecifier.length === 0) {
        match = regex.exec(source);
        continue;
      }

      const relativeIndex = fullMatch.indexOf(capturedSpecifier);
      if (relativeIndex < 0) {
        match = regex.exec(source);
        continue;
      }

      const start = match.index + relativeIndex;
      const end = start + capturedSpecifier.length;
      parsed.set(`${start}:${end}`, {
        start,
        end,
        specifier: capturedSpecifier,
      });

      match = regex.exec(source);
    }
  }

  return [...parsed.values()].sort((left, right) => left.start - right.start);
}
