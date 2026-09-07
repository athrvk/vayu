/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Pin the locale `Number#toLocaleString` groups digits in, for the length of a
 * test.
 *
 * A component that writes `count.toLocaleString()` follows the host: 998,000
 * on an en-US machine, 9,98,000 on an en-IN one, 998.000 on de-DE. An
 * assertion that spells one of those out is asserting where the suite ran,
 * not what the component did - `CLAUDE.md`'s platform rule, for locales - and
 * it turned red on the first en-IN checkout. Stubbing the formatter is what
 * lets a test name the grouping and still fail if the component stops
 * localising.
 */

import { vi } from "vitest";

/** Install the stub; returns the restore for `afterEach`. */
export function stubNumberLocale(locale: string): () => void {
	const format = new Intl.NumberFormat(locale);
	const spy = vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (
		this: number
	) {
		return format.format(Number(this));
	});
	return () => spy.mockRestore();
}
