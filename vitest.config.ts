import { defineConfig } from 'vitest/config';

/**
 * Vitest config tuned for the bridge-service / collaboration-e2e suites.
 *
 * Background: those two files are end-to-end style tests built around a
 * shared `runCodexTurnMock` (a vi.fn()) and `FeiqueService` instances that
 * spin up real SQLite stores in temp dirs. They were running into two
 * recurring failure modes on the default 5s testTimeout:
 *
 *   1. genuine timeouts when the system was under load (esbuild transform,
 *      sqlite open) — the test logic is fine but the per-test setup eats
 *      most of the budget
 *   2. race conditions in `waitFor(() => expect(spy).toHaveBeenCalledTimes(N))`
 *      where the next promise tick happens after the timeout
 *
 * Bumping `testTimeout` to 15s and `hookTimeout` to 15s eliminates (1) and
 * widens the race window enough to make (2) effectively never trigger in
 * practice. We do not enable `singleFork` because the suite is happy with
 * Vitest's default worker pool — the issue was wall-clock budget, not
 * worker contention.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
