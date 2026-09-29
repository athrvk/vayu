/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which URL segments are path variables, how rows follow them, and what the
 * substitution sends (issue #1764). The segment rule is the one the engine
 * applies, so every case here is a claim about what a send does. That the two
 * sides read a URL alike is `path-variables.conformance.test.ts`'s job, over
 * the fixture both suites read.
 */

import { describe, it, expect } from "vitest";
import type { KeyValueEntry, KeyValueItem } from "@/types";
import {
	composePathParams,
	pathRowsFromUrl,
	pathVariableNames,
	displayPathRows,
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

// ---- App-side cases ----

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

	it("takes the name to the first dot and allows any other character", () => {
		expect(pathVariableNames("https://x/:")).toEqual([]);
		expect(pathVariableNames("https://x/a:b/:c-d/:e.f/:g_h/:x%20y/:{{v}}")).toEqual([
			"c-d",
			"e",
			"g_h",
			"x%20y",
			"{{v}}",
		]);
		// Not a whole segment: the colon is not its first character.
		expect(pathVariableNames("https://x/v1:id")).toEqual([]);
	});

	it("skips leading whitespace before the URL", () => {
		expect(pathVariableNames("  https://x/:id")).toEqual(["id"]);
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
		const synced = syncPathRows(existing, "https://x/:id/posts/:postId", "https://x/:id");
		expect(synced[0]).toBe(existing[0]);
		expect(synced[1]).toMatchObject({ key: "postId", value: "", in: "path" });
	});

	it("drops the row of a segment that left the URL", () => {
		const existing = [row("1", "id", "42"), row("2", "postId", "7")];
		const before = "https://x/:id/posts/:postId";
		expect(syncPathRows(existing, "https://x/:id/posts", before).map((r) => r.key)).toEqual([
			"id",
		]);
		expect(syncPathRows(existing, "https://x/users", before)).toEqual([]);
	});

	it("renames the row of an edited segment and keeps its value", () => {
		// One keystroke at a time: `:id` -> `:i` -> `:iX`.
		const existing = [row("1", "id", "42", { description: "user", enabled: false })];
		const once = syncPathRows(existing, "https://x/:i", "https://x/:id");
		expect(once).toEqual([{ ...existing[0], key: "i" }]);
		const twice = syncPathRows(once, "https://x/:iX", "https://x/:i");
		expect(twice).toEqual([{ ...existing[0], key: "iX" }]);
	});

	it("pairs no row with a new name unless exactly one name left for it", () => {
		// Mutation check: pairing leftover rows by position gives `c` the
		// SECRET that belonged to `unused`.
		const existing = [row("1", "a", "1"), row("2", "b", "2"), row("3", "unused", "SECRET")];
		const synced = syncPathRows(existing, "https://x/a/:b/c/:a/:c", "https://x/:a/:b");
		expect(synced.map(({ key, value }) => ({ key, value }))).toEqual([
			{ key: "b", value: "2" },
			{ key: "a", value: "1" },
			{ key: "c", value: "" },
		]);
		// Two names swapped for two others: neither is a rename.
		const two = syncPathRows(existing.slice(0, 2), "https://x/:c/:d", "https://x/:a/:b");
		expect(two.map(({ key, value }) => ({ key, value }))).toEqual([
			{ key: "c", value: "" },
			{ key: "d", value: "" },
		]);
	});

	it("changes nothing when the edit leaves the segments as they were", () => {
		// Mutation check: syncing on every edit drops the declared-but-unused row.
		const existing = [row("1", "a", "1"), row("2", "unused", "SECRET")];
		const synced = syncPathRows(existing, "https://x/:a?x=2", "https://x/:a?x=1");
		expect(synced).toEqual(existing);
		expect(syncPathRows(existing, "https://y/v2/:a#f", "https://x/:a")).toEqual(existing);
	});

	it("follows the URL's order when segments move", () => {
		const existing = [row("1", "a", "1"), row("2", "b", "2")];
		expect(
			syncPathRows(existing, "https://x/:b/:a", "https://x/:a/:b").map((r) => r.id)
		).toEqual(["2", "1"]);
	});

	it("keeps a disabled row whose segment is still in the URL", () => {
		const existing = [row("1", "id", "42", { enabled: false })];
		expect(syncPathRows(existing, "https://x/:id/:y", "https://x/:id")[0]).toBe(existing[0]);
	});

	it("collapses rows sharing a key to the one that answers it", () => {
		const existing = [
			row("1", "id", "first"),
			row("2", "id", "answers"),
			row("3", "id", "off", { enabled: false }),
		];
		expect(syncPathRows(existing, "https://x/:id", "https://x/:id/:x")).toEqual([existing[1]]);
		const allOff = [
			row("1", "id", "a", { enabled: false }),
			row("2", "id", "b", { enabled: false }),
		];
		expect(syncPathRows(allOff, "https://x/:id", "https://x/:id/:x")).toEqual([allOff[1]]);
	});

	it("keeps members it does not know on a kept or renamed row", () => {
		const existing = [{ ...row("1", "id", "42"), type: "any" } as unknown as KeyValueItem];
		expect(syncPathRows(existing, "https://x/:id/:y", "https://x/:id")[0]).toBe(existing[0]);
		expect(syncPathRows(existing, "https://x/:userId", "https://x/:id")[0]).toMatchObject({
			key: "userId",
			value: "42",
			type: "any",
		});
	});

	it("keeps one row for a repeated name", () => {
		const synced = syncPathRows([], "https://x/:id/copy/:id", "https://x/");
		expect(synced.map((r) => r.key)).toEqual(["id"]);
	});
});

describe("displayPathRows", () => {
	it("shows a row for a segment no stored row answers, with an id that does not change", () => {
		const shown = displayPathRows([], "https://x/users/:id");
		expect(shown).toEqual([
			{ id: "path-variable:id", key: "id", value: "", enabled: true, in: "path" },
		]);
		expect(displayPathRows([], "https://x/users/:id")[0].id).toBe(shown[0].id);
	});

	it("keeps every stored row as it is, a declared-but-unused one included", () => {
		const existing = [row("1", "unused", "SECRET"), row("2", "id", "7", { enabled: false })];
		expect(displayPathRows(existing, "https://x/:id/:postId")).toEqual([
			...existing,
			{
				id: "path-variable:postId",
				key: "postId",
				value: "",
				enabled: true,
				in: "path",
			},
		]);
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

	it("keeps the suffix after the name", () => {
		expect(substitutePathVariables("https://x/:id.json", [path("id", "7")])).toBe(
			"https://x/7.json"
		);
	});

	it("lets the last enabled row answer, even when its value is empty", () => {
		expect(
			substitutePathVariables("https://x/:id", [
				path("id", "1"),
				path("id", ""),
				path("id", "3", false),
			])
		).toBe("https://x/:id");
	});

	it("resolves a value before encoding it, and leaves an empty result literal", () => {
		const vars: Record<string, string> = { "{{user}}": "a b", "{{none}}": "" };
		const resolve = (value: string) => vars[value] ?? value;
		expect(substitutePathVariables("https://x/:id", [path("id", "{{user}}")], resolve)).toBe(
			"https://x/a%20b"
		);
		expect(substitutePathVariables("https://x/:id", [path("id", "{{none}}")], resolve)).toBe(
			"https://x/:id"
		);
		// A token still unresolved is kept verbatim.
		expect(substitutePathVariables("https://x/:id", [path("id", "{{later}}/x")], resolve)).toBe(
			"https://x/{{later}}%2Fx"
		);
	});

	it("reads a backslash as a separator", () => {
		expect(substitutePathVariables("https://x\\a\\:id", [path("id", "1")])).toBe(
			"https://x\\a\\1"
		);
	});

	it("never touches a port", () => {
		expect(
			substitutePathVariables("http://h:8080/:id", [path("8080", "x"), path("id", "1")])
		).toBe("http://h:8080/1");
	});
});

describe("composePathParams", () => {
	it("sends the path rows alone, without editor ids, keeping every other member", () => {
		const rows = [
			{ id: "q", key: "page", value: "1", enabled: true },
			{ ...row("p", "id", "42", { description: "user" }), type: "any", extra: 1 },
		] as KeyValueItem[];
		expect(composePathParams(rows)).toEqual([
			{
				key: "id",
				value: "42",
				enabled: true,
				description: "user",
				in: "path",
				type: "any",
				extra: 1,
			},
		]);
	});

	it("sends an empty list for a request with no path rows", () => {
		// Absent would let the engine answer from the stored rows instead.
		expect(composePathParams([{ key: "page", value: "1", enabled: true }])).toEqual([]);
	});
});
