#!/usr/bin/env node

import { execSync } from "node:child_process";

const DEFAULT_BASE_BRANCH = "main";
const CHANGESET_DIR = ".changeset/";
const CHANGESET_README = ".changeset/README.md";

function run(command) {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ensureBaseRef(baseBranch) {
  const remoteRef = `origin/${baseBranch}`;
  try {
    run(`git rev-parse --verify ${remoteRef}`);
    return remoteRef;
  } catch {
    run(
      `git fetch --no-tags --depth=1 origin ${baseBranch}:refs/remotes/origin/${baseBranch}`,
    );
    return remoteRef;
  }
}

function listChangedFiles(baseRef, headRef) {
  const diffOutput = run(`git diff --name-only ${baseRef}...${headRef}`);
  if (diffOutput.length === 0) {
    return [];
  }

  return diffOutput
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function isChangesetFile(file) {
  return (
    file.startsWith(CHANGESET_DIR) &&
    file.endsWith(".md") &&
    file !== CHANGESET_README
  );
}

function isReleaseRelevantPackageFile(file) {
  if (!file.startsWith("packages/")) {
    return false;
  }

  if (file.endsWith(".md") || file.endsWith(".mdx")) {
    return false;
  }

  if (
    file.includes("/docs/") ||
    file.includes("/examples/") ||
    file.includes("/test/") ||
    file.includes("/tests/") ||
    file.includes("/__tests__/")
  ) {
    return false;
  }

  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function formatFileList(files) {
  return files.map((file) => `  - ${file}`).join("\n");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  const baseBranch =
    process.env.RENDERIFY_CHANGESET_BASE ??
    process.env.GITHUB_BASE_REF ??
    DEFAULT_BASE_BRANCH;
  const headRef = process.env.RENDERIFY_CHANGESET_HEAD ?? "HEAD";
  const baseRef = ensureBaseRef(baseBranch);
  const changedFiles = listChangedFiles(baseRef, headRef);

  if (changedFiles.length === 0) {
    console.log("No changed files detected. Skipping changeset requirement.");
    return;
  }

  const releaseRelevantChanges = changedFiles.filter(
    isReleaseRelevantPackageFile,
  );
  if (releaseRelevantChanges.length === 0) {
    console.log(
      "No release-relevant package changes detected. Changeset is not required.",
    );
    return;
  }

  const changesetFiles = changedFiles.filter(isChangesetFile);
  if (changesetFiles.length === 0) {
    fail(
      [
        "Changeset check failed:",
        "Package source/config files changed without a corresponding changeset.",
        "",
        "Release-relevant files:",
        formatFileList(releaseRelevantChanges),
        "",
        "Please run `pnpm changeset` and commit the generated file in `.changeset/`.",
      ].join("\n"),
    );
  }

  console.log(
    [
      "Changeset check passed.",
      `Found ${changesetFiles.length} changeset file(s) for ${releaseRelevantChanges.length} release-relevant change(s).`,
    ].join("\n"),
  );
}

main();
