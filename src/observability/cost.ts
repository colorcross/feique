/**
 * Token cost estimation for backend runs.
 *
 * Default rates are approximate per-1M-token prices (USD).
 * These can be refined later via config; the point is to have
 * a reasonable default for dashboard / digest reporting.
 */

const RATES: Record<string, { input: number; output: number }> = {
  codex: { input: 2.0, output: 8.0 },
  claude: { input: 3.0, output: 15.0 },
};

/**
 * Estimate the USD cost for a single run based on token counts.
 * Returns `undefined` when there is no token data to work with.
 */
export function estimateCost(
  inputTokens?: number,
  outputTokens?: number,
  backend?: string,
): number | undefined {
  if (!inputTokens && !outputTokens) return undefined;
  const rate = RATES[backend ?? 'codex'] ?? RATES.codex!;
  return ((inputTokens ?? 0) * rate.input + (outputTokens ?? 0) * rate.output) / 1_000_000;
}
