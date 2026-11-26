import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sha } from "../../online/benchmark/io.ts";
import { gradeJSONBytes as b } from "../../online/benchmark/grading-transaction.ts";
import {
  checkWorkloadClosure,
  targetWorkloadSource,
  workloadLanes,
} from "../../online/benchmark/targeted-reader-workload.ts";
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "r67-workload-")),
  );
  const put = (n: string, v: any) => {
    const file = path.join(root, n);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, b(v));
    return sha(b(v));
  };
  const run = "515bec30-ac15-44ed-9eac-e660664a23e3",
    lane = workloadLanes["c16-repeat1"],
    other = workloadLanes.c12b;
  const source = { schema: "issue122-c16-capture-v1" };
  const dir = "evidence/" + run,
    cap = dir + "/stage-c-targeted-capture.json",
    capture = put(cap, source);
  const trial = {
    run,
    descriptor: { scenario: "C16-combined" },
    observations: [
      {
        run,
        physical: {},
        targeted_capture: { status: "CAPTURED", sha256: capture },
      },
    ],
  };
  const report = put(dir + "/stage-c-trial.json", trial);
  const freeze = {
    targeted_supplement: { series: "issue122-r67-evidence-v1" },
    batch: [lane, other].map((lane) => ({
      targeted_supplement: true,
      lane: { lane },
    })),
  };
  const frozen = put("configs/stage-c-freeze.json", freeze);
  const state = {
    ended: true,
    current: null,
    freeze_sha256: frozen,
    terminals: {
      [lane]: { status: "INCOMPLETE", run, report_sha256: report },
      [other]: { status: "UNRUN" },
    },
  };
  const dispatch = () => put("campaign/stage-c-dispatch.json", state);
  dispatch();
  return {
    root,
    put,
    run,
    lane,
    other,
    dir,
    cap,
    trial,
    freeze,
    frozen,
    state,
    dispatch,
  };
}
test("all candidates wait for two exact frozen terminal workloads, including UNRUN", () => {
  const w = fixture();
  try {
    const good = checkWorkloadClosure(w.root, w.frozen, w.dispatch());
    assert.ok(targetWorkloadSource(w.root, good, "c16-repeat1"));
    assert.throws(
      () => targetWorkloadSource(w.root, good, "c12b"),
      /NO_WORKLOAD_REPORT/,
    );
    w.state.ended = false;
    w.dispatch();
    assert.throws(() => checkWorkloadClosure(w.root, w.frozen), /CLOSURE/);
    w.state.ended = true;
    Reflect.deleteProperty(w.state.terminals, w.other);
    w.dispatch();
    assert.throws(() => checkWorkloadClosure(w.root, w.frozen), /CLOSURE/);
  } finally {
    fs.rmSync(w.root, { recursive: true });
  }
});
test("same or foreign path, capture and report are checked against the exact terminal run before projection", () => {
  const w = fixture();
  try {
    const c = checkWorkloadClosure(w.root, w.frozen);
    assert.throws(
      () =>
        targetWorkloadSource(
          w.root,
          c,
          "c16-repeat1",
          path.join(w.root, "elsewhere.json"),
        ),
      /FOREIGN_CAPTURE/,
    );
    w.put(w.cap, { schema: "changed" });
    assert.throws(
      () => targetWorkloadSource(w.root, c, "c16-repeat1"),
      /CAPTURE_FILE_SHA/,
    );
    w.trial.observations[0].targeted_capture.status = "MISSING";
    w.put(w.dir + "/stage-c-trial.json", w.trial);
    assert.throws(
      () => targetWorkloadSource(w.root, c, "c16-repeat1"),
      /WORKLOAD_REPORT/,
    );
    w.state.terminals[w.lane].report_sha256 = sha(b(w.trial));
    w.dispatch();
    assert.throws(
      () =>
        targetWorkloadSource(
          w.root,
          checkWorkloadClosure(w.root, w.frozen),
          "c16-repeat1",
        ),
      /NO_CAPTURE/,
    );
    w.trial.observations[0].run = "foreign";
    w.state.terminals[w.lane].report_sha256 = w.put(
      w.dir + "/stage-c-trial.json",
      w.trial,
    );
    w.dispatch();
    assert.throws(
      () =>
        targetWorkloadSource(
          w.root,
          checkWorkloadClosure(w.root, w.frozen),
          "c16-repeat1",
        ),
      /PHYSICAL_RUN/,
    );
  } finally {
    fs.rmSync(w.root, { recursive: true });
  }
});
test("an earlier official facility cannot activate this series even with complete candidate report bytes", () => {
  const w = fixture();
  try {
    w.freeze.targeted_supplement.series = "earlier";
    const h = w.put("configs/stage-c-freeze.json", w.freeze);
    w.state.freeze_sha256 = h;
    w.dispatch();
    assert.throws(() => checkWorkloadClosure(w.root, h), /CLOSURE/);
  } finally {
    fs.rmSync(w.root, { recursive: true });
  }
});
