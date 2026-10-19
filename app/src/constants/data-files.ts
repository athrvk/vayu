/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Seeds for the two engine caps on a run's data set, mirroring
 * `constants::scenario` engine-side.
 *
 * These are **not** the rule - `maxScenarioDataRows` and `maxScenarioDataBytes`
 * are engine settings a user can raise, and the live values come from the
 * config query via {@link useDataFileLimits}. A renderer that hardcoded its own
 * copy would refuse a file the engine had just been told to accept. These stand
 * in only until that query resolves, and they are the numbers the engine seeds,
 * so the gap changes nothing.
 */
export const DATA_FILE_MAX_ROWS = 1000;

/** Seed for `maxScenarioDataBytes` - 16 MiB, as the engine seeds it. */
export const DATA_FILE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Deepest a data cell may nest, mirroring `constants::spec_document::MAX_READ_DEPTH`
 * engine-side (#2362). A fixed bound, not a setting: the engine's reader walks a
 * cell recursively, so the picker refuses at the same depth and names the row
 * instead of letting the run fail on its first iteration.
 * `data-files.engine-parity.test.ts` pins the two together.
 */
export const DATA_FILE_MAX_NESTING = 100;
