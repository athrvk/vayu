/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the schema badge tells the user, and what the body leaves behind.
 *
 * The store has always recorded *why* introspection failed and *when* the
 * schema loaded, and until #383 nothing rendered either: every failure mode -
 * an expired token, an endpoint with introspection switched off, a gateway
 * answering HTML - collapsed into one static "introspection failed" title, so
 * the badge could not tell the user which fix to reach for. These assert the
 * store's fields reach the screen, which is the half a store-level test cannot
 * see.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { buildSchema } from "graphql";
import { useSchemaCache, schemaCacheKey, type SchemaTarget } from "@/lib/graphql/schema-cache";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const { GraphQLBody } = await import("./GraphQLBody");

const URL = "https://api.test/gql";
const TARGET: SchemaTarget = { url: URL, resolvedUrl: URL, headers: {}, resolvedAuth: null };
const schema = buildSchema("type Query { ping: String }");

function seed(entry: {
	status: "idle" | "loading" | "ready" | "error";
	schema?: typeof schema | null;
	error?: { kind: string; message: string } | null;
	fetchedAt?: number | null;
}) {
	const key = schemaCacheKey(TARGET);
	useSchemaCache.setState({
		byKey: {
			[key]: {
				status: entry.status,
				schema: entry.schema ?? null,
				error: (entry.error ?? null) as never,
				fetchedAt: entry.fetchedAt ?? null,
			},
		},
		lru: [key],
		activeKey: key,
	});
}

function renderBody() {
	return render(
		<TooltipProvider>
			<GraphQLBody
				body=""
				onBodyChange={() => {}}
				requestId="r1"
				schemaTarget={TARGET}
				method="POST"
				variablesDraft={null}
				onVariablesDraftChange={() => {}}
			/>
		</TooltipProvider>
	);
}

beforeEach(() => {
	useSchemaCache.setState({ byKey: {}, lru: [], activeKey: null });
});
afterEach(cleanup);

/**
 * The badge's root, and the one word it is actually saying.
 *
 * Not `getByText`: the badge reserves its width by rendering a hidden twin of
 * every word it can say (`LabelSwap`), so "No schema" is in the DOM whatever
 * the state and only the live cell says what is true. The `title` lives on the
 * root, which is what the sentence cases below read.
 */
const schemaBadge = () => document.querySelector<HTMLElement>("[data-slot='schema-status-badge']");
const schemaWord = () =>
	schemaBadge()?.querySelector("[data-slot='label-swap-live']")?.textContent ?? null;
const schemaTitle = () => schemaBadge()?.getAttribute("title") ?? "";

describe("the schema badge", () => {
	it("names the failure and what to do about it, per kind", () => {
		seed({ status: "error", error: { kind: "auth", message: "HTTP 401." } });
		renderBody();

		expect(schemaWord()).toBe("No schema");
		// Both halves: the actionable sentence this kind gets, and the engine's
		// own words. Neither is inferable from the other.
		expect(schemaTitle()).toMatch(/credentials were rejected/i);
		expect(schemaTitle()).toContain("HTTP 401.");
	});

	it("says something different for an endpoint that disallows introspection", () => {
		seed({
			status: "error",
			error: { kind: "unsupported", message: "introspection is not allowed" },
		});
		renderBody();
		expect(schemaWord()).toBe("No schema");
		expect(schemaTitle()).toMatch(/does not allow introspection/i);
		// The auth wording is the one this must not be confused with.
		expect(schemaTitle()).not.toMatch(/credentials were rejected/i);
	});

	it("shows how old the schema is once one has loaded", () => {
		seed({ status: "ready", schema, fetchedAt: Date.now() - 5 * 60 * 1000 });
		renderBody();
		expect(schemaWord()).toBe("Schema");
		expect(schemaTitle()).toMatch(/5m ago/);
	});

	/*
	 * A refresh that failed over a schema that loaded earlier is not "no schema":
	 * the editors still complete against the last good one. Saying "No schema"
	 * there tells the user their completions are gone when they are not.
	 */
	it("reads as stale, not absent, when a refresh failed over a loaded schema", () => {
		seed({
			status: "error",
			schema,
			error: { kind: "network", message: "unreachable" },
			fetchedAt: Date.now() - 60 * 1000,
		});
		renderBody();

		expect(schemaWord()).toBe("Schema stale");
		expect(schemaTitle()).toMatch(/could not be reached/i);
		expect(schemaTitle()).toMatch(/1m ago/);
	});

	it("claims nothing before an endpoint has been introspected, but still opens", () => {
		renderBody();

		// The badge claims nothing for `idle` - no status has been established,
		// and inventing one would be worse than silence. It is still *there*,
		// saying the neutral word with its glyph slot empty, because the way into
		// the explorer must not depend on the schema having loaded first and
		// because a badge that mounts later would shove Refresh sideways.
		expect(schemaWord()).toBe("Schema");
		expect(schemaTitle()).toMatch(/not been loaded yet/i);
		expect(schemaBadge()?.querySelector("[data-slot='schema-status-glyph']")?.textContent).toBe(
			""
		);
		expect(screen.getByLabelText("Browse schema")).toBeTruthy();
	});
});

describe("the active schema target", () => {
	it("points the language providers at this body's endpoint while it is mounted", () => {
		renderBody();
		expect(useSchemaCache.getState().activeKey).toBe(schemaCacheKey(TARGET));
	});

	/*
	 * This component mounts only while the body mode is graphql, so unmounting is
	 * leaving GraphQL. Leaving the target set kept Monaco completing a closed
	 * tab's endpoint - the clear used to hang off an `active` prop the only call
	 * site hardcoded to `true`, so it could never run.
	 */
	it("stops pointing at it once the body unmounts", () => {
		const { unmount } = renderBody();
		unmount();
		expect(useSchemaCache.getState().activeKey).toBeNull();
	});

	it("leaves a target another body has already claimed", () => {
		const { unmount } = renderBody();
		const next = { ...TARGET, resolvedUrl: "https://other.test/gql" };
		useSchemaCache.getState().setActiveTarget(next);
		unmount();
		expect(useSchemaCache.getState().activeKey).toBe(schemaCacheKey(next));
	});
});

/*
 * The schema row does not move when the schema's state does.
 *
 * `SchemaControls` puts the explorer toggle, this badge and Refresh in one flex
 * row, Refresh *after* the badge, and that row leads the Query pane's header
 * with the pane title after it. The badge used to change width four ways: it
 * rendered no glyph at all for `idle` (so `size-icon-sm` plus the row's `gap-1`
 * arrived with the first status), and "Schema stale" and "No schema" are longer
 * words than "Schema". Pressing Refresh walks it ready -> loading -> ready,
 * which slid the button out from under the pointer that had just pressed it -
 * twice - and a second press landed on the toggle beside it.
 *
 * jsdom lays nothing out, so the width itself is unobservable (the same limit
 * `tabs.test.tsx` hits for its own tab marks). Unlike those marks, this badge
 * keeps its width genuinely reserved rather than animated - it sits before a
 * button a user has just pressed, and a track growing into place would still
 * slide Refresh out from under a second click while it animates. The mechanism
 * is: the badge is the same node in every state, its glyph box is always
 * present and only its contents change, and every word it can say has a
 * hidden twin holding the column open.
 *
 * Mutation check (confirmed): restore `if (status === "idle") return null` in
 * `SchemaStatusBadge` and "is the same node…" fails on the absent badge; drop
 * the glyph `<span>` wrapper and "keeps a glyph box in every state" fails; swap
 * the `LabelSwap` for a bare `{word}` and "reserves every word it can say"
 * fails.
 */
describe("the schema badge holds its own width", () => {
	const glyphBox = () => schemaBadge()?.querySelector("[data-slot='schema-status-glyph']");

	/*
	 * Every class but the tone. The colour *is* meant to change with the state -
	 * it costs no width - so pinning the whole list would assert the opposite of
	 * what the badge is for. What must not change is anything that sizes the box.
	 */
	const TONE = /^text-(muted-foreground|success-text|warning-text|destructive-text)$/;
	const layoutClasses = (el: Element) =>
		el.className
			.split(/\s+/)
			.filter((c) => c !== "" && !TONE.test(c))
			.sort()
			.join(" ");
	const reservedWords = () =>
		Array.from(
			schemaBadge()?.querySelectorAll("[data-slot='label-swap-reserve']") ?? [],
			(el) => el.textContent ?? ""
		).sort();

	it("reserves every word it can say, whatever it is saying now", () => {
		seed({ status: "ready", schema, fetchedAt: Date.now() });
		renderBody();
		// The set, not a hand-picked widest - which of the three is widest is a
		// measurement, and a measurement written into a class rots.
		expect(reservedWords()).toEqual(["No schema", "Schema", "Schema stale"]);
	});

	it("keeps a glyph box in every state, empty only while idle", () => {
		renderBody();
		expect(glyphBox(), "no glyph box - the first status will widen the row").not.toBeNull();
		expect(glyphBox()?.textContent).toBe("");
		// Silent either way: the word carries the meaning, the glyph repeats it.
		expect(glyphBox()?.getAttribute("aria-hidden")).toBe("true");

		cleanup();
		seed({ status: "ready", schema, fetchedAt: Date.now() });
		renderBody();
		expect(glyphBox()?.querySelector("svg")).not.toBeNull();
	});

	it("is the same node, with the same classes, across a refresh", () => {
		seed({ status: "ready", schema, fetchedAt: Date.now() });
		renderBody();
		const badge = schemaBadge()!;
		const badgeClasses = layoutClasses(badge);
		const box = glyphBox()!;

		// What pressing Refresh does to the cache, in the order it does it.
		act(() => seed({ status: "loading", schema, fetchedAt: Date.now() }));
		expect(schemaBadge(), "the badge remounted while loading").toBe(badge);
		expect(glyphBox(), "the glyph box remounted while loading").toBe(box);
		expect(layoutClasses(badge), "the badge restyled while loading").toBe(badgeClasses);
		expect(schemaWord()).toBe("Schema");

		act(() =>
			seed({
				status: "error",
				schema,
				error: { kind: "network", message: "unreachable" },
				fetchedAt: Date.now(),
			})
		);
		expect(schemaBadge(), "the badge remounted on failure").toBe(badge);
		expect(glyphBox(), "the glyph box remounted on failure").toBe(box);
		expect(layoutClasses(badge), "the badge restyled on failure").toBe(badgeClasses);
		// The word is the one thing that may change - inside a cell whose width
		// the twins above already hold open.
		expect(schemaWord()).toBe("Schema stale");
	});
});
