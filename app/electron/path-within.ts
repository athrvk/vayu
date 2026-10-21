/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import path from "path";

/**
 * True when @p target is @p root or sits beneath it, by path component: root
 * `/a/b` admits `/a/b/c` and not `/a/bc`. Both paths are compared as given, so
 * a caller that must resist symlinks canonicalises them first.
 */
export function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}
