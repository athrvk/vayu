/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The retention sentence is a promise about the user's data, so every branch
 * that could state a wrong one is pinned here.
 *
 * The `0` case is the one worth the file. The engine reads
 * `trashRetentionDays: 0` as "never purge" - it returns before computing a
 * cutoff - so the plausible-looking reading, "deleted after 0 days", is exactly
 * backwards, and it would tell a user their trash empties itself when nothing
 * ever will.
 */

import { describe, it, expect } from "vitest";
import { retentionCopy, retentionDaysFrom, TRASH_RETENTION_KEY } from "./retention";
import type { ConfigEntry } from "@/types";

function entry(value: string, key = TRASH_RETENTION_KEY): ConfigEntry {
	return {
		key,
		value,
		type: "integer",
		label: "Trash retention",
		description: "",
		category: "data_retention",
		default: "30",
		requiresRestart: false,
		advanced: false,
		keywords: [],
		updatedAt: 0,
	};
}

describe("reading the window out of the config", () => {
	it("finds the entry by key", () => {
		expect(retentionDaysFrom([entry("14")])).toBe(14);
	});

	it("is null when the config has not arrived", () => {
		expect(retentionDaysFrom(undefined)).toBeNull();
	});

	it("is null when no entry carries the key, rather than assuming the default", () => {
		// An engine that stopped serving this key would otherwise have the app
		// stating a 30-day window it is no longer keeping.
		expect(retentionDaysFrom([entry("30", "maxBackupsRetained")])).toBeNull();
	});

	it("is null for a value that is not a number", () => {
		expect(retentionDaysFrom([entry("forever")])).toBeNull();
	});
});

describe("the sentence", () => {
	it("says nothing at all while the window is unknown", () => {
		// Absent beats wrong: the view drops the line rather than guessing.
		expect(retentionCopy(null)).toBeNull();
	});

	it("reads 0 as keep-forever, not as delete-immediately", () => {
		expect(retentionCopy(0)).toBe("Items are kept here until you delete them.");
	});

	it("reads a negative window the same way the engine does", () => {
		// `retention_days <= 0` returns early engine-side; anything below zero is
		// the same switch-off, not a window in the past.
		expect(retentionCopy(-1)).toBe("Items are kept here until you delete them.");
	});

	it("does not say '1 days'", () => {
		expect(retentionCopy(1)).toBe("Items are deleted for good a day after they land here.");
	});

	it("names the window it was given", () => {
		expect(retentionCopy(30)).toBe("Items are deleted for good 30 days after they land here.");
		expect(retentionCopy(7)).toBe("Items are deleted for good 7 days after they land here.");
	});
});
