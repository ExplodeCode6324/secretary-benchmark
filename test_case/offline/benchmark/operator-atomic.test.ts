import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { repository } from "../../online/benchmark/io.ts";
import {
  atomicItem,
  atomicPacket,
  parseAtomic,
  rawAtomic,
  certifiedResult,
  probeChecks,
  scoreAtomic,
  validateAtomicReference,
  validateControlSuite,
  type AtomicReference,
} from "../../online/benchmark/operator/atomic.ts";
import { operatorCommand } from "../../online/benchmark/operator/cli.ts";
import { config, rootFor } from "../../online/benchmark/operator/files.ts";

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(repository, "examples/secretary-atomic-controls.json"),
    "utf8",
  ),
);
test("atomic facts preserve multiplicity, severity, and the actual rate denominator", () => {
  validateControlSuite(fixture);
  const one: AtomicReference = structuredClone(fixture.items[0].reference);
  const both = scoreAtomic(one, ["CONTRADICTED", "CONTRADICTED"], false, []);
  assert.deepEqual(both.penalties, [{ group: "station", severity: "major" }]);
  assert.equal(both.metrics.contradiction.numerator, 1);
  assert.equal(both.metrics.contradiction.denominator, 1);
  one.facts[0].missing = "major";
  one.facts[0].contradicted = "minor";
  one.facts[1].contradicted = "minor";
  assert.equal(
    scoreAtomic(one, ["CONTRADICTED", "CONTRADICTED"], false, []).verdict,
    "FAIL",
  );
  one.facts[0].contradicted = "ignore";
  assert.throws(() => validateAtomicReference(one), /severity/);
  const any = structuredClone(fixture.items[1].reference);
  assert.equal(
    scoreAtomic(any, ["SUPPORTED", "ABSENT"], false, []).verdict,
    "PASS",
  );
  assert.equal(
    scoreAtomic(any, ["SUPPORTED", "SUPPORTED"], false, []).metrics.requiredHit
      .denominator,
    1,
  );
  any.sets[0].k = 2;
  any.sets[0].missing = "minor";
  assert.equal(
    scoreAtomic(any, ["SUPPORTED", "ABSENT"], false, []).verdict,
    "PARTIAL",
  );
  any.abstention = "ACCEPTABLE";
  assert.equal(
    scoreAtomic(any, ["ABSENT", "ABSENT"], true, []).metrics.requiredHit.rate,
    null,
  );
  assert.equal(
    scoreAtomic(any, ["ABSENT", "ABSENT"], false, [], true).metrics.requiredHit
      .rate,
    0,
  );
  assert.equal(
    scoreAtomic(any, ["ABSENT", "ABSENT"], false, [], true).metrics
      .contradiction.rate,
    null,
  );
  any.abstention = "REQUIRED";
  assert.equal(
    scoreAtomic(any, ["SUPPORTED", "SUPPORTED"], false, []).verdict,
    "FAIL",
  );
  any.abstention = "NOT_ACCEPTABLE";
  assert.equal(
    scoreAtomic(any, ["ABSENT", "ABSENT"], true, []).metrics.requiredHit
      .denominator,
    1,
  );
  const minor: AtomicReference = structuredClone(fixture.items[0].reference);
  minor.facts[0].missing = "minor";
  assert.equal(
    scoreAtomic(minor, ["ABSENT", "ABSENT"], false, []).verdict,
    "PARTIAL",
  );
  minor.facts[0].role = "OPTIONAL";
  minor.facts[0].missing = "ignore";
  assert.equal(
    scoreAtomic(minor, ["ABSENT", "ABSENT"], false, []).penalties.length,
    0,
  );
});
test("blind wire, bidirectional evidence and certified whole-response evaluation", () => {
  const r = structuredClone(fixture.items[0].reference);
  const answer =
    "Only Bamboo Bridge is valid. Reed Bank is closed. It costs ten credits.";
  const item = atomicItem(
    "system-identifying-local-id",
    "Which station is valid?",
    r,
    answer,
  );
  const packet = atomicPacket([item]);
  assert.deepEqual(Object.keys(packet.items[0]), [
    "question_id",
    "question",
    "reference_facts",
    "answer",
  ]);
  assert.equal(packet.items[0].question_id, "q1");
  assert.equal(packet.items[0].reference_facts[0].id, "f1");
  assert.ok(!JSON.stringify(packet).includes("MUST_NOT_CONTRADICT"));
  assert.ok(!JSON.stringify(packet).includes("system-identifying"));
  const row: any = {
    abstained: false,
    facts: [
      {
        id: "f1",
        verdict: "SUPPORTED",
        quote: "Only Bamboo Bridge is valid.",
        reason: "Current membership",
      },
      {
        id: "f2",
        verdict: "SUPPORTED",
        quote: "Reed Bank is closed.",
        reason: "Former station",
      },
    ],
    assertions: [
      {
        quote: "Only Bamboo Bridge is valid.",
        claim: "Bamboo only",
        status: "SUPPORTED_BY",
        fact_ids: ["f1"],
      },
      {
        quote: "Reed Bank is closed.",
        claim: "Reed closed",
        status: "SUPPORTED_BY",
        fact_ids: ["f2"],
      },
      {
        quote: "ten credits",
        claim: "Price",
        status: "UNSUPPORTED_BY_REFERENCE",
        fact_ids: [],
      },
    ],
  };
  const [out] = parseAtomic(rawAtomic(packet, [row]), [item]);
  assert.deepEqual(out.metrics.unsupportedExtra, {
    numerator: 1,
    denominator: 3,
    rate: 1 / 3,
  });
  const mismatch = structuredClone(row);
  mismatch.facts[0].verdict = "CONTRADICTED";
  assert.throws(
    () => parseAtomic(rawAtomic(packet, [mismatch]), [item]),
    /disagree/,
  );
  mismatch.assertions.shift();
  assert.throws(
    () => parseAtomic(rawAtomic(packet, [mismatch]), [item]),
    /missing contradiction/,
  );
  const invalid = structuredClone(row);
  invalid.facts[1].quote = "never said that";
  assert.throws(
    () => parseAtomic(rawAtomic(packet, [invalid]), [item]),
    /quote/,
  );
  const k: any = {
    probes: [
      { anchor: "Bridge", present: true, status: "SUPPORTED_BY" },
      { anchor: "Reed", present: false, status: "UNSUPPORTED_BY_REFERENCE" },
    ],
  };
  assert.deepEqual(
    probeChecks(k, row).map((p) => p.pass),
    [true, true],
  );
  const lump = structuredClone(row);
  lump.assertions[0].quote = answer;
  assert.equal(probeChecks(k, lump)[0].pass, false);
  r.variants = [{ answer, attesters: ["fixture-a", "fixture-b"], result: row }];
  validateAtomicReference(r);
  assert.deepEqual(certifiedResult(item), row);
  assert.equal(
    certifiedResult({ ...item, answer: "Actually no: " + answer }),
    null,
  );
  assert.equal(
    certifiedResult({ ...item, answer: answer + " Not anymore." }),
    null,
  );
});
test("operator evaluates an atomic case, exports and rebuilds its evidence, and regrades the same answers", async () => {
  const live = config("examples/secretary-questions-v2-live.json");
  assert.equal(live.workload, "opencode-go");
  assert.equal(live.controlSuite.visibility, "DEVELOPMENT");
  const c = config("examples/secretary-questions-v2.json");
  assert.equal(c.controlSuite.visibility, "DEVELOPMENT");
  fs.mkdirSync(path.join(repository, ".local"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(repository, ".local", "atomic-test-"));
  let root: string | undefined;
  try {
    const result: any = await operatorCommand("evaluate", [
      "--config",
      "examples/secretary-questions-v2.json",
    ]);
    root = rootFor(result.run);
    const report = JSON.parse(fs.readFileSync(result.json, "utf8"));
    assert.equal(report.coverage.graded, 3);
    assert.equal(report.atomicMetrics.requiredHit.denominator, 4);
    assert.equal(report.taskEvidence.operations.length, 6);
    assert.equal(report.qualification.checkedProbes, 2);
    assert.equal(report.qualification.matchedProbes, 2);
    const bundle = path.join(dir, "portable");
    await operatorCommand("export-run", [
      "--run",
      result.run,
      "--output",
      bundle,
    ]);
    const rebuilt: any = await operatorCommand("report", [
      "--bundle",
      bundle,
      "--output",
      path.join(dir, "replay"),
    ]);
    for (const k of ["report", "json"])
      assert.deepEqual(fs.readFileSync(result[k]), fs.readFileSync(rebuilt[k]));
    const diagnostic: any = await operatorCommand("regrade", [
      "--bundle",
      bundle,
    ]);
    const again = JSON.parse(fs.readFileSync(diagnostic.json, "utf8"));
    assert.deepEqual(again.judgeRescoreAgreement.fact, {
      matched: 7,
      compared: 7,
    });
    const archive = await import("../../online/benchmark/archive.ts");
    assert.equal((await archive.archiveFacility(root, dir)).status, "DRY_RUN");
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
    if (root) fs.rmSync(root, { force: true, recursive: true });
  }
});

test("withheld qualification reports aggregate evidence without revealing private controls", async () => {
  const { tmpdir } = await import("node:os");
  const { createHash } = await import("node:crypto");
  const d = fs.mkdtempSync(
    path.join(fs.realpathSync(tmpdir()), "atomic-privacy-"),
  );
  let run: string | undefined;
  try {
    const suite = {
      ...structuredClone(fixture),
      identity: "private-test",
      visibility: "WITHHELD",
    };
    const file = path.join(d, "controls.json"),
      cfg = path.join(d, "config.json");
    const source = JSON.parse(
      fs.readFileSync(
        path.join(repository, "examples/secretary-questions-v2.json"),
        "utf8",
      ),
    );
    source.target = "scripted-good";
    const write = () => {
      const bytes = JSON.stringify(suite);
      fs.writeFileSync(file, bytes);
      source.controlSuite = {
        path: "controls.json",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      fs.writeFileSync(cfg, JSON.stringify(source));
    };
    write();
    assert.throws(() => config(cfg), /Developer-visible/);
    suite.items = [
      {
        id: "privateKeyName",
        question: "Which public warehouse is open?",
        answer: "private anchor evidence",
        reference: {
          abstention: "NOT_ACCEPTABLE",
          facts: [
            {
              id: "privateRef",
              text: "private withheld truth",
              role: "REQUIRED",
              group: "warehouse",
              missing: "major",
              contradicted: "major",
            },
          ],
        },
        expected: {
          labels: ["SUPPORTED"],
          abstained: false,
          probes: [
            {
              anchor: "private anchor",
              status: "SUPPORTED_BY",
              present: false,
            },
          ],
        },
      },
    ];
    write();
    const accepted = config(cfg);
    assert.equal(accepted.controlSuite.items.length, 1);
    const result: any = await operatorCommand("evaluate", ["--config", cfg]);
    run = rootFor(result.run);
    const report = JSON.parse(fs.readFileSync(result.json, "utf8")),
      summary = report.qualification;
    assert.equal(summary.admitted, false);
    assert.equal(report.qualificationSuite.qualificationScope, "WITHHELD_KEY");
    assert.equal(summary.checkedProbes, 1);
    assert.equal(summary.matchedProbes, 0);
    assert.equal(report.coverage.graded, 0);
    for (const name of [result.report, result.json]) {
      const bytes = fs.readFileSync(name, "utf8");
      for (const s of [
        "privateKeyName",
        "privateRef",
        "private withheld truth",
        "private anchor",
      ])
        assert.ok(!bytes.includes(s));
    }
    const dest = path.join(d, "bundle");
    await operatorCommand("export-run", [
      "--run",
      result.run,
      "--output",
      dest,
    ]);
    const rebuilt: any = await operatorCommand("report", [
      "--bundle",
      dest,
      "--output",
      path.join(d, "report"),
    ]);
    assert.deepEqual(
      fs.readFileSync(result.json),
      fs.readFileSync(rebuilt.json),
    );
    const nested = structuredClone(suite);
    nested.items[0].expected.probes.push({
      anchor: "anchor",
      status: "SUPPORTED_BY",
      present: true,
    });
    assert.throws(() => validateControlSuite(nested), /nested/);
    const any = structuredClone(fixture.items[1].reference);
    any.sets[0].group = "oneObligation";
    validateAtomicReference(any);
    const scored = scoreAtomic(any, ["CONTRADICTED", "ABSENT"], false, []);
    assert.deepEqual(scored.penalties, [
      { group: "oneObligation", severity: "major" },
    ]);
    assert.deepEqual(scored.metrics.contradiction, {
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
    assert.ok(
      !JSON.stringify(
        atomicPacket([atomicItem("secretary", "Which station?", any, "One")]),
      ).includes("secretary"),
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    if (run) fs.rmSync(run, { recursive: true, force: true });
  }
});
