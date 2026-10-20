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
import {
	buildExecBody,
	disabledDefaults,
	execIdentity,
	protocolSettings,
	responseFromExecuteResult,
	toBodyPayload,
} from "./execute-mapping";
// The threshold itself, not a second spelling of it: the mapping and the pane
// share one number and a test that pinned its own would keep passing after a
// change made the gate unreachable.
import { LARGE_BODY_BYTES } from "@/components/shared/response-viewer/utils";
import { createDefaultRequestState } from "./request-state";
import { presetFromCommand } from "@/modules/collections/curl-request-preset";
import { RequestTransformer } from "@/services/transformers/request-transformer";
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
 * The pane's `body` is the received text, indented (issue #2459).
 *
 * The mapping used to indent the engine's parsed `body` instead, and that copy
 * is key-sorted, collapses a repeated key and has rounded any integer past
 * 2^53 - so Pretty showed, and Copy and Save as example took, a document the
 * server never sent. The engine still sends that parse, so every fixture here
 * carries both halves, as the real answer does.
 */
describe("responseFromExecuteResult, on a JSON body", () => {
	// Parsed the way the engine's `body` is: sorted keys, last duplicate wins,
	// the large integer rounded to the nearest double.
	const RECEIVED = '{"z":1,"a":{"id":9007199254740993},"10":2,"2":3,"dup":1,"dup":2}';
	const ENGINE_PARSE = { "2": 3, "10": 2, a: { id: 9007199254740992 }, dup: 2, z: 1 };

	it("formats the received text, keeping order, duplicates and digits", () => {
		expect(RECEIVED.length).toBeGreaterThan(0);

		const mapped = responseFromExecuteResult(
			result({ body: ENGINE_PARSE, bodyRaw: RECEIVED, bodySize: RECEIVED.length })
		);

		expect(mapped.body).toBe(
			[
				"{",
				'  "z": 1,',
				'  "a": {',
				'    "id": 9007199254740993',
				"  },",
				'  "10": 2,',
				'  "2": 3,',
				'  "dup": 1,',
				'  "dup": 2',
				"}",
			].join("\n")
		);
		expect(mapped.bodyRaw).toBe(RECEIVED);
	});

	it("keeps a JSON null, a scalar and a JSON string as the server wrote them", () => {
		// The engine parses a JSON `null` to nothing and a string to its
		// unquoted characters; the pane shows the text it received for all three.
		expect(responseFromExecuteResult(result({ body: null, bodyRaw: "null" })).body).toBe(
			"null"
		);
		expect(responseFromExecuteResult(result({ body: 12, bodyRaw: "12" })).body).toBe("12");
		expect(responseFromExecuteResult(result({ body: "abc", bodyRaw: '"abc"' })).body).toBe(
			'"abc"'
		);
	});

	it("leaves text that is not JSON as received", () => {
		const text = "<p>hello {not: json}</p>";
		const mapped = responseFromExecuteResult(result({ body: null, bodyRaw: text }));

		expect(mapped.body).toBe(text);
		expect(mapped.bodyRaw).toBe(text);
	});

	it("builds the same pane whether or not the engine parsed the body (#2544)", () => {
		// `apiService.executeRequest` asks for `includeParsedBody: false`, so the
		// live answer carries `body: null` where it used to carry the parse. The
		// pane is built from `bodyRaw`, so Pretty and Raw must not move.
		const parsed = responseFromExecuteResult(
			result({ body: ENGINE_PARSE, bodyRaw: RECEIVED, bodySize: RECEIVED.length })
		);
		const declined = responseFromExecuteResult(
			result({ body: null, bodyRaw: RECEIVED, bodySize: RECEIVED.length })
		);

		expect(declined.body).toBe(parsed.body);
		expect(declined.bodyRaw).toBe(parsed.bodyRaw);
		expect(declined.bodyRaw).toBe(RECEIVED);
	});

	it("builds the same large pane from a declined body as from a parsed one", () => {
		const big = { pad: "x".repeat(LARGE_BODY_BYTES + 1024) };
		const raw = JSON.stringify(big);

		const parsed = responseFromExecuteResult(
			result({ body: big, bodyRaw: raw, bodySize: raw.length })
		);
		const declined = responseFromExecuteResult(
			result({ body: null, bodyRaw: raw, bodySize: raw.length })
		);

		expect(declined.body).toBe(raw);
		expect(declined.body).toBe(parsed.body);
		expect(declined.bodyRaw).toBe(parsed.bodyRaw);
	});

	it("rebuilds a missing bodyRaw compactly, and the pane indents that", () => {
		// Guard for a producer that sends no `bodyRaw`: the original bytes are
		// gone, so the reconstruction must not claim formatting nobody sent.
		const mapped = responseFromExecuteResult(
			result({ body: { a: [1] }, bodyRaw: undefined as unknown as string })
		);

		expect(mapped.bodyRaw).toBe('{"a":[1]}');
		expect(mapped.body).toBe('{\n  "a": [\n    1\n  ]\n}');
	});
});

/**
 * Above `LARGE_BODY_BYTES` the pane never formats anything (`ResponseBody`
 * shows a raw prefix instead), so an indented copy there would be
 * multi-megabyte work whose output nothing rendered.
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
		// The distinguishing evidence: an indented copy always contains a
		// newline, and the raw string never does.
		expect(mapped.body).not.toContain("\n");
	});

	it("formats a body just under the threshold", () => {
		const { parsed, raw } = jsonOfLength(LARGE_BODY_BYTES - 1024);

		const mapped = responseFromExecuteResult(
			result({ body: parsed, bodyRaw: raw, bodySize: raw.length })
		);

		expect(mapped.body).toContain("\n");
		expect(mapped.body).toBe(JSON.stringify(parsed, null, 2));
	});

	it("leaves a body under the threshold byte-identical to the indented copy", () => {
		const { parsed, raw } = jsonOfLength(1024);

		const mapped = responseFromExecuteResult(
			result({ body: parsed, bodyRaw: raw, bodySize: raw.length })
		);

		expect(raw.length).toBeGreaterThan(1000);
		expect(mapped.body).toBe(JSON.stringify(parsed, null, 2));
		expect(mapped.bodyRaw).toBe(raw);
	});

	it("leaves a large non-JSON body alone", () => {
		const text = "y".repeat(LARGE_BODY_BYTES + 1024);

		const mapped = responseFromExecuteResult(
			result({ body: null, bodyRaw: text, bodySize: text.length })
		);

		expect(mapped.body).toBe(text);
		expect(mapped.bodyRaw).toBe(text);
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

		expect(execIdentity(request)).toEqual({ requestName: "Untitled request" });
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

	it("sends a text part's own type, resolved, and no file members", () => {
		const request = stateWith({
			bodyMode: "form-data",
			formData: [
				{
					id: "typed-row",
					key: "payload",
					value: '{"a":1}',
					enabled: true,
					contentType: "application/{{sub}}",
				},
				{ id: "empty-row", key: "plain", value: "x", enabled: true, contentType: "" },
			],
		});

		const body = buildExecBody(request, (s) => s.split("{{sub}}").join("json"));

		expect(body?.fields).toEqual([
			{ key: "payload", value: '{"a":1}', enabled: true, contentType: "application/json" },
			{ key: "plain", value: "x", enabled: true },
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

/**
 * A `binary` body is a file reference, never bytes, and the stored shape
 * (`toBodyPayload`, the save) and the sent one (`buildExecBody`) carry the
 * same one.
 */
describe("binary bodies", () => {
	function binaryState(file: RequestState["binaryFile"]): RequestState {
		return { ...createDefaultRequestState(), bodyMode: "binary", binaryFile: file };
	}

	it("sends the file reference", () => {
		const request = binaryState({
			src: "/fixtures/a.bin",
			fileName: "a.bin",
			contentType: "image/png",
		});

		expect(buildExecBody(request, (s) => s)).toEqual({
			mode: "binary",
			file: { src: "/fixtures/a.bin", fileName: "a.bin", contentType: "image/png" },
		});
	});

	it("stores the same reference the send carries", () => {
		const request = binaryState({ src: "/fixtures/a.bin" });

		expect(toBodyPayload(request)).toEqual({
			mode: "binary",
			file: { src: "/fixtures/a.bin" },
		});
	});

	it("leaves empty members off the wire", () => {
		const request = binaryState({ src: "/fixtures/a.bin", fileName: "", contentType: "" });

		expect(buildExecBody(request, (s) => s)).toEqual({
			mode: "binary",
			file: { src: "/fixtures/a.bin" },
		});
	});

	it("sends an empty path rather than no body, so the engine can say why", () => {
		expect(buildExecBody(binaryState({ src: "" }), (s) => s)).toEqual({
			mode: "binary",
			file: { src: "" },
		});
	});
});

/**
 * `unresolved` is the engine's answer, derived on every read and ignored on
 * every write (#2356). The editor keeps it for its warning; no payload the
 * renderer builds from editor state carries it, whatever it holds.
 */
describe("the file trust flag never leaves the editor", () => {
	/** What each writer puts on the wire, read through one shape. */
	type Written = { fields?: Record<string, unknown>[]; file?: Record<string, unknown> };
	const writers: [string, (r: RequestState) => Written][] = [
		["the send", (r) => buildExecBody(r, (s) => s) as Written],
		["the save", (r) => toBodyPayload(r) as Written],
		["a pasted command's new request", (r) => presetFromCommand(r).body as Written],
	];

	function formState(unresolved: boolean | undefined): RequestState {
		return {
			...createDefaultRequestState(),
			bodyMode: "form-data",
			formData: [
				{
					id: "file-row",
					key: "avatar",
					value: "",
					enabled: true,
					type: "file",
					src: "/tmp/a.png",
					unresolved,
				},
			],
		};
	}

	function binaryStateOf(file: RequestState["binaryFile"]): RequestState {
		return { ...createDefaultRequestState(), bodyMode: "binary", binaryFile: file };
	}

	function binaryState(unresolved: boolean | undefined): RequestState {
		return binaryStateOf({ src: "/tmp/a.bin", unresolved });
	}

	describe.each(writers)("%s", (_name, write) => {
		it.each([[false], [true], [undefined]])("drops a form-data file part's %s", (given) => {
			const [part] = write(formState(given)).fields ?? [];
			// Non-vacuous: the part under test is the file part, path and all.
			expect(part).toMatchObject({ type: "file", src: "/tmp/a.png" });
			expect(part).not.toHaveProperty("unresolved");
		});

		it("keeps a text part's type while dropping its flag", () => {
			const state: RequestState = {
				...createDefaultRequestState(),
				bodyMode: "form-data",
				formData: [
					{
						id: "text-row",
						key: "payload",
						value: "{}",
						enabled: true,
						contentType: "application/json",
						unresolved: true,
					},
				],
			};
			const [part] = write(state).fields ?? [];
			expect(part).toMatchObject({ key: "payload", contentType: "application/json" });
			expect(part).not.toHaveProperty("unresolved");
		});

		it.each([[false], [true], [undefined]])("drops a binary file's %s", (given) => {
			const { file } = write(binaryState(given));
			expect(file).toMatchObject({ src: "/tmp/a.bin" });
			expect(file).not.toHaveProperty("unresolved");
		});
	});

	it("a new request's empty binary body carries no flag", () => {
		expect(createDefaultRequestState().binaryFile).toEqual({ src: "" });
	});

	/*
	 * The round trip: a request read from the engine keeps the derived answer
	 * on the way into the editor (the warning reads it), and the next save and
	 * send built from that state carry none of it.
	 */
	it("keeps the engine's answer for display and sends none of it back", () => {
		const read = RequestTransformer.toFrontend({
			id: "req_1",
			collectionId: "col_1",
			name: "Upload",
			method: "POST",
			url: "https://api.test/upload",
			body: {
				mode: "binary",
				file: { src: "/elsewhere/a.bin", fileName: "a.bin", unresolved: true },
			},
			createdAt: 1,
			updatedAt: 1,
		});
		if (read.body.mode !== "binary") throw new Error("expected a binary body");
		const state = binaryStateOf(read.body.file);

		expect(state.binaryFile.unresolved).toBe(true);
		for (const payload of [toBodyPayload(state), buildExecBody(state, (s) => s)]) {
			const wire = JSON.stringify(payload);
			expect(wire).toContain('"src":"/elsewhere/a.bin"');
			expect(wire).not.toContain("unresolved");
		}
	});
});

describe("protocolSettings (#1765)", () => {
	it("sends all three at their defaults, never elided", () => {
		// The editor may be ahead of the saved row: an omitted `false` or `[]`
		// would let the stored value win on the compose overlay.
		expect(protocolSettings(createDefaultRequestState())).toEqual({
			disableCookies: false,
			disabledSystemHeaders: [],
			disableUrlEncoding: false,
		});
	});

	it("carries the editor's values", () => {
		expect(
			protocolSettings({
				...createDefaultRequestState(),
				disableCookies: true,
				disabledSystemHeaders: ["user-agent", "accept"],
				disableUrlEncoding: true,
			})
		).toEqual({
			disableCookies: true,
			disabledSystemHeaders: ["user-agent", "accept"],
			disableUrlEncoding: true,
		});
	});

	it("keeps the stored list apart from the per-send opt-out", () => {
		// Two fields, two helpers: the stored `disabledSystemHeaders` is not
		// folded into `disabledDefaultHeaders` (the engine unions them), and the
		// per-send list does not leak into the stored one.
		const request = {
			...createDefaultRequestState(),
			disabledSystemHeaders: ["accept"],
			disabledDefaultHeaders: ["User-Agent"],
		};
		expect(protocolSettings(request).disabledSystemHeaders).toEqual(["accept"]);
		expect(disabledDefaults(request)).toEqual({ disabledDefaultHeaders: ["User-Agent"] });
	});
});
