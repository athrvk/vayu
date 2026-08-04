/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `serialize(Response)` (engine/src/utils/json.cpp) has put `httpVersion` on
 * the `POST /execute` response since the engine started recording the
 * negotiated protocol, but `responseFromExecuteResult` never read it - the
 * "written but never read" pattern this codebase keeps tripping on. Without
 * this mapping, `ResponseState.httpVersion` is permanently `undefined` for a
 * live send, and the Raw tab's status line can never show anything but its
 * HTTP/1.1 default, negotiated protocol notwithstanding.
 */

import { describe, it, expect } from "vitest";
import { execIdentity, responseFromExecuteResult } from "./execute-mapping";
import { createDefaultRequestState } from "./request-state";
import type { SanityResult } from "@/types";

function result(overrides: Partial<SanityResult> = {}): SanityResult {
	return {
		status: 200,
		statusText: "OK",
		headers: {},
		body: "",
		bodyRaw: "",
		bodySize: 0,
		timing: {
			totalMs: 10,
			dnsMs: 0,
			connectMs: 0,
			tlsMs: 0,
			firstByteMs: 0,
			downloadMs: 0,
		},
		...overrides,
	};
}

describe("responseFromExecuteResult", () => {
	it("carries the negotiated protocol onto the response state", () => {
		const mapped = responseFromExecuteResult(result({ httpVersion: "HTTP/2" }));

		expect(mapped.httpVersion).toBe("HTTP/2");
	});

	it("carries the empty-negotiation marker through as-is, not defaulted here", () => {
		// Defaulting to HTTP/1.1 is buildRawResponse's job, not this mapping's -
		// see its doc comment for why "" is meaningfully different from omitted.
		const mapped = responseFromExecuteResult(result({ httpVersion: "" }));

		expect(mapped.httpVersion).toBe("");
	});
});

/**
 * `pm.info.requestName` (issue #300) has a client-side half: Send composes and
 * executes *editor state*, so an unsaved request - which has a name and no
 * stored row to look one up in - would leave the field permanently undefined
 * if the renderer did not send it. The engine's own fallback only fires for a
 * payload that names a saved `requestId`.
 */
describe("execIdentity", () => {
	it("sends the name for an unsaved request", () => {
		// id null is what "unsaved" is: no row exists for the engine to read.
		const request = createDefaultRequestState();
		expect(request.id).toBeNull();

		expect(execIdentity(request)).toEqual({ requestName: "Untitled Request" });
	});

	it("omits the field entirely for an unnamed request", () => {
		// Absent, not "": a script's `typeof pm.info.requestName` check has to
		// be able to tell "no name" from a name that happens to be empty.
		const request = { ...createDefaultRequestState(), name: "" };

		expect(execIdentity(request)).toEqual({});
		expect("requestName" in execIdentity(request)).toBe(false);
	});
});
