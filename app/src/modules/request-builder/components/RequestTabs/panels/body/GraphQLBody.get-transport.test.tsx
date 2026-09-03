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
 * What the Query header says about a GraphQL request that will be sent as a
 * `GET` (issue #1228).
 *
 * The transport is the engine's (`graphql_get_parameters`), and the mode
 * switch keeps a request built in the app from reaching it by accident - but a
 * `GET` a user picked, or one an import wrote, still gets there, and used to
 * do so with nothing on screen saying what would happen. These pin the notice
 * to the method, in both directions: rendering it is half a rule, and the
 * half that goes wrong later is the one that never stops rendering.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { SchemaTarget } from "@/lib/graphql/schema-cache";
import type { HttpMethod } from "@/types";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ language, value }: { language: string; value: string }) => (
		<div data-testid={`editor-${language}`}>{value}</div>
	),
}));

const { GraphQLBody } = await import("./GraphQLBody");

const TARGET: SchemaTarget = { url: "" } as unknown as SchemaTarget;

const NOTICE = /Sent as query parameters/;

function renderWith(method: HttpMethod) {
	return render(
		<TooltipProvider>
			<GraphQLBody
				body="query Me { me { id } }"
				onBodyChange={() => {}}
				requestId="r1"
				schemaTarget={TARGET}
				onEditorMount={() => {}}
				method={method}
				variablesDraft={null}
				onVariablesDraftChange={() => {}}
			/>
		</TooltipProvider>
	);
}

afterEach(cleanup);

describe("the GET transport notice", () => {
	// The sentence names both halves: what a GET does with the document, and
	// which method a mutation needs. A notice that only said "GET is wrong"
	// would be wrong itself - a query over GET is what the specification is
	// for.
	it("names the transport and the method a mutation needs, on a GET", () => {
		renderWith("GET");

		const badge = screen.getByText(NOTICE);
		expect(badge).toBeTruthy();
		expect(badge.closest("[title]")?.getAttribute("title")).toContain("query parameters");
		expect(badge.closest("[title]")?.getAttribute("title")).toContain("POST");
	});

	// The half that decays: a notice keyed on nothing keeps describing a
	// transport the request no longer uses. Mutation check: drop the method
	// guard in `GetTransportBadge` and this reddens while the case above stays
	// green.
	it("is absent on every method that carries the envelope in a body", () => {
		renderWith("POST");
		expect(screen.queryByText(NOTICE)).toBeNull();
		cleanup();

		renderWith("PUT");
		expect(screen.queryByText(NOTICE)).toBeNull();
	});
});
