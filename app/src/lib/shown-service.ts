/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which record a singleton service tab (the inbox, the mock server) shows.
 *
 * The tab's `entityId` addresses one record; an address the engine no longer
 * has, or none at all, falls back to the lowest port, because the engine lists
 * services in map order and port is the stable key a record carries. The tab
 * view and the tab's descriptor both ask this, so the line a tab menu copies
 * names the record the tab is showing.
 */
export function shownService<T extends { port: number }>(
	records: readonly T[],
	isAddressed: (record: T) => boolean
): T | null {
	const addressed = records.find(isAddressed);
	if (addressed) return addressed;
	return records.reduce<T | null>(
		(lowest, record) => (lowest === null || record.port < lowest.port ? record : lowest),
		null
	);
}
