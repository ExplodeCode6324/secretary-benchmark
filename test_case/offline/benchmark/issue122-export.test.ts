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

test("the published stop keeps the prospective Go position, both official failures and zero reader launches", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue122-coverage-"));
  try {
    const file = join(dir, "coverage.json");
    const run = spawnSync("python3", ["scripts/export-issue122-coverage.py", "--output", file], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(file, "utf8"));
    const rows = result.effective_assertion_coverage as {case: string; assertion: string; positions: {repeat: number; route: string; result: string}[]}[];
    assert.equal(result.observations, 99);
    assert.equal(rows.flatMap(r => r.positions).length, 189);
    const maintenance = rows.find(r => r.case === "C16-combined" && r.assertion === "maintenance_current");
    assert.deepEqual(maintenance?.positions.map(p => [p.repeat, p.route, p.result]), [
      [1, "opencode-go", "NOT_TESTED"], [2, "deepseek-official", "FAIL"], [3, "deepseek-official", "FAIL"],
    ]);
    const supplement = JSON.parse(readFileSync("evidence/issue122-targeted-supplement.json", "utf8"));
    assert.equal(supplement.reader_final_sha256, null);
    assert.equal(supplement.c16.adjudicable, 2);
    assert.equal(supplement.c12b_complete_live_witness, false);
    assert.equal(supplement.workload_billing.uncertain_actual_usd, null);
    assert.equal(supplement.readers.length, 5);
    for (const reader of supplement.readers) {
      assert.equal(reader.possible_provider_sends, 0);
      assert.equal(reader.status, "NOT_TESTED");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
