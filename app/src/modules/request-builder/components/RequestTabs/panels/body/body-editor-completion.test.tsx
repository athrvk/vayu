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
 * `{{` completion reaches every body editor, and stays reaching them.
 *
 * A Monaco completion provider is registered **per language, globally** - one
 * call in `App` covers every editor instance. So whether a given editor offers
 * variables is decided entirely by the `language` string it happens to mount
 * with, and `BODY_LANGUAGES` is a hand-written list of those strings sitting
 * several files away from the components that choose them.
 *
 * Nothing connects the two but matching text. Add a body mode that mounts, say,
 * `xml`, and completion is simply absent there - no error, no failing test, and
 * the editors that do work go on working, so it looks fine.
 *
 * This renders each mode and reads the `language` the editor actually asked
 * for, rather than scanning the source: `BodyPanel` picks its language with an
 * inline conditional today, but the moment that moves into a variable or a
 * lookup table a source scan goes quietly green. That exact failure has
 * happened here before with class names arriving through bindings.
 *
 * The form modes are not Monaco at all - `form-data` and
 * `x-www-form-urlencoded` render the key/value table, whose cells are
 * `VariableInput`, which pops the same list from the same rule in
 * `lib/variable-completion.ts`. Asserted below so the coverage claim is about
 * the whole panel, not just the code editors.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { BODY_LANGUAGES } from "@/hooks/useVariableCompletionProvider";
import { RequestBuilderContext } from "../../../../context";
import type { RequestBuilderContextValue, RequestState, BodyMode } from "../../../../types";
import { createDefaultRequestState } from "../../../../utils/request-state";
import { emptyDrafts } from "../../../../utils/body-drafts";

/** Every `language` a `CodeEditor` mounted with during a render. */
const mounted: string[] = [];

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ language }: { language?: string }) => {
		if (language) mounted.push(language);
		return <div data-testid="code-editor" />;
	},
}));

const { default: BodyPanel } = await import("../BodyPanel");

/*
 * `GraphQLBody` is lazy since #1146, so BodyPanel first renders it as the
 * Suspense fallback - no editors, nothing to find - and only mounts the real
 * component once the chunk resolves. The chunk itself is loaded here rather
 * than left for the first render to discover, so only React's own one-tick
 * retry is left; the `act` flush below is what commits it.
 */
await import("./GraphQLBody");

async function renderMode(bodyMode: BodyMode, overrides: Partial<RequestState> = {}) {
	const request = { ...createDefaultRequestState(), bodyMode, ...overrides };
	const value = {
		request,
		updateField: vi.fn(),
		// BodyPanel stashes through these on a mode change.
		getBodyDrafts: () => emptyDrafts(request.id),
		setBodyDrafts: () => {},
		getVariablesDraft: () => null,
		setVariablesDraft: () => {},
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		writableScopes: [],
		updateVariable: () => {},
	} as unknown as RequestBuilderContextValue;

	const result = render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<BodyPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
	await act(async () => {});
	return result;
}

beforeEach(() => {
	mounted.length = 0;
});

describe("the languages the body editors mount with", () => {
	it.each([
		["json", 1],
		["text", 1],
		["graphql", 2], // the query pane and the variables pane
	] as const)("%s is one the completion provider is registered for", async (bodyMode, count) => {
		await renderMode(bodyMode);

		// A mode that mounted no editor would pass a `.every()` vacuously.
		expect(mounted).toHaveLength(count);
		for (const language of mounted) {
			expect(BODY_LANGUAGES).toContain(language);
		}
	});

	it("covers the whole list between them, so no entry is dead", async () => {
		// The mirror of the check above: `BODY_LANGUAGES` must not accumulate
		// languages nothing mounts, which is how the list would start drifting.
		const seen = new Set<string>();
		for (const bodyMode of ["json", "text", "graphql"] as const) {
			await renderMode(bodyMode);
			mounted.forEach((l) => seen.add(l));
			mounted.length = 0;
		}
		expect([...seen].sort()).toEqual([...BODY_LANGUAGES].sort());
	});
});

describe("the modes with no code editor", () => {
	it.each(["form-data", "x-www-form-urlencoded"] as const)(
		"%s uses the key/value table, whose cells complete variables themselves",
		async (bodyMode) => {
			await renderMode(bodyMode, {
				formData: [{ id: "1", key: "merchant", value: "{{merchant}}", enabled: true }],
				urlEncoded: [{ id: "1", key: "merchant", value: "{{merchant}}", enabled: true }],
			});

			// No Monaco here at all - so `BODY_LANGUAGES` is not what covers these.
			expect(mounted).toHaveLength(0);
			expect(screen.getAllByDisplayValue("{{merchant}}").length).toBeGreaterThan(0);
		}
	);

	it("mounts nothing for none, which sends no body", async () => {
		await renderMode("none");
		expect(mounted).toHaveLength(0);
	});
});
