import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { benchmarkRoleModel, type descriptor } from "./live-model.ts";

export async function runStageProbe(
  model: ReturnType<typeof descriptor>,
  key: string,
  tier?: "default",
) {
  const config = benchmarkRoleModel(model, key, "main", tier);
  const response = await (
    await config.stream(
      model,
      normalizeContext({
        messages: [
          { role: "user", content: "Reply with READY.", timestamp: Date.now() },
        ],
      }),
      { maxTokens: 128, signal: AbortSignal.timeout(30000) },
    )
  ).result();
  return !["error", "aborted"].includes(response.stopReason);
}
