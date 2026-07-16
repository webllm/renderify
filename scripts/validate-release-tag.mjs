#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_PACKAGE_PATH = path.join("packages", "renderify", "package.json");
const CHANGESET_DIR = ".changeset";
const CHANGESET_README = "README.md";
const PACKAGE_DIR = "packages";
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

export function validateReleaseState(pendingChangesets, publishablePackages) {
  const failures = [];

  if (pendingChangesets.length > 0) {
    failures.push(
      `pending changesets must be versioned before release: ${pendingChangesets.join(", ")}`,
    );
  }

  for (const pkg of publishablePackages) {
    if (pkg.version === "0.0.0") {
      failures.push(
        `${pkg.name} is still at the unpublished placeholder version 0.0.0`,
      );
    }
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

function listPendingChangesets() {
  return fs
    .readdirSync(CHANGESET_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== CHANGESET_README,
    )
    .map((entry) => path.join(CHANGESET_DIR, entry.name))
    .sort();
}

function readPublishablePackages() {
  return fs
    .readdirSync(PACKAGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packagePath = path.join(PACKAGE_DIR, entry.name, "package.json");
      if (!fs.existsSync(packagePath)) {
        return undefined;
      }
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (pkg.private === true) {
        return undefined;
      }
      return { name: pkg.name, version: pkg.version };
    })
    .filter(Boolean);
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

  const failures = [
    ...validateReleaseTag(tag, packageVersion),
    ...validateReleaseState(listPendingChangesets(), readPublishablePackages()),
  ];
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
