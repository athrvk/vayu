/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The suite's wall-clock budgets, in one place: `vitest.config.ts` reads the
 * per-test and hook budgets, `setup.ts` the Testing Library wait.
 *
 * A budget here detects a hang. It does not measure speed. A test's cost on
 * a developer's idle machine says little about its cost on a CI runner: the
 * Windows legs run the suite 3-4x slower, and a full parallel run on four cores
 * measured cases at 6x the figure their own comments recorded idle. Budgets
 * sized on the idle figure (vitest's 5s default, Testing Library's 1s, the
 * hand-picked 10-20s overrides) failed healthy runs on every leg and cost a
 * re-run each time. A healthy case never comes near these; a hung one reports
 * within a minute. Render cost is held down by the fixture-size rule in
 * `app/CLAUDE.md`, not by the clock.
 *
 * `timeouts.guard.test.ts` refuses a numeric `timeout:` in a test file, so a
 * case cannot quietly go back to a budget sized on one machine.
 */

/** Every case, and every `beforeEach`/`afterEach`/`beforeAll`/`afterAll`. */
export const TEST_TIMEOUT_MS = 60_000;

/**
 * `waitFor` / `findBy*`. Under {@link TEST_TIMEOUT_MS} so a wait that never
 * succeeds reports its own last error rather than a bare test timeout.
 */
export const ASYNC_UTIL_TIMEOUT_MS = 15_000;

/**
 * The few cases that do a whole build or bundle (`monaco-setup.contributions`),
 * measured at 22s on a loaded Linux box, so a Windows runner can need minutes.
 */
export const BUILD_TEST_TIMEOUT_MS = 300_000;
