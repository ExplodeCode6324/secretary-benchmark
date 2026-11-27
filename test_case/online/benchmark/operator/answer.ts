// Only a completed MAIN call owned by this handled input can supply its answer.
export function isAnswerMessage(
  input: { loop_id: string; updated_at: string },
  call: { completed_at?: string },
  context: { loop_id: string; purpose: string },
  message: { incomplete?: boolean; withdrawn?: boolean },
) {
  return (
    context.loop_id === input.loop_id &&
    context.purpose === "MAIN" &&
    !!call.completed_at &&
    call.completed_at <= input.updated_at &&
    !message.incomplete &&
    !message.withdrawn
  );
}

export function partitionAnswers(visible: any[], input: any, calls: any[]) {
  const fresh = new Map(calls.map((c) => [c.id, c]));
  const messages: any[] = [],
    otherMessages: any[] = [];
  for (const item of visible) {
    const call = fresh.get(item.call_id);
    const owned = call && isAnswerMessage(input, call, call.context, item);
    (owned ? messages : otherMessages).push(item);
  }
  return { messages, otherMessages };
}
