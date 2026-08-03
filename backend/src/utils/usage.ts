import { logger } from "./logger.js";

/**
 * Log Claude token usage for cost tracking (finding OPS-003). Call after each
 * Anthropic message create. `usage` may be undefined on some response shapes.
 */
export function logTokenUsage(
  operation: string,
  usage: { input_tokens: number; output_tokens: number } | undefined,
): void {
  if (!usage) return;
  logger.info("claude_usage", {
    operation,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  });
}
