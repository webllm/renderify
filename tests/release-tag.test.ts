import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = process.cwd();
const VALIDATOR_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "validate-release-tag.mjs",
);
const releasePackage = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, "packages", "renderify", "package.json"),
    "utf8",
  ),
) as { version: string };

test("release tag validator accepts the renderify package version", () => {
  const result = runValidator(`v${releasePackage.version}`);
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
  test(`release tag validator rejects invalid SemVer tag ${invalidTag}`, () => {
    const result = runValidator(invalidTag);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /not valid SemVer/);
  });
}

test("release tag validator rejects a version that does not match renderify", () => {
  const result = runValidator("v999.0.0");
  assert.equal(result.status, 1);
  assert.match(
    String(result.stderr),
    /does not match renderify package version/,
  );
});

function runValidator(tag: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [VALIDATOR_PATH, tag], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}
