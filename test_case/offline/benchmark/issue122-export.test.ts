import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("copied evidence identifies both tables and verifies the supplemental bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue122-copied-evidence-"));
  const script = "scripts/export-issue122-coverage.py";
  const exported = (...args: string[]) => spawnSync("python3", [script, "--evidence", dir, ...args], { encoding: "utf8" });
  try {
    for (const name of ["issue122-completion.json", "issue122-coverage-fixtures.json"]) {
      copyFileSync(join("evidence", name), join(dir, name));
    }
    const baseline = exported();
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.deepEqual(JSON.parse(baseline.stdout).tables, ["historical"]);
    const name = "issue122-targeted-supplement.json";
    copyFileSync(join("evidence", name), join(dir, name));
    const file = join(dir, "coverage.json");
    const complete = exported("--output", file);
    assert.equal(complete.status, 0, complete.stderr);
    const copied = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(copied.tables, ["historical", "effective"]);
    const canonical = spawnSync("python3", [script, "--output", file], { encoding: "utf8" });
    assert.equal(canonical.status, 0, canonical.stderr);
    const current = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(copied.effective_assertion_coverage, current.effective_assertion_coverage);
    assert.deepEqual(copied.matrix, current.matrix);
    const retest = "issue122-targeted-retest.json";
    copyFileSync(join("evidence", retest), join(dir, retest));
    const withRetest = exported("--output", file);
    assert.equal(withRetest.status, 0, withRetest.stderr);
    assert.deepEqual(current.tables, ["historical", "effective", "retest"]);
    assert.deepEqual(current.matrix, copied.matrix);
    assert.deepEqual(current.effective_assertion_coverage, copied.effective_assertion_coverage);
    assert.deepEqual(current, JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(join(dir, retest), "{}");
    assert.match(exported().stderr, /Evidence digest mismatch/);
    writeFileSync(join(dir, name), "{}");
    assert.match(exported().stderr, /Evidence digest mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
