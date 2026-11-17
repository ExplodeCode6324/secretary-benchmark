import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
// This helper alone loads the pinned historical harness for differential tests.
export async function differentialFixture(
  base: string,
  ids: Record<string, string>,
) {
  const load = (name: string) =>
    import(
      pathToFileURL(path.join(base, "test_case/online/benchmark", name + ".ts"))
        .href
    );
  const { repository, writeJSON, sha, lease } = await load("io");
  const { gradeJSONBytes } = await load("grading-transaction");
  const {
    buildAssessment,
    exportAssessment,
    reserveAssessment,
    sendAssessment,
    importAssessment,
    worklistVersion,
  } = await load("assessment");
  const { createAssessmentReplayManifest, replayAssessment } =
    await load("assessment-report");
  const h = (v: any) => sha(gradeJSONBytes(v));
  const observed = { head: "a".repeat(40), tracked_tree_clean: true };
  const proof = {
    version: "secretary-assessment-execution-proof-v1",
    head: observed.head,
    review_status: "PASS",
    ci_status: "PASS",
    review_sha256: "b".repeat(64),
    ci_url: "https://github.com/ExplodeCode6324/Secretary/actions/runs/1",
  };
  function fixture() {
    const { id, run, nonce } = ids,
      root = path.join(repository, ".local/benchmark", "assessment-unit-" + id);
    writeJSON(path.join(root, "facility.json"), {
      version: 1,
      repository,
      nonce,
    });
    writeJSON(path.join(root, "runs", run + ".json"), {
      id: run,
      state: "STOPPED",
      lineage: run,
      config: { model: "fixture", profile: "DEP", case_id: "M1-fixture" },
    });
    writeJSON(path.join(root, "oracles", run + "-grade-packet.json"), {
      episode: { family: "M1" },
    });
    const payload = {
      version: "secretary-sealed-grading-v3",
      disposition: { protocol_version: "fixture-v1" },
      assertions: [
        {
          assertion_id: "first-answer-fidelity",
          allowed_labels: ["PASS", "FAIL", "UNRESOLVED"],
          host_coverage: "FIXTURE",
        },
      ],
    };
    const packet = {
      packet_id: ids.packet,
      payload_sha256: sha(JSON.stringify(payload)),
      payload,
      expected_judge: {
        provider: "Claude browser",
        model: "Fable 5.2",
        effort: "Extra",
      },
    };
    writeJSON(path.join(root, "oracles", run + "-sealed-v3.json"), packet);
    const hashFile = (n: string) => sha(fs.readFileSync(path.join(root, n)));
    const worklist = {
      version: worklistVersion,
      cohort_id: ids.cohort,
      new_batches: [{ assessment_id: id, facility_nonce: nonce, runs: [run] }],
      rows: [
        {
          facility_nonce: nonce,
          run,
          packet_id: packet.packet_id,
          packet_file_sha256: hashFile(`oracles/${run}-sealed-v3.json`),
          source_file_sha256: hashFile(`oracles/${run}-grade-packet.json`),
          run_file_sha256: hashFile(`runs/${run}.json`),
          metadata: {
            lineage: run,
            model: "fixture",
            profile: "DEP",
            case_id: "M1-fixture",
            family: "M1",
            cohort: "FIXTURE_ONLY",
            protocol_version: "fixture-v1",
          },
          selection: { kind: "ASSESSMENT", assessment_id: id },
        },
      ],
    };
    const b = fs.readFileSync(path.join(root, "facility.json")),
      history = {
        files: [
          {
            facility_nonce: nonce,
            relative: "facility.json",
            bytes: b.length,
            sha256: sha(b),
          },
        ],
      };
    const anchorRelative = "docs/fix/evidence/assessment-unit.json",
      p = buildAssessment(root, worklist, history, id, anchorRelative);
    const anchor = {
      version: "secretary-opus-assessment-anchor-v1",
      worklist_sha256: h(worklist),
      history_sha256: h(history),
      entries: [
        {
          assessment_id: id,
          record_sha256: h(p.record),
          request_sha256: p.record.request_sha256,
          preparation_sha256: p.preparation_sha256,
        },
      ],
    };
    const review = path.join(
      repository,
      ".local/reviews",
      "assessment-unit-" + id,
    );
    writeJSON(path.join(review, "ui.json"), { fixture: true });
    const ui = {
      model: "Opus 5.5",
      effort: "Extra",
      mode: "Manual",
      incognito: true,
      session_url: "https://claude.ai/new?incognito",
      files: [path.join(review, "ui.json")],
    };
    const observation = {
      copy_matches_display: true,
      completed: true,
      in_flight: false,
      files: ui.files,
    };
    return {
      id,
      run,
      nonce,
      root,
      worklist,
      history,
      anchorRelative,
      p,
      anchor,
      packet,
      review,
      ui,
      observation,
    };
  }
  function response(f: ReturnType<typeof fixture>): any {
    const judge = { model: "Opus 5.5", effort: "Extra" };
    return {
      batch_id: f.id,
      payload_sha256: f.p.record.batch.payload_sha256,
      judge,
      controls: {
        verdicts: Object.entries(f.p.privateData.expected).map(([id, v]) => ({
          id,
          ...(v as object),
          rationale: "fixture",
        })),
      },
      submissions: f.p.record.batch.payload.packets.map((p: any) => ({
        packet_id: p.packet_id,
        payload_sha256: p.payload_sha256,
        judge,
        verdicts: p.payload.assertions.map((a: any) => ({
          assertion_id: a.assertion_id,
          label: "PASS",
          severity: "OK",
          evidence: ["fixture"],
          rationale: "fixture",
          human_review: false,
          hard_gate_tags: [],
        })),
        notes: [],
      })),
    };
  }
  async function exported(f: ReturnType<typeof fixture>) {
    return lease(f.root, async (c: any) =>
      exportAssessment(
        f.root,
        c,
        f.worklist,
        f.history,
        f.id,
        f.anchorRelative,
        f.anchor,
        proof,
        observed,
      ),
    );
  }
  async function reserved(f: ReturnType<typeof fixture>) {
    return lease(f.root, async (c: any) => {
      const a = reserveAssessment(
        f.root,
        c,
        f.id,
        f.ui,
        proof,
        f.anchor,
        observed,
      );
      sendAssessment(f.root, c, f.id, a.attempt_id, f.anchor, observed);
      return a;
    });
  }
  async function submit(f: ReturnType<typeof fixture>, a: any, value: any) {
    const file = path.join(f.review, randomUUID() + ".txt");
    fs.writeFileSync(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o600 },
    );
    return lease(f.root, async (c: any) =>
      importAssessment(
        f.root,
        c,
        f.id,
        a.attempt_id,
        file,
        f.observation,
        f.anchor,
      ),
    );
  }

  const f = fixture();
  await exported(f);
  const a = await reserved(f);
  await submit(f, a, response(f));
  const locations = [{ root: f.root, facility_nonce: f.nonce }];
  const manifest = createAssessmentReplayManifest(
    f.worklist,
    locations,
    f.anchor,
  );
  const report = replayAssessment(manifest, locations, h(manifest), {
    assessment: f.anchor,
  });
  const replayAgain = replayAssessment(manifest, locations, h(manifest), {
    assessment: f.anchor,
  });
  return { request: f.p.request, batch: f.p.record.batch, report, replayAgain };
}
