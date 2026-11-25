import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("published Issue 122 comparison fields regenerate from the recorded rows and receipts", () => {
  const script = "scripts/export-issue122.py";
  const verified = spawnSync("python3", [script], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);

  const report = JSON.parse(readFileSync("evidence/issue122-completion.json", "utf8"));
  report.comparison_rows_effective[0].effective_assertions = {};
  const dir = mkdtempSync(join(tmpdir(), "issue122-report-"));
  try {
    const path = join(dir, "altered.json");
    writeFileSync(path, JSON.stringify(report));
    const altered = spawnSync("python3", [script, "--published", path], { encoding: "utf8" });
    assert.notEqual(altered.status, 0);
    assert.match(altered.stderr, /Mismatch in derived field comparison_rows_effective/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
