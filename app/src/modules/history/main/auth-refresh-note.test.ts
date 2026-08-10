/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { authRefreshNote } from "./auth-refresh-note";

describe("authRefreshNote", () => {
	// The absent section is a run that could not refresh at all - it must read
	// exactly as every run did before mid-run refresh existed.
	it("says nothing for a run that could not refresh", () => {
		expect(authRefreshNote(undefined)).toBeNull();
	});

	// A watched run that never needed a refresh has nothing to report either -
	// the section exists, and is empty.
	it("says nothing when the run was watched and never renewed", () => {
		expect(authRefreshNote({ refreshes: [], refreshFailures: 0 })).toBeNull();
	});

	it("names when a single refresh landed", () => {
		const note = authRefreshNote({ refreshes: [{ atSeconds: 3600 }], refreshFailures: 0 });
		expect(note).toEqual({ text: "Access token refreshed at 1h 0m", warning: false });
	});

	it("counts and lists repeated refreshes", () => {
		const note = authRefreshNote({
			refreshes: [{ atSeconds: 60 }, { atSeconds: 120.4 }],
			refreshFailures: 0,
		});
		expect(note?.text).toBe("Access token refreshed 2 times (1m 0s, 2m 0s)");
		expect(note?.warning).toBe(false);
	});

	// The case that leaves 401s unexplained: the run kept going on a credential
	// it could not renew, so the note carries the reason and reads as a warning.
	it("reports a failure with its reason and warns", () => {
		const note = authRefreshNote({
			refreshes: [],
			refreshFailures: 1,
			lastError: "oauth2_provider_error: invalid_grant",
		});
		expect(note).toEqual({
			text: "1 refresh failure - oauth2_provider_error: invalid_grant",
			warning: true,
		});
	});

	it("reports refreshes and failures together", () => {
		const note = authRefreshNote({
			refreshes: [{ atSeconds: 3600 }],
			refreshFailures: 2,
			lastError: "oauth2_network_error: timed out",
		});
		expect(note?.text).toBe(
			"Access token refreshed at 1h 0m; 2 refresh failures - oauth2_network_error: timed out"
		);
		expect(note?.warning).toBe(true);
	});
});
