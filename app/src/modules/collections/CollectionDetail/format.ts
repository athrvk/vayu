/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Timestamp formatting for CollectionDetail tabs. Separate from `shared.tsx`,
 * which exports components: a module holding both cannot be hot-reloaded.
 */

export function formatRelative(iso: string | undefined): string {
	if (!iso) return "-";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "-";
	const diffMs = Date.now() - then;
	const sec = Math.floor(diffMs / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mo = Math.floor(day / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.floor(mo / 12)}y ago`;
}
