import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const CLEAN_SCRIPT = path.resolve("scripts/clean-build-artifacts.mjs");

test("package clean scripts are self-contained and remove only build artifacts", async (t) => {
  const packageDirectory = await createTemporaryDirectory(t);
  await createFile(path.join(packageDirectory, "dist", "bundle.mjs"));
  await createFile(path.join(packageDirectory, "dist-types", "index.d.ts"));
  await createFile(path.join(packageDirectory, "src", "index.ts"));

  const packageDirectories = [
    "cli",
    "core",
    "ir",
    "llm",
    "renderify",
    "runtime",
    "security",
  ];
  const cleanCommands = await Promise.all(
    packageDirectories.map(async (directory) => {
      const contents = await readFile(
        path.resolve("packages", directory, "package.json"),
        "utf8",
      );
      const manifest = JSON.parse(contents) as {
        scripts?: { clean?: string };
      };
      return manifest.scripts?.clean ?? "";
    }),
  );

  assert.ok(cleanCommands.every((command) => command === cleanCommands[0]));
  assert.doesNotMatch(cleanCommands[0], /\brm\b|find\s|\.\.\/\.\.\/scripts/);
  await execAsync(cleanCommands[0], { cwd: packageDirectory });

  await assert.rejects(access(path.join(packageDirectory, "dist")));
  await assert.rejects(access(path.join(packageDirectory, "dist-types")));
  await access(path.join(packageDirectory, "src", "index.ts"));
});

test("clean script removes repository build and turbo artifacts", async (t) => {
  const rootDirectory = await createTemporaryDirectory(t);
  await createFile(path.join(rootDirectory, "packages", "a", "dist", "a.mjs"));
  await createFile(
    path.join(rootDirectory, "packages", "b", "dist-types", "b.d.ts"),
  );
  await createFile(path.join(rootDirectory, "packages", "b", "src", "b.ts"));
  await createFile(path.join(rootDirectory, ".turbo", "cache", "entry"));

  await execFileAsync(process.execPath, [CLEAN_SCRIPT, "--repo"], {
    cwd: rootDirectory,
  });

  await assert.rejects(
    access(path.join(rootDirectory, "packages", "a", "dist")),
  );
  await assert.rejects(
    access(path.join(rootDirectory, "packages", "b", "dist-types")),
  );
  await assert.rejects(access(path.join(rootDirectory, ".turbo")));
  await access(path.join(rootDirectory, "packages", "b", "src", "b.ts"));
});

async function createTemporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderify-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createFile(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "fixture", "utf8");
}
