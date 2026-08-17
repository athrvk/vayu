/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `maxScenarioDataRows`, as every surface that reads a data file states it
 * (issue #751).
 *
 * The comparison and the sentence live together because they were about to live
 * apart: the picker refused a hand-picked file over the cap, and the three
 * surfaces that re-read a *remembered* path refused nothing at all, so a file
 * that grew past the setting previewed cleanly and died at `POST /runs` with the
 * `400` the picker exists to move earlier. A second copy of the message is how
 * the two drift, and a second copy of the `>` is how one of them ends up
 * off-by-one, so neither is copied.
 *
 * The number itself is **never** hardcoded by a caller: it is the engine setting
 * a user can raise, fetched through `useDataFileLimits`. See
 * `constants/data-files.ts` for why the seed there is not the rule.
 *
 * The byte cap has no equivalent here because its two checks read different
 * things - the picker stats the `File` before reading it, the main process stats
 * the path before opening it (`electron/data-file.ts`) - and neither has a
 * parsed file in hand.
 */

/**
 * The refusal for a data set over `maxRows`, or `null` when it fits.
 *
 * Returning the message rather than throwing keeps it usable by the picker,
 * which has an `onError` slot and no catch to fall into.
 */
export function describeRowCapRefusal(rowCount: number, maxRows: number): string | null {
	if (rowCount <= maxRows) return null;
	return `The file has ${rowCount} rows, over the ${maxRows} a run may carry. Raise the maxScenarioDataRows engine setting, or split the file.`;
}
