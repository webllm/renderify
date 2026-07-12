/**
 * Regression suite over the escape/abuse corpus (tests/escape-corpus.fixtures.ts).
 *
 * Two jobs:
 *   1. Lock in every attack the policy/render layers currently stop, so a future
 *      change can't silently weaken them.
 *   2. Assert — in code — the documented GAPS: samples the static scanner cannot
 *      catch (obfuscated fetch/eval). These prove the banned-pattern list is a
 *      hint layer, not the security boundary, and force anyone strengthening
 *      detection to revisit the corpus consciously.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DefaultUIRenderer } from "@renderify/runtime";
import { DefaultSecurityChecker } from "@renderify/security";
import { ESCAPE_CORPUS, type EscapeSample } from "./escape-corpus.fixtures";

async function policyVerdict(sample: EscapeSample): Promise<boolean> {
  const checker = new DefaultSecurityChecker();
  checker.initialize({ profile: sample.profile });
  if (sample.moduleSpecifier !== undefined) {
    return checker.checkModuleSpecifier(sample.moduleSpecifier).safe;
  }
  if (sample.plan) {
    return (await checker.checkPlan(sample.plan)).safe;
  }
  throw new Error(`sample ${sample.id} has neither plan nor moduleSpecifier`);
}

for (const sample of ESCAPE_CORPUS) {
  test(`escape-corpus[${sample.boundary}]: ${sample.id} — ${sample.title}`, async () => {
    if (sample.node) {
      const html = new DefaultUIRenderer().renderNode(sample.node);
      if (sample.expect.renderAbsent !== undefined) {
        assert.ok(
          !html.includes(sample.expect.renderAbsent),
          `render output should not contain "${sample.expect.renderAbsent}": ${html}`,
        );
      }
      if (sample.expect.renderPresent !== undefined) {
        assert.ok(
          html.includes(sample.expect.renderPresent),
          `render output should contain "${sample.expect.renderPresent}": ${html}`,
        );
      }
      return;
    }

    const safe = await policyVerdict(sample);

    if (sample.expect.moduleSafe !== undefined) {
      assert.equal(
        safe,
        sample.expect.moduleSafe,
        `module specifier verdict mismatch for ${sample.id}`,
      );
      return;
    }

    assert.equal(
      safe,
      sample.expect.policySafe,
      sample.expect.policySafe
        ? `${sample.id} is a KNOWN GAP and must pass the policy layer (real boundary: ${sample.boundary}). ${sample.note}`
        : `${sample.id} must be blocked by the policy layer. ${sample.note}`,
    );
  });
}

test("escape-corpus: every sample documents its real boundary", () => {
  for (const sample of ESCAPE_CORPUS) {
    assert.ok(sample.note.length > 0, `${sample.id} missing note`);
    assert.ok(
      ["policy", "render", "sandbox", "csp"].includes(sample.boundary),
      `${sample.id} has an invalid boundary`,
    );
    // Samples whose boundary is NOT the policy layer must either be render-layer
    // (have a node) or be an acknowledged static-analysis gap (policySafe true).
    if (sample.boundary === "sandbox" || sample.boundary === "csp") {
      assert.equal(
        sample.expect.policySafe,
        true,
        `${sample.id}: sandbox/csp-boundary samples must be acknowledged policy gaps`,
      );
    }
  }
});
