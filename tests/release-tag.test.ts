import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const REPO_ROOT = process.cwd();
const VALIDATOR_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "validate-release-tag.mjs",
);

test("release tag validator accepts a matching tag and clean state", (context) => {
  const fixture = createReleaseFixture(context);
  const result = runValidator("v1.2.3", fixture);
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /Release tag validation passed/);
});

for (const invalidTag of [
  "1.2.3",
  "v01.2.3",
  "v1.2.3-01",
  "v1.2.3-alpha..1",
  "v1.2.3-",
  "v1.2.3+build..1",
]) {
  test(`release tag validator rejects invalid SemVer tag ${invalidTag}`, (context) => {
    const fixture = createReleaseFixture(context);
    const result = runValidator(invalidTag, fixture);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /not valid SemVer/);
  });
}

test("release tag validator rejects a version that does not match renderify", (context) => {
  const fixture = createReleaseFixture(context);
  const result = runValidator("v999.0.0", fixture);
  assert.equal(result.status, 1);
  assert.match(
    String(result.stderr),
    /does not match renderify package version/,
  );
});

test("release tag validator rejects pending changesets", (context) => {
  const fixture = createReleaseFixture(context);
  writeFileSync(
    path.join(fixture, ".changeset", "pending-release.md"),
    '---\n"renderify": patch\n---\n\nPending release.\n',
  );

  const result = runValidator("v1.2.3", fixture);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /pending changesets must be versioned/);
});

test("release tag validator rejects publishable placeholder versions", (context) => {
  const fixture = createReleaseFixture(context);
  writePackage(fixture, "placeholder", {
    name: "@renderify/placeholder",
    version: "0.0.0",
  });

  const result = runValidator("v1.2.3", fixture);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /placeholder version 0\.0\.0/);
});

function runValidator(
  tag: string,
  cwd = REPO_ROOT,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [VALIDATOR_PATH, tag], {
    cwd,
    encoding: "utf8",
  });
}

function createReleaseFixture(context: TestContext): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "renderify-release-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(path.join(fixture, ".changeset"));
  mkdirSync(path.join(fixture, "packages"));
  writeFileSync(
    path.join(fixture, ".changeset", "README.md"),
    "# Changesets\n",
  );
  writePackage(fixture, "renderify", {
    name: "renderify",
    version: "1.2.3",
  });
  return fixture;
}

function writePackage(
  fixture: string,
  directory: string,
  pkg: { name: string; version: string; private?: boolean },
): void {
  const packageDirectory = path.join(fixture, "packages", directory);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
}
