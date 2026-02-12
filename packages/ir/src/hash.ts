const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export interface Fnv1a64Hasher {
  update(chunk: string): void;
  digestHex(): string;
}

export function createFnv1a64Hasher(): Fnv1a64Hasher {
  let hash = FNV1A_64_OFFSET_BASIS;

  return {
    update: (chunk: string) => {
      for (let index = 0; index < chunk.length; index += 1) {
        hash ^= BigInt(chunk.charCodeAt(index));
        hash = (hash * FNV1A_64_PRIME) & UINT64_MASK;
      }
    },
    digestHex: () => hash.toString(16),
  };
}

export function hashStringFNV1a64Hex(value: string): string {
  const hasher = createFnv1a64Hasher();
  hasher.update(value);
  return hasher.digestHex();
}

export function hashStringFNV1a32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // Equivalent to `hash *= 0x01000193` (FNV-1a 32-bit prime) via bit shifts.
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

export function hashStringFNV1a32Base36(value: string): string {
  return hashStringFNV1a32(value).toString(36);
}
