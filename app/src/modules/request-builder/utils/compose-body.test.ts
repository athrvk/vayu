/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The inline `POST /compose` body every send site builds (issue #2638). The
 * exact-equality case is the field-coverage lock: a field dropped from the
 * builder, or added to it, fails it, so a new field is a decision made here
 * rather than one send site quietly sending what the others do not.
 */

import { describe, it, expect } from "vitest";
import type { Collection, ResolvedElement } from "@/types";
import type { RequestState } from "../types";
import { buildComposeBody, type ComposeBodyInput } from "./compose-body";
import { createDefaultRequestState } from "./request-state";

const OWN_TIMEOUT = 1500;

/** Every field off its default, so an always-sent one cannot pass by luck. */
function editedRequest(): RequestState {
	return {
		...createDefaultRequestState(),
		id: "req_1",
		collectionId: "col_leaf",
		name: "Get user",
		method: "POST",
		url: "https://api.example.com/users/:id?verbose=1",
		params: [
			{ id: "p1", key: "verbose", value: "1", enabled: true },
			{ id: "p2", key: "id", value: "7", enabled: true, in: "path" },
		],
		headers: [
			{
				id: "h1",
				key: "Content-Type",
				value: "application/json",
				enabled: true,
				source: "body-mode",
			},
			{ id: "h2", key: "X-Trace", value: "{{trace}}", enabled: true },
			{ id: "h3", key: "X-Off", value: "no", enabled: false },
		],
		bodyMode: "json",
		body: '{"name":"{{name}}"}',
		auth: { mode: "bearer", token: "{{token}}" },
		elements: [{ id: "el_own", kind: "script.pre", enabled: true, config: { script: "1" } }],
		followRedirects: false,
		maxRedirects: 3,
		timeout: OWN_TIMEOUT,
		httpVersion: "http2",
		verifySSL: false,
		disableCookies: true,
		disabledSystemHeaders: ["user-agent"],
		disableUrlEncoding: true,
	};
}

function collection(id: string, elements: Collection["elements"]): Collection {
	return {
		id,
		name: `Collection ${id}`,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements,
		createdAt: "",
		updatedAt: "",
	};
}

const chain = [
	collection("col_root", [
		{ id: "el_root", kind: "script.pre", enabled: true, config: { script: "0" } },
	]),
];

function input(overrides: Partial<ComposeBodyInput> = {}): ComposeBodyInput {
	return {
		request: editedRequest(),
		elements: { chain, ownerId: "req_1" },
		collectionId: "col_leaf",
		environmentId: "env_1",
		...overrides,
	};
}

describe("buildComposeBody", () => {
	it("writes every field Send composes, exactly, from the editor state", () => {
		const { body } = buildComposeBody(input());

		expect(body).toEqual({
			request: {
				method: "POST",
				url: "https://api.example.com/users/:id?verbose=1",
				// Path rows only, without the editor's row id.
				params: [{ key: "id", value: "7", enabled: true, in: "path" }],
				// Enabled rows only, raw: `{{trace}}` is the engine's to resolve.
				headers: [
					{ name: "Content-Type", value: "application/json" },
					{ name: "X-Trace", value: "{{trace}}" },
				],
				bodyModeHeaders: ["Content-Type"],
				body: { mode: "json", content: '{"name":"{{name}}"}' },
				auth: { mode: "bearer", token: "{{token}}" },
				elements: [
					{
						id: "el_root",
						kind: "script.pre",
						enabled: true,
						config: { script: "0" },
						origin: {
							kind: "collection",
							scope: "collection",
							id: "col_root",
							name: "Collection col_root",
						},
					},
					{
						id: "el_own",
						kind: "script.pre",
						enabled: true,
						config: { script: "1" },
						origin: { kind: "request", scope: "request", id: "req_1" },
					},
				],
				followRedirects: false,
				maxRedirects: 3,
				timeout: OWN_TIMEOUT,
				httpVersion: "http2",
				verifySSL: false,
				disableCookies: true,
				disabledSystemHeaders: ["user-agent"],
				disableUrlEncoding: true,
				requestName: "Get user",
			},
			collectionId: "col_leaf",
			environmentId: "env_1",
		});
	});

	it("leaves the timeout key off when the request states none, so the engine reads the setting (#2937)", () => {
		// The one setting not always sent: a copy of today's `defaultTimeout`
		// would pin it on the send, and a later change to the setting would not
		// reach it.
		const request = { ...editedRequest(), timeout: null };
		const { body } = buildComposeBody(input({ request }));
		expect(body.request).not.toHaveProperty("timeout");
	});

	it("sends the request's own timeout through", () => {
		const { body } = buildComposeBody(input());
		expect(body.request?.timeout).toBe(OWN_TIMEOUT);
	});

	it("sends params as [] when the request has no path rows", () => {
		const request = { ...editedRequest(), url: "https://api.example.com/users" };
		request.params = request.params.filter((row) => row.in !== "path");
		const { body } = buildComposeBody(input({ request }));
		expect(body.request?.params).toEqual([]);
	});

	it("copies the auth rather than handing compose the editor's own object", () => {
		const request = editedRequest();
		const { body } = buildComposeBody(input({ request }));
		expect(body.request?.auth).toEqual(request.auth);
		expect(body.request?.auth).not.toBe(request.auth);
	});

	it("leaves the request name out when the editor has none", () => {
		const request = { ...editedRequest(), name: "" };
		const { body } = buildComposeBody(input({ request }));
		expect(body.request).not.toHaveProperty("requestName");
	});

	it("returns the elements it composed, and omits them when nothing runs", () => {
		const resolved = buildComposeBody(input());
		expect(resolved.elements).toBe(resolved.body.request?.elements);

		const none = buildComposeBody(
			input({
				request: { ...editedRequest(), elements: [] },
				elements: { chain: [], ownerId: "req_1" },
			})
		);
		expect(none.elements).toBeUndefined();
		expect(none.body.request?.elements).toBeUndefined();
	});

	it("takes a caller's resolved elements as given, without walking a chain", () => {
		const replayed: ResolvedElement[] = [
			{ id: "el_then", kind: "script.post", enabled: true, config: { script: "2" } },
		];
		const { body, elements } = buildComposeBody(input({ elements: { resolved: replayed } }));
		expect(elements).toBe(replayed);
		expect(body.request?.elements).toBe(replayed);
	});

	it("scopes collectionId and environmentId only when set", () => {
		const unset = buildComposeBody(input({ collectionId: undefined, environmentId: null }));
		expect(unset.body).not.toHaveProperty("collectionId");
		expect(unset.body).not.toHaveProperty("environmentId");

		const emptyEnvironment = buildComposeBody(input({ environmentId: "" }));
		expect(emptyEnvironment.body).not.toHaveProperty("environmentId");
	});

	it("sends dataColumns only when a data set will bind, [] included", () => {
		expect(buildComposeBody(input()).body).not.toHaveProperty("dataColumns");
		expect(buildComposeBody(input({ dataColumns: ["username"] })).body.dataColumns).toEqual([
			"username",
		]);
		expect(buildComposeBody(input({ dataColumns: [] })).body.dataColumns).toEqual([]);
	});

	it("defers the dynamic variables only for a caller that asks", () => {
		expect(buildComposeBody(input()).body).not.toHaveProperty("deferDynamicVariables");
		expect(buildComposeBody(input({ deferDynamicVariables: false })).body).not.toHaveProperty(
			"deferDynamicVariables"
		);
		expect(
			buildComposeBody(input({ deferDynamicVariables: true })).body.deferDynamicVariables
		).toBe(true);
	});
});
