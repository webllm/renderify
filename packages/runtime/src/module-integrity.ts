const SUPPORTED_INTEGRITY_ALGORITHMS = new Map<string, string>([
  ["sha256", "SHA-256"],
  ["sha384", "SHA-384"],
  ["sha512", "SHA-512"],
]);

export async function verifyModuleIntegrity(input: {
  content: string;
  integrity: string;
}): Promise<boolean> {
  const candidates = parseIntegrityCandidates(input.integrity);
  if (candidates.length === 0) {
    return false;
  }

  const contentBytes = new TextEncoder().encode(input.content);
  const digestCache = new Map<string, string>();

  for (const candidate of candidates) {
    const expectedDigest = candidate.digest.trim();
    if (expectedDigest.length === 0) {
      continue;
    }

    let actualDigest = digestCache.get(candidate.algorithm);
    if (!actualDigest) {
      actualDigest = await computeBase64Digest(
        contentBytes,
        candidate.algorithm,
      );
      digestCache.set(candidate.algorithm, actualDigest);
    }

    if (actualDigest === expectedDigest) {
      return true;
    }
  }

  return false;
}

function parseIntegrityCandidates(
  integrity: string,
): Array<{ algorithm: string; digest: string }> {
  const tokens = integrity
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const parsed: Array<{ algorithm: string; digest: string }> = [];
  for (const token of tokens) {
    const separatorIndex = token.indexOf("-");
    if (separatorIndex <= 0 || separatorIndex >= token.length - 1) {
      continue;
    }

    const algorithm = token.slice(0, separatorIndex).toLowerCase();
    if (!SUPPORTED_INTEGRITY_ALGORITHMS.has(algorithm)) {
      continue;
    }

    parsed.push({
      algorithm,
      digest: token.slice(separatorIndex + 1),
    });
  }

  return parsed;
}

async function computeBase64Digest(
  content: Uint8Array,
  algorithm: string,
): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const webAlgorithm = SUPPORTED_INTEGRITY_ALGORITHMS.get(algorithm);
    if (!webAlgorithm) {
      throw new Error(`Unsupported integrity algorithm: ${algorithm}`);
    }
    const digestBuffer = await globalThis.crypto.subtle.digest(
      webAlgorithm,
      content,
    );
    return toBase64(new Uint8Array(digestBuffer));
  }

  const createHash = await loadNodeCreateHash();
  if (!createHash) {
    throw new Error("No integrity hashing backend is available");
  }

  return createHash(algorithm).update(content).digest("base64");
}

async function loadNodeCreateHash(): Promise<
  | ((algorithm: string) => {
      update(data: Uint8Array): { digest(encoding: "base64"): string };
    })
  | undefined
> {
  try {
    const cryptoNamespace = (await import("node:crypto")) as {
      createHash?: (algorithm: string) => {
        update(data: Uint8Array): { digest(encoding: "base64"): string };
      };
    };
    return cryptoNamespace.createHash;
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  throw new Error("Base64 encoding is unavailable in this runtime");
}
