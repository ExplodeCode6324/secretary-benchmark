import test from "node:test";
import assert from "node:assert/strict";
import {
  projectTargetedC16,
  targetedControls,
  type TargetedC16Capture,
} from "../../online/benchmark/targeted-reader-packet.ts";
import { scoringRubric } from "../../online/benchmark/stage-c-grading.ts";
import {
  goReader,
  goVisibilityVersion,
  admittedReaderQuery,
} from "../../online/benchmark/stage-c-visibility-rubric.ts";
const p = {
  rubric: scoringRubric(goReader, goVisibilityVersion),
  assertions: ["maintenance_current", "use_current"],
  evidence: [
    { id: "coverage", text: "First eligible request capture coverage" },
  ],
};
const binding = {
  scenario: "C16-combined",
  wire_ids: [],
  surfaceComplete: false,
  coverage_id: "coverage",
};
function capture(): TargetedC16Capture {
  const sources = [
    {
      id: "private-source",
      role: "user" as const,
      text: "The corrected location is Green.",
    },
  ];
  const item = {
    id: "private-item",
    contents: "Use Green.",
    sources,
    complete: true,
  };
  return {
    schema: "issue122-c16-capture-v1",
    first_request_sequence: 4,
    snapshots: [
      { phase: "commit-1", sequence: 1, capture: "complete", items: [item] },
      { phase: "commit-2", sequence: 2, capture: "complete", items: [item] },
      {
        phase: "first-request",
        sequence: 4,
        capture: "complete",
        items: [item],
      },
    ],
    proposal_capture: "complete",
    proposals: [
      {
        id: "private-op",
        sequence: 3,
        contents: "Use Brown.",
        sources,
        state: "WAIT_AUTH",
        effect: "NOT_STARTED",
        operation_matches: true,
        receipt_matches: false,
        fact_revision_matches: false,
        committed: false,
      },
    ],
  };
}
const render = (c: TargetedC16Capture) => projectTargetedC16(p, binding, c);
const obs = (r: ReturnType<typeof render>, i: number) =>
  JSON.parse(r.packet.evidence[i].text.split("\n").slice(1).join("\n"));
test("a shared source and item maintain blinded identity; the pending item appears only in proposal history", () => {
  const r = render(capture()),
    q = admittedReaderQuery(r.packet);
  assert.equal(q.split("The corrected location is Green.").length - 1, 1);
  assert.doesNotMatch(q, /private-(source|item|op)/);
  assert.deepEqual(obs(r, 1).items, obs(r, 2).items);
  assert.deepEqual(
    obs(r, 5).map((v: any) => v.id),
    obs(r, 3).items[0].sources,
  );
  assert.equal(obs(r, 4).proposals[0].committed_effect_verified, false);
  assert.equal(obs(r, 5)[0].role, "user");
  assert.deepEqual(r.binding.capture_gaps, []);
});
test("conflicting original source role or text is rejected even if redaction would make both appear identical", () => {
  for (const change of [
    { text: "A different fact" },
    { role: "assistant" as const },
  ]) {
    const c = capture(),
      item = c.snapshots[1].items[0];
    c.snapshots[1].items = [
      { ...item, sources: [{ ...item.sources[0], ...change }] },
    ];
    assert.throws(() => render(c), /CONFLICTING_SOURCE/);
  }
});
test("late or unverified applied effects cannot count as effective maintenance", () => {
  const c = capture(),
    a = c.proposals[0];
  Object.assign(a, {
    state: "DONE",
    effect: "APPLIED",
    committed: true,
    receipt_matches: true,
    fact_revision_matches: true,
  });
  assert.equal(obs(render(c), 4).proposals[0].committed_effect_verified, true);
  a.receipt_matches = false;
  assert.ok(
    render(c).binding.capture_gaps.includes("PROPOSAL_EFFECT_UNVERIFIED"),
  );
  a.sequence = 4;
  assert.deepEqual(obs(render(c), 4).proposals, []);
});
test("missing and truncated snapshots, source content, and absent first-request boundaries stay explicit", () => {
  const c = capture();
  c.first_request_sequence = null;
  c.snapshots[2] = {
    phase: "first-request",
    sequence: null,
    capture: "missing",
    items: [],
  };
  c.snapshots[0].capture = "truncated";
  c.snapshots[1].items = [
    {
      id: null,
      contents: null,
      sources: [{ id: null, text: null }],
      complete: false,
    },
  ];
  const r = render(c);
  assert.ok(
    [
      "MAINTENANCE_CAPTURE_INCOMPLETE",
      "ITEM_OR_SOURCE_UNAVAILABLE",
      "SOURCE_UNAVAILABLE",
      "PROPOSAL_BOUNDARY_UNAVAILABLE",
    ].every((g) => r.binding.capture_gaps.includes(g)),
  );
  assert.deepEqual(obs(r, 4).proposals, []);
});
test("rejects reversed boundaries, duplicate identities, oversized packets and secret-bearing evidence", () => {
  const c = capture();
  c.snapshots[1].sequence = 1;
  assert.throws(() => render(c), /CHRONOLOGY/);
  c.snapshots[1].sequence = 2;
  c.snapshots[0].items.push(c.snapshots[0].items[0]);
  assert.throws(() => render(c), /TARGETED_ITEM_ID/);
  c.snapshots[0].items.pop();
  c.snapshots[0].items[0].contents = "x".repeat(530000);
  assert.throws(() => render(c), /PACKET_TOO_LARGE/);
  c.snapshots[0].items[0].contents = "-----BEGIN FAKE PRIVATE KEY";
  assert.throws(() => render(c), /DISCLOSURE/);
});
test("new calibration contains 22 semantic and 6 visibility controls, and the native query contains only blind input", () => {
  const { packet, key } = targetedControls(),
    query = admittedReaderQuery(packet);
  assert.equal(key.length, 28);
  assert.equal(
    packet.controls.filter((c) => c.assertion === "visibility").length,
    6,
  );
  assert.equal(new Set(key.map((k) => k.id)).size, 28);
  assert.doesNotMatch(query, /"expected"\s*:/);
});
