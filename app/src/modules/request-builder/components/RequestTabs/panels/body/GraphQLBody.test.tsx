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
import { render, screen, cleanup } from "@testing-library/react";
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
				schemaTarget={TARGET}
				onEditorMount={() => {}}
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

describe("the schema badge", () => {
	it("names the failure and what to do about it, per kind", () => {
		seed({ status: "error", error: { kind: "auth", message: "HTTP 401." } });
		renderBody();

		const badge = screen.getByText("No schema");
		// Both halves: the actionable sentence this kind gets, and the engine's
		// own words. Neither is inferable from the other.
		expect(badge.getAttribute("title")).toMatch(/credentials were rejected/i);
		expect(badge.getAttribute("title")).toContain("HTTP 401.");
	});

	it("says something different for an endpoint that disallows introspection", () => {
		seed({
			status: "error",
			error: { kind: "unsupported", message: "introspection is not allowed" },
		});
		renderBody();
		const title = screen.getByText("No schema").getAttribute("title") ?? "";
		expect(title).toMatch(/does not allow introspection/i);
		// The auth wording is the one this must not be confused with.
		expect(title).not.toMatch(/credentials were rejected/i);
	});

	it("shows how old the schema is once one has loaded", () => {
		seed({ status: "ready", schema, fetchedAt: Date.now() - 5 * 60 * 1000 });
		renderBody();
		expect(screen.getByText("Schema").getAttribute("title")).toMatch(/5m ago/);
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

		expect(screen.queryByText("No schema")).toBeNull();
		const badge = screen.getByText("Schema stale");
		expect(badge.getAttribute("title")).toMatch(/could not be reached/i);
		expect(badge.getAttribute("title")).toMatch(/1m ago/);
	});

	it("shows nothing at all before an endpoint has been introspected", () => {
		renderBody();
		expect(screen.queryByText("Schema")).toBeNull();
		expect(screen.queryByText("No schema")).toBeNull();
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
