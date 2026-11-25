import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import { isDeepStrictEqual } from "node:util";
import type {
  Consciousness,
  ObjectRef,
} from "../../../sut/secretary/src/pi_secretary/src/contracts.ts";
import { sha, requireThat } from "./io.ts";
import type { snapshot } from "./snapshot.ts";

type Journal = ReturnType<typeof snapshot>;
type ReadObject = (ref: ObjectRef) => any;
type Sample = {
  job: string;
  revision: number;
  covered: number;
  items_sha256: string;
};
type Proof = {
  journal_digest: string;
  maintenance?: { samples: Sample[] };
  outcome: {
    probe_call: string | null;
    probe_input: string | null;
    probe_send: string | null;
    probe_payload: string | null;
  };
};
type Send = {
  id: string;
  at: string;
  payload: unknown;
  attribution: { role: string; context_sha256: string };
};
type Source = { id: string; text: string | null };

// Only conversation-visible message text enters a citation. Reasoning, signatures,
// credentials, system instructions and transport metadata are outside this view.
function citedMessages(value: any, read: ReadObject) {
  const encoded = !Array.isArray(value) && Array.isArray(value?.messages);
  const messages = encoded ? value.messages.map(read) : value;
  if (!Array.isArray(messages)) return null;
  const excerpts: { role: string; text: string }[] = [];
  for (const message of messages) {
    if (!["user", "assistant"].includes(message?.role)) continue;
    if (typeof message.content === "string") {
      excerpts.push({ role: message.role, text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text" && typeof part.text === "string")
          excerpts.push({ role: message.role, text: part.text });
      }
    }
  }
  return excerpts.length ? JSON.stringify(excerpts) : null;
}

function snapshotItems(memory: Consciousness, read: ReadObject) {
  return memory.items.map((item) => {
    const sources: Source[] = item.source_refs.map((ref) => ({
      id: ref.sha256,
      text: citedMessages(read(ref), read),
    }));
    const contents = JSON.stringify({
      tier: item.tier,
      summary: item.summary,
      goals: item.goals,
      constraints: item.constraints,
      decisions: item.decisions,
      open_questions: item.open_questions,
      unfulfilled_commitments: item.unfulfilled_commitments,
    });
    return {
      id: item.item_id || null,
      contents,
      sources,
      complete: Boolean(
        item.item_id && sources.length && sources.every((s) => s.text !== null),
      ),
    };
  });
}

function observedProposals(
  frames: Journal["transactions"],
  session: string,
  read: ReadObject,
) {
  const records = new Map<string, { sequence: number; operation: any }>();
  const events = new Map<string, any>();
  for (const [index, frame] of frames.entries()) {
    for (const e of frame.events) events.set(e.event_id, e);
    for (const op of frame.records)
      if (
        op.record_type === "Operation" &&
        op.action.action === "world.change" &&
        op.scope.session_id === session
      )
        records.set(op.id, { sequence: index + 1, operation: op });
  }
  return [...records.values()].map(({ sequence, operation: op }) => {
    const frame = frames[sequence - 1],
      batch = read(op.action.parameters_ref);
    const matches =
      batch.batch_id === op.action.intent_id &&
      op.action.parameters_hash === op.action.parameters_ref.sha256 &&
      op.action.resource === "world/batch/" + batch.batch_id &&
      Array.isArray(batch.changes);
    const edits: any[] = matches ? batch.changes : [];
    const ids = new Set<string>(
      edits.flatMap((edit) => edit.source_event_ids ?? []),
    );
    const sources = [...ids].map((id) => {
      const e = events.get(id);
      if (e?.event_type !== "input.accepted" || e.scope.session_id !== session)
        return { id, text: null };
      const payload = read(e.payload);
      // A source-event ID alone establishes no text. Resolve product input events to their message.
      const bound =
        payload.record_type === "Input" &&
        payload.session_id === session &&
        payload.producer === "MASTER" &&
        payload.payload?.media_type?.split(";")[0] === "text/plain";
      const text = bound ? read(payload.payload) : null;
      return { id, role: "user", text: typeof text === "string" ? text : null };
    });
    const receipt = op.receipt ? read(op.receipt) : null;
    const receiptMatches = Boolean(
      matches &&
      receipt?.status === "COMMITTED" &&
      receipt.batch_id === batch.batch_id &&
      frame.events.some(
        (e) =>
          e.event_type === "world.changed" &&
          isDeepStrictEqual(e.scope, op.scope) &&
          isDeepStrictEqual(read(e.payload), receipt),
      ) &&
      frame.events.some(
        (e) =>
          e.event_type === "operation.journal_applied" &&
          isDeepStrictEqual(e.scope, op.scope) &&
          isDeepStrictEqual(read(e.payload), op),
      ),
    );
    const world = frame.records.filter(
      (r) =>
        r.record_type === "WorldAssertion" || r.record_type === "WorldEntity",
    );
    const factMatches = Boolean(
      receiptMatches &&
      Array.isArray(receipt.result_ids) &&
      receipt.result_ids.length &&
      receipt.result_ids.every((id: string) =>
        world.some((r) => r.id === id),
      ) &&
      world.every((r) => receipt.result_ids.includes(r.id)) &&
      edits.every((edit, i) => {
        const change = stableID(batch.batch_id + ":change:" + i);
        const prior = world.find(
          (r) =>
            r.record_type === "WorldAssertion" && r.id === edit.target_fact_id,
        );
        if (edit.intent === "RETRACT")
          return (
            prior?.record_type === "WorldAssertion" &&
            prior.status === "RETRACTED"
          );
        if (edit.intent === "CREATE_ENTITY")
          return world.some(
            (r) =>
              r.record_type === "WorldEntity" &&
              r.id === stableID(change + ":entity") &&
              r.display_name === edit.display_name?.trim(),
          );
        if (!["ASSERT", "CORRECT"].includes(edit.intent)) return false;
        if (
          edit.intent === "CORRECT" &&
          (prior?.record_type !== "WorldAssertion" ||
            prior.status !== "SUPERSEDED")
        )
          return false;
        return world.some(
          (r) =>
            r.record_type === "WorldAssertion" &&
            r.change_id === change &&
            r.id === stableID(change + ":assertion") &&
            r.status === "LIVE" &&
            r.predicate_key === edit.predicate &&
            isDeepStrictEqual(r.evidence_event_ids, edit.source_event_ids) &&
            isDeepStrictEqual(r.value, edit.value) &&
            r.replaces_id === (edit.target_fact_id ?? null),
        );
      }),
    );
    const committed =
      op.state === "SUCCEEDED" &&
      op.effect === "APPLIED" &&
      receiptMatches &&
      factMatches;
    return {
      id: op.id,
      sequence,
      state: op.state,
      effect: op.effect,
      contents: matches
        ? JSON.stringify(
            edits.map((e) => ({
              intent: e.intent,
              display_name: e.display_name,
              topic: e.topic,
              predicate: e.predicate,
              value: e.value,
            })),
          )
        : null,
      sources,
      operation_matches: matches,
      receipt_matches: receiptMatches,
      fact_revision_matches: factMatches,
      committed,
    };
  });
}

/** Private, source-bound material for the independent targeted reader. Sequence numbers
 * are journal transactions (one-based). All state is clipped at the observed probe. */
export function targetedC16Capture(
  state: Journal,
  proof: Proof,
  sends: Send[],
  read: ReadObject,
) {
  requireThat(
    state.digest === proof.journal_digest,
    "C16_CAPTURE_JOURNAL_BINDING",
  );
  const frames = state.transactions;
  const calls = frames
    .flatMap((f) => f.records)
    .filter(
      (r) => r.record_type === "ModelCall" && r.id === proof.outcome.probe_call,
    );
  const call = calls.find(
    (c) => c.record_type === "ModelCall" && c.state === "PREPARED",
  );
  const send = sends.find((s) => s.id === proof.outcome.probe_send);
  requireThat(
    call?.record_type === "ModelCall" &&
      send &&
      send.attribution.role === "main" &&
      send.attribution.context_sha256 === call.request.sha256 &&
      sha(JSON.stringify(send.payload)) === proof.outcome.probe_payload,
    "C16_CAPTURE_PROBE_BINDING",
  );
  const session = call.scope.session_id;
  const ctx = frames
    .flatMap((frame, index) =>
      frame.events
        .filter(
          (e) =>
            e.event_type === "model.context" && e.scope.session_id === session,
        )
        .map((e) => ({ index, context: read(e.payload) })),
    )
    .filter(
      ({ context: c }) =>
        c.id === call.context_id &&
        c.call_id === call.id &&
        c.capture_kind === "MODEL_REQUEST" &&
        c.purpose === "MAIN" &&
        c.input_ids.includes(proof.outcome.probe_input),
    );
  requireThat(ctx.length === 1 && session, "C16_CAPTURE_CONTEXT_BINDING");
  const firstSequence = ctx[0].index + 1;
  const prefix = frames.slice(0, firstSequence - 1);
  const samples = proof.maintenance?.samples ?? [];
  requireThat(
    samples.length === 2 &&
      samples[0].job !== samples[1].job &&
      samples[0].covered < samples[1].covered,
    "C16_CAPTURE_COMMIT_GAPS",
  );
  const views = samples.map((sample, i) => {
    const matches = prefix.flatMap((frame, index) => {
      if (
        !frame.records.some(
          (r) =>
            r.record_type === "CompactionJob" &&
            r.id === sample.job &&
            r.state === "COMMITTED" &&
            r.mode === "WORKING_MEMORY" &&
            r.session_id === session,
        )
      )
        return [];
      return frame.records
        .filter(
          (r) =>
            r.record_type === "Consciousness" &&
            r.last_job_id === sample.job &&
            r.session_id === session &&
            r.revision === sample.revision &&
            r.covered_event_sequence === sample.covered &&
            sha(JSON.stringify(r.items)) === sample.items_sha256,
        )
        .map((memory) => ({
          sequence: index + 1,
          memory: memory as Consciousness,
        }));
    });
    requireThat(matches.length === 1, "C16_CAPTURE_COMMIT_BINDING");
    return { phase: i === 0 ? "commit-1" : "commit-2", ...matches[0] };
  });
  const effective = prefix
    .flatMap((f) => f.records)
    .findLast(
      (r) => r.record_type === "Consciousness" && r.session_id === session,
    );
  requireThat(
    views[0].sequence < views[1].sequence &&
      views[1].sequence < firstSequence &&
      effective?.record_type === "Consciousness",
    "C16_CAPTURE_BOUNDARY_ORDER",
  );
  views.push({
    phase: "first-request",
    sequence: firstSequence,
    memory: effective,
  });
  const snapshots = views.map(({ phase, sequence, memory }) => {
    const items = snapshotItems(memory, read);
    return {
      phase,
      sequence,
      capture: items.every((i) => i.complete) ? "complete" : "missing",
      items,
    };
  });
  const proposals = observedProposals(prefix, session, read);
  return {
    schema: "issue122-c16-capture-v1",
    first_request_sequence: firstSequence,
    snapshots,
    proposals,
    proposal_capture: proposals.every(
      (p) =>
        p.operation_matches &&
        (p.effect !== "APPLIED" ||
          (p.committed &&
            p.sources.length > 0 &&
            p.sources.every((s) => s.text !== null))),
    )
      ? "complete"
      : "missing",
  };
}
