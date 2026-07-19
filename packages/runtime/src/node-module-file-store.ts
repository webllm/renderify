import { isNodeRuntime } from "./runtime-environment";

let storeDirectoryPromise: Promise<string> | undefined;
const fileUrlPromises = new Map<string, Promise<string>>();

export async function createNodeModuleFileUrl(
  code: string,
): Promise<string | undefined> {
  if (!isNodeRuntime()) {
    return undefined;
  }

  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(code, "utf8").digest("hex");
  const key = `${digest}-${Buffer.byteLength(code, "utf8")}`;
  const cached = fileUrlPromises.get(key);
  if (cached) {
    return cached;
  }

  const creating = writeNodeModuleFile(key, code);
  fileUrlPromises.set(key, creating);
  try {
    return await creating;
  } catch (error) {
    if (fileUrlPromises.get(key) === creating) {
      fileUrlPromises.delete(key);
    }
    throw error;
  }
}

async function writeNodeModuleFile(key: string, code: string): Promise<string> {
  const [{ writeFile }, { join }, { pathToFileURL }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:url"),
  ]);
  const directory = await getStoreDirectory();
  const filePath = join(directory, `${key}.mjs`);
  await writeFile(filePath, code, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return pathToFileURL(filePath).toString();
}

async function getStoreDirectory(): Promise<string> {
  if (storeDirectoryPromise) {
    return storeDirectoryPromise;
  }

  storeDirectoryPromise = (async () => {
    const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
    ]);
    const directory = await mkdtemp(
      join(tmpdir(), "renderify-runtime-modules-"),
    );
    await registerStoreCleanup(directory);
    return directory;
  })();

  return storeDirectoryPromise;
}

async function registerStoreCleanup(directory: string): Promise<void> {
  const { rmSync } = await import("node:fs");
  process.once("exit", () => {
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup for process-owned temporary source modules.
    }
  });
}
