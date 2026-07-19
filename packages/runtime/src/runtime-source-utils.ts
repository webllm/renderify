import {
  createElementNode,
  createTextNode,
  isRuntimeNode,
  parseRuntimeSourceImportRanges,
  type RuntimeNode,
} from "@renderify/ir";

import { isBrowserRuntime } from "./runtime-environment";
export function canMaterializeBrowserModules(): boolean {
  return (
    isBrowserRuntime() &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof Blob !== "undefined" &&
    typeof fetch === "function"
  );
}

export async function rewriteImportsAsync(
  code: string,
  resolver: (specifier: string) => Promise<string>,
): Promise<string> {
  const imports = await parseImportSpecifiersFromSource(code);
  if (imports.length === 0) {
    return code;
  }

  const resolutions = await Promise.allSettled(
    imports.map((item) => resolver(item.specifier)),
  );
  const failedResolution = resolutions.find(
    (resolution): resolution is PromiseRejectedResult =>
      resolution.status === "rejected",
  );
  if (failedResolution) {
    throw failedResolution.reason;
  }
  const resolvedSpecifiers = resolutions.map(
    (resolution) => (resolution as PromiseFulfilledResult<string>).value,
  );

  let rewritten = "";
  let cursor = 0;

  for (const [index, item] of imports.entries()) {
    rewritten += code.slice(cursor, item.start);
    rewritten += resolvedSpecifiers[index];
    cursor = item.end;
  }

  rewritten += code.slice(cursor);
  return rewritten;
}

export async function parseImportSpecifiersFromSource(
  source: string,
): Promise<Array<{ start: number; end: number; specifier: string }>> {
  return parseRuntimeSourceImportRanges(source);
}

export function createBrowserBlobModuleUrl(
  code: string,
  browserBlobUrls: Set<string>,
  browserBlobUrlsByCode?: Map<string, string>,
): string {
  const cached = browserBlobUrlsByCode?.get(code);
  if (cached) {
    browserBlobUrls.add(cached);
    return cached;
  }

  const blobUrl = URL.createObjectURL(
    new Blob([code], { type: "text/javascript" }),
  );
  browserBlobUrls.add(blobUrl);
  browserBlobUrlsByCode?.set(code, blobUrl);
  return blobUrl;
}

export function revokeBrowserBlobUrls(browserBlobUrls: Set<string>): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    browserBlobUrls.clear();
    return;
  }

  for (const blobUrl of browserBlobUrls) {
    URL.revokeObjectURL(blobUrl);
  }
  browserBlobUrls.clear();
}

export function normalizeRuntimeSourceOutput(
  output: unknown,
): RuntimeNode | undefined {
  if (isRuntimeNode(output)) {
    return output;
  }

  if (typeof output === "string" || typeof output === "number") {
    return createTextNode(String(output));
  }

  if (Array.isArray(output)) {
    const normalizedChildren = output
      .map((entry) => normalizeRuntimeSourceOutput(entry))
      .filter((entry): entry is RuntimeNode => entry !== undefined);

    return createElementNode(
      "div",
      { "data-renderify-fragment": "true" },
      normalizedChildren,
    );
  }

  return undefined;
}
