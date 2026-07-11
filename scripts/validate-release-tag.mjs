#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_PACKAGE_PATH = path.join("packages", "renderify", "package.json");
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    return undefined;
  }

  const version = tag.slice(1);
  return SEMVER_PATTERN.test(version) ? version : undefined;
}

export function validateReleaseTag(tag, packageVersion) {
  const failures = [];
  const tagVersion = parseReleaseTag(tag);
  if (!tagVersion) {
    failures.push(`release tag is not valid SemVer: ${tag || "<empty>"}`);
    return failures;
  }

  if (tagVersion !== packageVersion) {
    failures.push(
      `release tag version ${tagVersion} does not match renderify package version ${packageVersion}`,
    );
  }
  return failures;
}

function readReleasePackageVersion() {
  const raw = fs.readFileSync(RELEASE_PACKAGE_PATH, "utf8");
  const pkg = JSON.parse(raw);
  if (
    typeof pkg !== "object" ||
    pkg === null ||
    typeof pkg.version !== "string" ||
    !SEMVER_PATTERN.test(pkg.version)
  ) {
    throw new Error(
      `${RELEASE_PACKAGE_PATH} must contain a valid SemVer version`,
    );
  }
  return pkg.version;
}

function main() {
  const tag = process.argv[2] ?? process.env.RELEASE_TAG ?? "";
  let packageVersion;
  try {
    packageVersion = readReleasePackageVersion();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const failures = validateReleaseTag(tag, packageVersion);
  if (failures.length > 0) {
    console.error("Release tag validation failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Release tag validation passed: ${tag} matches renderify@${packageVersion}.`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main();
}
