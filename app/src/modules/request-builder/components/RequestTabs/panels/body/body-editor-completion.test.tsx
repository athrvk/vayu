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
 * **The modes come from `BODY_MODES`, not from a list here.** The first version
 * of this guard named `json` / `text` / `graphql`, so `xml` - a mode the picker
 * had offered all along - was never rendered and its missing completion was
 * invisible to the very test written to catch it (#1214). A literal list of
 * modes in the test is the same drift as a literal list of languages in the
 * hook, one file further out; only the picker's own table knows what a body can
 * be.
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
import { BODY_MODES } from "./body-modes";
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

/** Every mode the picker offers, in the picker's own order. */
const ALL_MODES = BODY_MODES.map((mode) => mode.value);

/** The two modes that render the key/value table instead of an editor. */
const TABLE_MODES: BodyMode[] = ["form-data", "x-www-form-urlencoded"];

/**
 * The modes that mount no Monaco editor at all, and are therefore not covered
 * by `BODY_LANGUAGES`. Deliberately a literal: a mode's own row cannot say
 * whether it edits text, so a new mode either mounts an editor (and is checked
 * below) or is added here by someone who decided it should not.
 */
const NON_EDITOR_MODES: BodyMode[] = ["none", ...TABLE_MODES];

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
	it("has modes to check, and every non-editor mode is one of them", () => {
		// The loops below derive their input; an empty or renamed table would
		// make each of them pass while reading nothing.
		expect(ALL_MODES.length).toBeGreaterThan(0);
		expect(ALL_MODES).toEqual(expect.arrayContaining(NON_EDITOR_MODES));
	});

	it.each(ALL_MODES)("%s is one the completion provider is registered for", async (bodyMode) => {
		await renderMode(bodyMode);

		// A mode that mounted no editor would pass the loop below vacuously, so
		// each mode has to mount what its row implies: an editor, or the table.
		expect(mounted.length > 0).toBe(!NON_EDITOR_MODES.includes(bodyMode));
		for (const language of mounted) {
			expect(BODY_LANGUAGES).toContain(language);
		}
	});

	it("covers the whole list between them, so no entry is dead", async () => {
		// The mirror of the check above: `BODY_LANGUAGES` must not accumulate
		// languages nothing mounts, which is how the list would start drifting.
		const seen = new Set<string>();
		for (const bodyMode of ALL_MODES) {
			const { unmount } = await renderMode(bodyMode);
			mounted.forEach((l) => seen.add(l));
			mounted.length = 0;
			unmount();
		}
		expect([...seen].sort()).toEqual([...BODY_LANGUAGES].sort());
	});
});

describe("the modes with no code editor", () => {
	it.each(TABLE_MODES)(
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
