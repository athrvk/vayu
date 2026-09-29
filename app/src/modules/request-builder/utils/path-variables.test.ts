/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which URL segments are path variables, how rows follow them, and what the
 * substitution sends (issue #1764). The segment rule is the one the engine
 * applies, so every case here is a claim about what a send does.
 */

import { describe, it, expect } from "vitest";
import type { KeyValueEntry, KeyValueItem } from "@/types";
import {
	composePathParams,
	pathRowsFromUrl,
	pathVariableNames,
	substitutePathVariables,
	syncPathRows,
} from "./path-variables";

const path = (key: string, value: string, enabled = true): KeyValueEntry => ({
	key,
	value,
	enabled,
	in: "path",
});

const row = (id: string, key: string, value: string, extra: Partial<KeyValueItem> = {}) =>
	({ id, key, value, enabled: true, in: "path", ...extra }) as KeyValueItem;

describe("pathVariableNames", () => {
	it("finds whole `:name` segments in order", () => {
		expect(pathVariableNames("https://api.x/users/:userId/posts/:postId")).toEqual([
			"userId",
			"postId",
		]);
	});

	it("never reads a port as a variable", () => {
		expect(pathVariableNames("http://localhost:8080/users/:id")).toEqual(["id"]);
		expect(pathVariableNames("localhost:8080/users")).toEqual([]);
		// A host-less authority is still the authority, not a segment.
		expect(pathVariableNames("http://:8080/users/:id")).toEqual(["id"]);
	});

	it("never reads the query or the fragment", () => {
		expect(pathVariableNames("https://x/a?next=/:id&b=:c")).toEqual([]);
		expect(pathVariableNames("https://x/a#/:id")).toEqual([]);
		expect(pathVariableNames("https://x/:a?q=:b#:c")).toEqual(["a"]);
	});

	it("reads the path after a `{{variable}}` host", () => {
		expect(pathVariableNames("{{baseUrl}}/users/:id")).toEqual(["id"]);
		expect(pathVariableNames("{{baseUrl}}:8080/:id")).toEqual(["id"]);
	});

	it("treats a segment that is not all name characters as literal", () => {
		expect(pathVariableNames("https://x/:")).toEqual([]);
		expect(pathVariableNames("https://x/a:b/:c-d/:e.f/:g_h/:x%20y/:{{v}}")).toEqual([
			"c-d",
			"e.f",
			"g_h",
		]);
		// Not a whole segment: the colon is not its first character.
		expect(pathVariableNames("https://x/v1:id")).toEqual([]);
	});

	it("ignores a trailing slash and an empty segment", () => {
		expect(pathVariableNames("https://x/users/:id/")).toEqual(["id"]);
		expect(pathVariableNames("https://x//:id")).toEqual(["id"]);
	});

	it("lists a repeated name once", () => {
		expect(pathVariableNames("https://x/:id/copy/:id")).toEqual(["id"]);
	});

	it("reads a URL with no scheme or no host", () => {
		expect(pathVariableNames("api.x/:id")).toEqual(["id"]);
		expect(pathVariableNames("/users/:id")).toEqual(["id"]);
		// The first segment of a scheme-less URL is its host.
		expect(pathVariableNames(":id/users")).toEqual([]);
	});
});

describe("pathRowsFromUrl", () => {
	it("makes one enabled path row per name, with no value", () => {
		expect(
			pathRowsFromUrl("https://x/:a/:b").map(({ key, value, enabled, in: at }) => ({
				key,
				value,
				enabled,
				in: at,
			}))
		).toEqual([
			{ key: "a", value: "", enabled: true, in: "path" },
			{ key: "b", value: "", enabled: true, in: "path" },
		]);
	});
});

describe("syncPathRows", () => {
	it("adds a row for a new segment, keeping the others as they were", () => {
		const existing = [row("1", "id", "42", { description: "user" })];
		const synced = syncPathRows(existing, "https://x/:id/posts/:postId");
		expect(synced[0]).toBe(existing[0]);
		expect(synced[1]).toMatchObject({ key: "postId", value: "", in: "path" });
	});

	it("drops the row of a segment that left the URL", () => {
		const existing = [row("1", "id", "42"), row("2", "postId", "7")];
		expect(syncPathRows(existing, "https://x/:id/posts").map((r) => r.key)).toEqual(["id"]);
		expect(syncPathRows(existing, "https://x/users")).toEqual([]);
	});

	it("renames the row of an edited segment and keeps its value", () => {
		// One keystroke at a time: `:id` -> `:i` -> `:iX`.
		const existing = [row("1", "id", "42", { description: "user", enabled: false })];
		const once = syncPathRows(existing, "https://x/:i");
		expect(once).toEqual([{ ...existing[0], key: "i" }]);
		const twice = syncPathRows(once, "https://x/:iX");
		expect(twice).toEqual([{ ...existing[0], key: "iX" }]);
	});

	it("follows the URL's order when segments move", () => {
		const existing = [row("1", "a", "1"), row("2", "b", "2")];
		expect(syncPathRows(existing, "https://x/:b/:a").map((r) => r.id)).toEqual(["2", "1"]);
	});

	it("keeps a disabled row whose segment is still in the URL", () => {
		const existing = [row("1", "id", "42", { enabled: false })];
		expect(syncPathRows(existing, "https://x/:id")).toEqual(existing);
	});

	it("keeps one row for a repeated name", () => {
		const synced = syncPathRows([], "https://x/:id/copy/:id");
		expect(synced.map((r) => r.key)).toEqual(["id"]);
	});
});

describe("substitutePathVariables", () => {
	it("puts each enabled row's value in its segment", () => {
		expect(
			substitutePathVariables("https://x/users/:id/posts/:postId?x=1", [
				path("id", "42"),
				path("postId", "7"),
			])
		).toBe("https://x/users/42/posts/7?x=1");
	});

	it("fills every occurrence of a repeated name", () => {
		expect(substitutePathVariables("https://x/:id/copy/:id", [path("id", "9")])).toBe(
			"https://x/9/copy/9"
		);
	});

	it("percent-encodes a value as one segment, beyond encodeURIComponent", () => {
		expect(substitutePathVariables("https://x/:id", [path("id", "a/b c!'()*~")])).toBe(
			"https://x/a%2Fb%20c%21%27%28%29%2A~"
		);
	});

	it("leaves the segment literal for an empty value or a disabled row", () => {
		expect(substitutePathVariables("https://x/:id", [path("id", "")])).toBe("https://x/:id");
		expect(substitutePathVariables("https://x/:id", [path("id", "1", false)])).toBe(
			"https://x/:id"
		);
	});

	it("ignores query rows and a query or fragment `:name`", () => {
		expect(
			substitutePathVariables("https://x/:id?q=:id#:id", [
				{ key: "id", value: "q", enabled: true },
				path("id", "1"),
			])
		).toBe("https://x/1?q=:id#:id");
	});

	it("leaves a `{{variable}}` value unencoded, for composition to resolve", () => {
		expect(substitutePathVariables("{{base}}/:id", [path("id", "{{userId}}")])).toBe(
			"{{base}}/{{userId}}"
		);
	});

	it("never touches a port", () => {
		expect(
			substitutePathVariables("http://h:8080/:id", [path("8080", "x"), path("id", "1")])
		).toBe("http://h:8080/1");
	});
});

describe("composePathParams", () => {
	it("sends the path rows alone, without editor ids", () => {
		const rows: KeyValueItem[] = [
			{ id: "q", key: "page", value: "1", enabled: true },
			row("p", "id", "42", { description: "user" }),
		];
		expect(composePathParams(rows)).toEqual({
			params: [{ key: "id", value: "42", enabled: true, description: "user", in: "path" }],
		});
	});

	it("adds nothing for a request with no path rows", () => {
		expect(composePathParams([{ key: "page", value: "1", enabled: true }])).toEqual({});
	});
});
