import { describe, it, expect } from "vitest";
import type { CollectionDraft } from "./types";
import {
	toVarRecord,
	mapPostmanAuth,
	rawBody,
	joinExec,
	asString,
	mapKeyValues,
	importedFilePart,
	unattachedFileParts,
} from "./shared";

describe("toVarRecord", () => {
	it("builds a VariableValue record, stringifying values, defaulting enabled", () => {
		expect(
			toVarRecord([
				{ key: "a", value: 1 },
				{ key: "b", value: "x", disabled: true },
			])
		).toEqual({
			a: { value: "1", enabled: true },
			b: { value: "x", enabled: false },
		});
	});

	it("marks a Postman secret-typed variable, and omits the flag otherwise", () => {
		const out = toVarRecord([
			{ key: "token", value: "s3cr3t", type: "secret" },
			{ key: "host", value: "example.com", type: "default" },
		]);
		expect(out).toEqual({
			token: { value: "s3cr3t", enabled: true, secret: true },
			host: { value: "example.com", enabled: true },
		});
		// Not `secret: false` - a non-secret variable must serialise as it did before.
		expect("secret" in out.host).toBe(false);
	});
});

describe("mapPostmanAuth", () => {
	it("maps v2.1 bearer array shape", () => {
		expect(mapPostmanAuth({ type: "bearer", bearer: [{ key: "token", value: "T" }] })).toEqual({
			mode: "bearer",
			token: "T",
		});
	});
	it("maps v2.0 bearer object shape", () => {
		expect(mapPostmanAuth({ type: "bearer", bearer: { token: "T" } })).toEqual({
			mode: "bearer",
			token: "T",
		});
	});
	it("maps apikey with in", () => {
		expect(
			mapPostmanAuth({
				type: "apikey",
				apikey: [
					{ key: "key", value: "X" },
					{ key: "value", value: "V" },
					{ key: "in", value: "query" },
				],
			})
		).toEqual({ mode: "apikey", key: "X", value: "V", in: "query" });
	});
	it("noauth → none (a request-level noauth just sends nothing)", () => {
		// The collection/folder side is where noauth has to stay distinct - see
		// `collectionAuth` in postman.ts, which reads the wire type itself.
		expect(mapPostmanAuth({ type: "noauth" })).toEqual({ mode: "none" });
	});
	it("awsv4 (the real wire type) → the internal aws mode with its config", () => {
		expect(
			mapPostmanAuth({
				type: "awsv4",
				awsv4: [
					{ key: "accessKey", value: "AKIA" },
					{ key: "sessionToken", value: "tok" },
				],
			})
		).toEqual({ mode: "aws", config: { accessKey: "AKIA", sessionToken: "tok" } });
	});
	it("does not answer to a bare 'aws' type - that spelling never occurs", () => {
		// Insomnia's IAM auth maps to the aws mode in `insomnia-v4.ts` without going
		// through this function, so the old `case "aws"` was dead code.
		expect(mapPostmanAuth({ type: "aws", aws: { accessKey: "AKIA" } })).toEqual({
			mode: "none",
		});
	});
	it("oauth2 with a flow maps to a typed config", () => {
		const r = mapPostmanAuth({
			type: "oauth2",
			oauth2: [
				{ key: "grant_type", value: "client_credentials" },
				{ key: "accessTokenUrl", value: "https://idp/token" },
				{ key: "clientId", value: "cid" },
			],
		});
		expect(r.mode).toBe("oauth2");
		expect(
			(r as { config: { grantType: string; accessTokenUrl: string } }).config.grantType
		).toBe("client_credentials");
		expect((r as { config: { accessTokenUrl: string } }).config.accessTokenUrl).toBe(
			"https://idp/token"
		);
	});
	it("oauth2 minimal export (accessToken only) → bearer", () => {
		const r = mapPostmanAuth({ type: "oauth2", oauth2: [{ key: "accessToken", value: "A" }] });
		expect(r).toEqual({ mode: "bearer", token: "A" });
	});
	it("unknown type → none", () => {
		expect(mapPostmanAuth({ type: "weird" })).toEqual({ mode: "none" });
	});
	it('inherit → {mode:"inherit"}', () => {
		expect(mapPostmanAuth({ type: "inherit" })).toEqual({ mode: "inherit" });
	});
});

describe("rawBody", () => {
	it("json language → json mode", () => {
		expect(rawBody('{"a":1}', "json")).toEqual({ mode: "json", content: '{"a":1}' });
	});
	it("no language, valid JSON → json", () => {
		expect(rawBody('{"a":1}', undefined)).toEqual({ mode: "json", content: '{"a":1}' });
	});
	it("no language, non-JSON → text", () => {
		expect(rawBody("hello", undefined)).toEqual({ mode: "text", content: "hello" });
	});
});

describe("joinExec", () => {
	it("joins exec lines with newline", () => {
		expect(joinExec({ script: { exec: ["a", "b"] } })).toBe("a\nb");
	});
	it("missing → empty string", () => {
		expect(joinExec(undefined)).toBe("");
	});
});

describe("asString", () => {
	it("coerces scalars and objects", () => {
		expect(asString(null)).toBe("");
		expect(asString(undefined)).toBe("");
		expect(asString("x")).toBe("x");
		expect(asString(5)).toBe("5");
		expect(asString(true)).toBe("true");
		expect(asString({ a: 1 })).toBe('{"a":1}');
		expect(asString([1, 2])).toBe("[1,2]");
	});
});

describe("importedFilePart", () => {
	const entry = { key: "avatar", value: "leftover", enabled: true };

	it("marks a part that carries a path as unresolved, and names the file", () => {
		expect(importedFilePart(entry, "/home/other/avatar.png", "image/png")).toEqual({
			key: "avatar",
			value: "",
			enabled: true,
			type: "file",
			src: "/home/other/avatar.png",
			fileName: "avatar.png",
			contentType: "image/png",
			unresolved: true,
		});
	});

	it("leaves a part with no path unmarked - nothing there could be unverified", () => {
		const part = importedFilePart(entry, "");
		expect(part).toEqual({ key: "avatar", value: "", enabled: true, type: "file", src: "" });
		// Not `unresolved: false` either: the editor's warning reads the flag's
		// presence, and a row showing "Choose file" claims nothing to warn about.
		expect("unresolved" in part).toBe(false);
	});
});

describe("unattachedFileParts", () => {
	const collection = (requests: CollectionDraft["requests"]): CollectionDraft => ({
		name: "c",
		description: "",
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		children: [],
		requests,
	});
	const request = (body: CollectionDraft["requests"][number]["body"]) => ({
		name: "r",
		description: "",
		method: "POST" as const,
		url: "https://x",
		params: [],
		headers: [],
		body,
		auth: { mode: "inherit" as const },
		preRequestScript: "",
		postRequestScript: "",
	});

	it("counts only form-data file rows with no file, at every depth", () => {
		const withUpload = request({
			mode: "form-data",
			fields: [
				{ key: "caption", value: "", enabled: true },
				importedFilePart({ key: "a", value: "", enabled: true }, ""),
				// A part that names a path is the user's to re-point, not to attach.
				importedFilePart({ key: "b", value: "", enabled: true }, "/tmp/b.png"),
			],
		});
		const nested = collection([withUpload]);
		const root = collection([withUpload, request({ mode: "json", content: "{}" })]);
		root.children = [nested];
		expect(unattachedFileParts([root])).toBe(2);
	});

	it("is zero for an import with no form bodies at all", () => {
		expect(unattachedFileParts([collection([request({ mode: "none" })])])).toBe(0);
		expect(unattachedFileParts([])).toBe(0);
	});
});

describe("mapKeyValues", () => {
	it("maps rows, preserves disabled + duplicates, drops blank keys, omits absent description", () => {
		expect(
			mapKeyValues([
				{ key: "Accept", value: "application/json" },
				{ key: "X", value: "1", disabled: true },
				{ key: "Accept", value: "text/html" },
				{ key: "", value: "ignored" },
				{ key: "Trace", value: "on", description: "d" },
			])
		).toEqual([
			{ key: "Accept", value: "application/json", enabled: true },
			{ key: "X", value: "1", enabled: false },
			{ key: "Accept", value: "text/html", enabled: true },
			{ key: "Trace", value: "on", enabled: true, description: "d" },
		]);
	});
});
