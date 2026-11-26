import { setTimeout as delay } from "node:timers/promises";
import { retestWorkload } from "./stage-c-targeted-policy.ts";
import { SenderWindowError } from "./stage-c-continuation.ts";

/** Owned by one worker incarnation. The synchronous write hook never waits for a promise. */
export function recoverySender(
  settled: () => boolean,
  taskActive: () => boolean,
) {
  let admitting = false;
  const gate = {
    writing: false,
    check: () => !admitting && settled(),
    async admit<T>(
      signal: AbortSignal,
      role: string,
      deadline: number | undefined,
      action: () => Promise<T>,
    ) {
      const waitStarted = Date.now();
      for (;;) {
        signal.throwIfAborted();
        if (deadline === undefined || deadline - Date.now() < retestWorkload.response_headroom_ms + retestWorkload.quota_read_timeout_ms)
          throw new SenderWindowError(gate.writing ? "WRITE_BARRIER" : admitting ? "ADMISSION_IN_PROGRESS" : !settled() ? "IN_FLIGHT_RESERVATION" : role !== "task" && taskActive() ? "SAVED_WRITE_EXECUTOR" : "INSUFFICIENT_DEADLINE", waitStarted);
        if (!gate.writing && gate.check() && (role === "task" || !taskActive()))
          break;
        await delay(25, undefined, { signal });
      }
      admitting = true;
      try {
        return await action();
      } finally {
        admitting = false;
      }
    },
  };
  return gate;
}
