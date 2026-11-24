import { isDeepStrictEqual as same } from "node:util";
import type { Operation } from "../../../sut/secretary/src/pi_secretary/src/contracts.ts";
import type { RecoveryProof } from "./snapshot.ts";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import { requireThat, sha } from "./io.ts";

// This is a read-only proof for an in-place restart. No approval is created or consumed.
export function verifyPendingWorld(
  op: Operation,
  proof: RecoveryProof,
  domain: string,
) {
  const records = proof.transactions.flatMap((t) => t.records);
  const ids = records.filter((r) => r.record_type === "CoreIdentity");
  const auths = records.filter(
    (r) =>
      r.record_type === "AuthorizationRequest" &&
      (r.id === op.authorization_id || r.operation_id === op.id),
  );
  const auth = auths[0];
  requireThat(
    ids.length > 0 &&
      ids.every(
        (r) => r.record_type === "CoreIdentity" && r.owner_id === domain,
      ) &&
      auths.length === 1 &&
      auth?.record_type === "AuthorizationRequest" &&
      auth.id === op.authorization_id &&
      auth.operation_id === op.id &&
      auth.state === "PENDING" &&
      auth.revision === 1 &&
      auth.decision_id === null &&
      auth.decided_at === null &&
      auth.decided_by === null &&
      auth.consumed_at === null &&
      typeof auth.expires_at === "string" &&
      Date.parse(auth.expires_at) > Date.now() &&
      same(auth.scope, op.scope) &&
      same(auth.action, op.action) &&
      auth.display_hash === auth.display_ref.sha256,
    "C16_PENDING_AUTHORIZATION_UNPROVEN",
  );
  requireThat(
    op.action.action === "world.change" &&
      op.state === "WAIT_AUTH" &&
      op.effect === "NOT_STARTED" &&
      op.receipt === null &&
      !op.process &&
      op.error === null &&
      op.revision === 1 &&
      op.retry_of === null &&
      op.attempt_id === null &&
      op.rule_id === null &&
      op.rule_revision === null &&
      op.scope.task_id === null &&
      op.scope.execution_id === null &&
      records.some(
        (r) => r.record_type === "Session" && r.id === op.scope.session_id,
      ) &&
      proof.history.get(op.id)?.length === 1 &&
      op.action.parameters_hash === op.action.parameters_ref.sha256,
    "C16_PENDING_OPERATION_UNPROVEN",
  );
  const batch = proof.value(op.action.parameters_ref);
  requireThat(
    batch.version === 1 &&
      Array.isArray(batch.changes) &&
      batch.changes.length > 0 &&
      typeof batch.batch_id === "string" &&
      batch.batch_id === op.action.intent_id &&
      op.action.resource === "world/batch/" + batch.batch_id &&
      same(proof.value(auth.display_ref), {
        scope: op.scope,
        action: op.action,
        parameters: batch,
      }),
    "C16_PENDING_WORLD_BATCH_UNPROVEN",
  );
  const created = proof.transactions.find(
    (t) => t.records.includes(auth) && t.records.some((r) => same(r, op)),
  );
  const prepared = { ...op, state: "PREPARED", authorization_id: null };
  requireThat(
    created &&
      created.events.some(
        (e) =>
          e.event_type === "operation.prepared" &&
          same(e.scope, op.scope) &&
          same(proof.value(e.payload), prepared),
      ) &&
      created.events.some(
        (e) =>
          e.event_type === "authorization.requested" &&
          same(e.scope, op.scope) &&
          same(proof.value(e.payload), auth),
      ),
    "C16_PENDING_WORLD_CREATION_UNPROVEN",
  );
  const index = proof.transactions.indexOf(created);
  const results = proof.transactions
    .slice(index + 1)
    .flatMap((t) => t.events)
    .filter(
      (e) =>
        e.event_type === "main.tool.result" &&
        e.actor === "MAIN" &&
        same(e.scope, op.scope),
    )
    .map((e) => proof.value(e.payload))
    .filter(
      (p) =>
        typeof p.key === "string" &&
        stableID(stableID(p.key) + ":world-batch") === batch.batch_id,
    );
  requireThat(results.length === 1, "C16_PENDING_TOOL_RESULT_UNPROVEN");
  const [loop, position, toolId, name, argsHash] = results[0].key.split(":");
  const receipt = JSON.parse(results[0].result.content[0].text);
  requireThat(
    name === "memory_propose_change" &&
      /^\d+$/.test(position) &&
      receipt.operation_id === op.id &&
      receipt.authorization_id === auth.id &&
      receipt.batch_id === batch.batch_id &&
      receipt.status === "PENDING" &&
      receipt.error === null &&
      receipt.result === null,
    "C16_PENDING_TOOL_RESULT_UNPROVEN",
  );
  const before = proof.transactions.slice(0, index).flatMap((t) => t.records);
  const model = before.some(
    (call) =>
      call.record_type === "ModelCall" &&
      call.state === "RESPONSE_SAVED" &&
      call.response &&
      same(call.scope, op.scope) &&
      before.some(
        (ctx) =>
          ctx.record_type === "Context" &&
          ctx.id === call.context_id &&
          ctx.call_id === call.id &&
          ctx.loop_id === loop &&
          ctx.session_id === op.scope.session_id &&
          ctx.purpose === "MAIN",
      ) &&
      proof
        .value(call.response)
        .content?.some(
          (part: any) =>
            part.type === "toolCall" &&
            part.id === toolId &&
            part.name === name &&
            sha(JSON.stringify(part.arguments)) === argsHash,
        ),
  );
  requireThat(model, "C16_PENDING_MODEL_PROVENANCE");
  const effects = proof.transactions
    .flatMap((t) => t.events)
    .filter((e) =>
      [
        "authorization.decided",
        "operation.dispatched",
        "operation.journal_applied",
        "world.changed",
        "world.batch_failed",
      ].includes(e.event_type),
    );
  requireThat(
    !effects.some((e) => {
      const v = proof.value(e.payload);
      return [
        v.id,
        v.operation_id,
        v.batch_id,
        v.authorization_id,
        v.result?.operation_id,
        v.command?.authorization_id,
        ...(e.related_object_ids ?? []),
      ].some((id) => [op.id, auth.id, batch.batch_id].includes(id));
    }),
    "C16_PENDING_HAS_EFFECT",
  );
}
