import { setTimeout as delay } from "node:timers/promises";
import { requireThat } from "./io.ts";

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
      for (;;) {
        signal.throwIfAborted();
        requireThat(
          deadline !== undefined && deadline - Date.now() >= 45000,
          "C12B_SENDER_WINDOW_EXHAUSTED",
        );
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
