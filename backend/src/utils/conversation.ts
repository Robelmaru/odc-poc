/**
 * Validate and bound untrusted conversation history before it is forwarded to
 * Claude (finding TS-011). Caps the number of turns and per-message length, and
 * drops anything that is not a well-formed user/assistant string message — so a
 * client cannot drive unbounded token spend or inject an unexpected role.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const MAX_MESSAGES = 20; // ~10 exchanges
const MAX_CONTENT_CHARS = 8000;

export function sanitizeConversationHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if (
      (role === "user" || role === "assistant") &&
      typeof content === "string" &&
      content.length
    ) {
      out.push({ role, content: content.slice(0, MAX_CONTENT_CHARS) });
    }
  }
  return out;
}
