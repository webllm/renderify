import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const OUTPUT_DIRECTORIES = ["dist", "dist-types"];

async function removePackageOutputs(packageDirectory) {
  await Promise.all(
    OUTPUT_DIRECTORIES.map((directory) =>
      rm(path.join(packageDirectory, directory), {
        recursive: true,
        force: true,
      }),
    ),
  );
}

async function cleanRepository(rootDirectory) {
  const packagesDirectory = path.join(rootDirectory, "packages");
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const packageDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDirectory, entry.name));

  await Promise.all([
    ...packageDirectories.map(removePackageOutputs),
    rm(path.join(rootDirectory, ".turbo"), {
      recursive: true,
      force: true,
    }),
  ]);
}

if (process.argv.includes("--repo")) {
  await cleanRepository(process.cwd());
} else {
  await removePackageOutputs(process.cwd());
}
