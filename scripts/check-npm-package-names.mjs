import { spawnSync } from "node:child_process";
import { readPublishablePackages } from "./validate-release-tag.mjs";

// OIDC trust is configured per existing npm package. Check names, not the
// upcoming versions, before Changesets starts its concurrent publishes.
const missing = [];
for (const { name } of readPublishablePackages()) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
    { method: "HEAD", signal: AbortSignal.timeout(15_000) },
  );
  if (response.status === 404) {
    missing.push(name);
  } else if (!response.ok) {
    throw new Error(`Cannot check ${name} on npm (HTTP ${response.status}).`);
  }
}

if (missing.length) {
  console.error(`Package names missing from npm: ${missing.join(", ")}.`);
  // Unlike OIDC, a registry login can create new names in its own scope.
  // Check the fallback through the same npmrc used by the publish step.
  if (
    spawnSync("npm", ["whoami", "--registry=https://registry.npmjs.org"], {
      stdio: "ignore",
    }).status === 0
  ) {
    console.warn(
      "The authenticated npm account must have permission to create these names.",
    );
  } else {
    console.error(
      "Register each name and configure release.yml as its trusted publisher before retrying. See docs/contributing.md#first-release-of-a-package.",
    );
    process.exitCode = 1;
  }
}
