import { Buffer } from "node:buffer";

const EXCLUDED = new Set(["pi-goal-context", "pi-goal-feedback", "pi-goal-update"]);
const MARKER = "\n[truncated]\n";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** No provider tokenizer is exposed by Pi. UTF-8 JSON bytes are a conservative
 * proxy, not an exact token count; reserve 20% plus 1024 for framing/output.
 * Keep the complete Goal/questions, and spend the rest on newest visible data.
 * Does not change persisted history, the chat context, provider, or credentials.
 */
export function buildClassifierContext(goal: string, messages: readonly any[], questions: any,
  model: { contextWindow?: number }) {
  const advertised = model.contextWindow;
  const known = typeof advertised === "number" && Number.isFinite(advertised) && advertised >= 1;
  const contextWindow = known ? Math.floor(advertised) : 8192;
  // Large-context models must not silently expand the old evidence/cost ceiling.
  const budgetBytes = Math.max(0, Math.min(60_000, Math.floor(contextWindow * 0.8) - 1024));
  const recent: { role: string; toolName?: string; isError?: boolean; text: string }[] = [];
  // Budget using false (one byte longer than true) throughout construction.
  const state = { goal, recent, possiblyTruncated: false };
  const context = { state, questions };
  const requiredBytes = bytes(context);
  if (requiredBytes > budgetBytes) {
    throw new Error(`Goal classifier input budget exceeded locally: complete Goal/questions require ${requiredBytes} UTF-8 JSON bytes; budget ${budgetBytes} from contextWindow ${contextWindow}. Goal retained unchanged; no API request sent. Use a classifier with a larger context or explicitly shorten the Goal.`);
  }
  let omittedMessages = 0, truncatedMessages = 0;
  for (const message of [...messages].reverse()) {
    if (EXCLUDED.has(message.customType)) continue;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    const visible = blocks.flatMap((b: any) => b.type === "text" ? [b.text] :
      b.type === "toolCall" ? [`toolCall ${b.name}: ${JSON.stringify(b.arguments)}`] : []);
    const text = visible.join("\n") || (typeof message.summary === "string" ? message.summary : "");
    if (!text) continue;
    const row = { role: typeof message.role === "string" ? message.role.slice(0, 64) : "unknown",
      ...(typeof message.toolName === "string" ? { toolName: message.toolName.slice(0, 128) } : {}),
      ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}), text };
    const fits = (candidate: string) => {
      row.text = candidate;
      recent.unshift(row);
      const accepted = bytes(candidate) <= 8192 && bytes(context) <= budgetBytes;
      recent.shift();
      return accepted;
    };
    if (!fits(text)) {
      // Count Unicode code points, not UTF-16 code units; never split emoji.
      const points = Array.from(text);
      const clipped = (n: number) => points.slice(0, Math.ceil(n / 2)).join("") + MARKER +
        (n > 1 ? points.slice(-Math.floor(n / 2)).join("") : "");
      let low = 1, high = Math.min(points.length - 1, 8192), keep = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (fits(clipped(mid))) { keep = mid; low = mid + 1; }
        else high = mid - 1;
      }
      if (!keep) { omittedMessages++; continue; }
      row.text = clipped(keep);
      truncatedMessages++;
    }
    recent.unshift(row);
  }
  state.possiblyTruncated = omittedMessages > 0 || truncatedMessages > 0;
  return { context, inputBudget: { contextWindow, limitSource: known ? "catalog" : "fallback",
    budgetBytes, requestBytes: bytes(context), includedMessages: recent.length,
    omittedMessages, truncatedMessages, possiblyTruncated: state.possiblyTruncated } };
}
