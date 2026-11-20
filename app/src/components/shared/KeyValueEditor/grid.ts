/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The key/value table's column track, in one place.
 *
 * The header band, every row and the request builder's read-only "Added by
 * Vayu" rows must share it or their columns drift apart (#2071). The leading
 * column reads the `target` floor (issue #1679) rather than a literal 24px, so
 * it grows to 28px at Comfortable along with the checkbox inside it. Tailwind
 * finds these by scanning source, so each stays a complete literal.
 *
 * Its own module rather than `index.tsx`: the row imports the track and the
 * editor imports the row.
 */

/** Enable checkbox, key, value, then the two trailing slots. */
export const KEY_VALUE_GRID =
	"grid-cols-[var(--spacing-target)_1fr_1fr_var(--spacing-target)_28px]";

/** `KEY_VALUE_GRID` plus the form-data text/file toggle column. */
export const KEY_VALUE_GRID_WITH_FILES =
	"grid-cols-[var(--spacing-target)_1fr_1fr_var(--spacing-target)_var(--spacing-target)_28px]";

/** `KEY_VALUE_GRID` plus a caller's per-row control column (`rowExtra`). */
export const KEY_VALUE_GRID_WITH_EXTRA =
	"grid-cols-[var(--spacing-target)_1fr_1fr_7rem_var(--spacing-target)_28px]";

/**
 * Both the toggle and a per-row control column. The extra track is a share of
 * the row, not a fixed width: at the default window the request pane is about
 * 530px and a fixed 14rem left key and value 65px each (#3690).
 */
export const KEY_VALUE_GRID_WITH_FILES_AND_EXTRA =
	"grid-cols-[var(--spacing-target)_1fr_1fr_var(--spacing-target)_minmax(6rem,0.6fr)_var(--spacing-target)_28px]";

/**
 * The extra column is opt-in, so a table that passes no `rowExtra` keeps the
 * track it always had. It sits after the value (after the toggle, where there
 * is one) and before the two trailing slots.
 */
export const keyValueGrid = (allowFiles: boolean, hasExtra = false): string => {
	if (allowFiles)
		return hasExtra ? KEY_VALUE_GRID_WITH_FILES_AND_EXTRA : KEY_VALUE_GRID_WITH_FILES;
	return hasExtra ? KEY_VALUE_GRID_WITH_EXTRA : KEY_VALUE_GRID;
};
