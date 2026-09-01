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
import { buildExecBody, execIdentity, responseFromExecuteResult } from "./execute-mapping";
// The threshold itself, not a second spelling of it: the mapping and the pane
// share one number and a test that pinned its own would keep passing after a
// change made the gate unreachable.
import { LARGE_BODY_BYTES } from "@/components/shared/response-viewer/utils";
import { createDefaultRequestState } from "./request-state";
import type { SanityResult } from "@/types";
import type { KeyValueItem } from "@/types";
import type { RequestState } from "../types";

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

	it("carries the engine's body cap onto the response state", () => {
		// Without this the pane can never say the engine read only part of the
		// body, and a re-send-to-fix notice would be the only thing on screen.
		const mapped = responseFromExecuteResult(result({ bodyCapped: true }));

		expect(mapped.bodyCapped).toBe(true);
	});
});

/**
 * The mapping used to build a second, indented copy of every body - the one the
 * Pretty view reads - on the main thread, on the send path. Above
 * `LARGE_BODY_BYTES` the pane never formats anything (`ResponseBody` shows a raw
 * prefix instead), so that copy was multi-megabyte work whose output nothing
 * rendered.
 *
 * The sub-threshold half of this is an acceptance criterion, not a nicety: the
 * gate must be invisible for every body anyone actually reads.
 */
describe("responseFromExecuteResult, on a large body", () => {
	/** A parsed body whose raw form is `bytes` characters, near enough. */
	function jsonOfLength(bytes: number) {
		const parsed = { pad: "x".repeat(bytes) };
		const raw = JSON.stringify(parsed);
		return { parsed, raw };
	}

	it("hands back the raw string rather than an indented copy", () => {
		const { parsed, raw } = jsonOfLength(LARGE_BODY_BYTES + 1024);

		const mapped = responseFromExecuteResult(
			result({ body: parsed, bodyRaw: raw, bodySize: raw.length })
		);

		expect(mapped.body).toBe(raw);
		// The distinguishing evidence: `JSON.stringify(x, null, 2)` of an object
		// always contains a newline, and the raw string never does.
		expect(mapped.body).not.toContain("\n");
	});

	it("leaves a body under the threshold byte-identical to the indented copy", () => {
		const { parsed, raw } = jsonOfLength(1024);

		const mapped = responseFromExecuteResult(
			result({ body: parsed, bodyRaw: raw, bodySize: raw.length })
		);

		expect(mapped.body).toBe(JSON.stringify(parsed, null, 2));
		expect(mapped.bodyRaw).toBe(raw);
	});

	it("leaves a large string body alone - it was never a second copy", () => {
		// The gate belongs to the object branch only. A string body is already
		// the string the pane shows, so swapping in `bodyRaw` here would change
		// what is displayed to save work that was never being done.
		const text = "y".repeat(LARGE_BODY_BYTES + 1024);

		const mapped = responseFromExecuteResult(
			result({ body: text, bodyRaw: "DIFFERENT", bodySize: text.length })
		);

		expect(mapped.body).toBe(text);
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

/**
 * The form modes are a contract with the engine, not a renderer-local
 * convention: `deserialize_request` (engine/src/utils/json.cpp) keys off these
 * exact strings and reads the content out of `fields`. It matched neither
 * spelling until issue #381, and read no `fields` at all, so every form body
 * this builder produced went out empty. These assertions are deliberately
 * literal - a "tidier" mode string here is a silently empty request there.
 */
describe("buildExecBody form modes", () => {
	const engineFormModes = ["form-data", "x-www-form-urlencoded"] as const;

	function stateWith(overrides: Partial<RequestState>): RequestState {
		return { ...createDefaultRequestState(), ...overrides };
	}

	function row(key: string, value: string, enabled = true): KeyValueItem {
		return { id: `${key}-row`, key, value, enabled };
	}

	it.each(engineFormModes)("sends %s as fields, not content", (mode) => {
		const rows = [row("name", "ada"), row("off", "x", false)];
		const request = stateWith(
			mode === "form-data"
				? { bodyMode: mode, formData: rows }
				: { bodyMode: mode, urlEncoded: rows }
		);

		const body = buildExecBody(request, (s) => s);

		expect(body).toEqual({
			mode,
			// Disabled rows travel: the engine drops them at the wire, so
			// toggling one back on needs no re-compose.
			fields: [
				{ key: "name", value: "ada", enabled: true },
				{ key: "off", value: "x", enabled: false },
			],
		});
		expect(body).not.toHaveProperty("content");
	});

	it("sends a file part as its path, never as a value", () => {
		const request = stateWith({
			bodyMode: "form-data",
			formData: [
				row("caption", "hi"),
				{
					id: "file-row",
					key: "avatar",
					value: "",
					enabled: true,
					type: "file",
					src: "/tmp/a.png",
					fileName: "profile.png",
					contentType: "image/png",
					// An editor annotation about where the path came from - the
					// engine's answer to a path it cannot open is the same either
					// way, so it must not ride along on the payload.
					unresolved: true,
				},
			],
		});

		const body = buildExecBody(request, (s) => s);

		expect(body?.fields).toEqual([
			{ key: "caption", value: "hi", enabled: true },
			{
				key: "avatar",
				value: "",
				enabled: true,
				type: "file",
				src: "/tmp/a.png",
				fileName: "profile.png",
				contentType: "image/png",
			},
		]);
	});

	it("resolves variables inside a file part's path, name and type", () => {
		const request = stateWith({
			bodyMode: "form-data",
			formData: [
				{
					id: "file-row",
					key: "avatar",
					value: "",
					enabled: true,
					type: "file",
					src: "{{dir}}/a.{{ext}}",
					fileName: "a.{{ext}}",
					contentType: "image/{{ext}}",
				},
			],
		});

		// Plain substitution, not a pattern: `variable-pattern-single-source`
		// guards against a second `{{`-matching regex anywhere in the tree.
		const body = buildExecBody(request, (s) =>
			s.split("{{dir}}").join("/data").split("{{ext}}").join("png")
		);

		expect(body?.fields).toEqual([
			{
				key: "avatar",
				value: "",
				enabled: true,
				type: "file",
				src: "/data/a.png",
				fileName: "a.png",
				contentType: "image/png",
			},
		]);
	});

	it("resolves variables inside field keys and values", () => {
		const request = stateWith({
			bodyMode: "x-www-form-urlencoded",
			urlEncoded: [row("{{k}}", "{{v}}")],
		});

		const body = buildExecBody(request, (s) =>
			s.replace("{{k}}", "key").replace("{{v}}", "val")
		);

		expect(body?.fields).toEqual([{ key: "key", value: "val", enabled: true }]);
	});
});
