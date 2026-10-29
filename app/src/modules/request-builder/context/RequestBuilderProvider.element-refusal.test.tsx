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
 * #3043: the engine refuses an element it cannot run with
 * `'<Kind label>' (item N): <problem>`. `RequestBuilderProvider`'s `handleSave`
 * is where the array that was sent and the error that came back meet, so it
 * hands the context an `elementErrors` map keyed by the refused element's id -
 * and still rethrows, because the toast and the Dock status are
 * `useSaveManager`'s.
 *
 * Mutation check: delete the `refuseElement` call in `handleSave` and the first
 * case reds; make `useElementRefusals` ignore the element's identity and the
 * "ends when the element is edited" case reds.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TestQueryClient } from "@/test/TestQueryClient";
import { render, screen, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { ApiError } from "@/services/http-client";
import type { RequestState, MergeableRequestField } from "../types";

type OnSave = (
	request: RequestState,
	changedFields: ReadonlySet<MergeableRequestField>
) => Promise<void>;

let managerOptions: { onSave: () => Promise<void> };

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: (options: { onSave: () => Promise<void> }) => {
		managerOptions = options;
		return { forceSave: vi.fn(), status: "idle", isSaving: false };
	},
}));

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
	// No catalogue: the completeness gate has nothing to hold the save back with.
	useElementKindsQuery: () => ({ data: [] }),
}));

const REGEX_ELEMENT = {
	id: "el_1",
	kind: "extract.regex",
	enabled: true,
	config: { pattern: "(", variable: "v", source: "body" },
};

function Probe() {
	const { elementErrors, updateField } = useRequestBuilderContext();
	return (
		<>
			<span data-testid="errors">{JSON.stringify(elementErrors)}</span>
			<button onClick={() => updateField("elements", [REGEX_ELEMENT])}>add element</button>
			<button
				onClick={() =>
					updateField("elements", [
						{ ...REGEX_ELEMENT, config: { ...REGEX_ELEMENT.config, pattern: "a" } },
					])
				}
			>
				edit element
			</button>
		</>
	);
}

const errors = () => JSON.parse(screen.getByTestId("errors").textContent ?? "null");
const click = (label: string) => act(() => screen.getByText(label).click());
/** What `useSaveManager.performSave` does with the rejection: nothing here. */
const save = () =>
	act(() =>
		managerOptions.onSave().then(
			() => null,
			(e: unknown) => e
		)
	);

describe("a save the engine refuses on one element (#3043)", () => {
	let onSave: ReturnType<typeof vi.fn<OnSave>>;

	beforeEach(() => {
		onSave = vi.fn<OnSave>();
		render(
			<TestQueryClient>
				<RequestBuilderProvider
					initialRequest={{ id: "req_1", name: "Req" }}
					collectionId="col_1"
					onSave={onSave}
				>
					<Probe />
				</RequestBuilderProvider>
			</TestQueryClient>
		);
		click("add element");
	});

	it("keys the engine's problem to the element it named, and still rethrows", async () => {
		const refusal = new ApiError(
			400,
			"INVALID_REQUEST",
			"'Extract with a regular expression' (item 1): 'pattern' is not a valid regular expression"
		);
		onSave.mockRejectedValue(refusal);

		const thrown = await save();

		expect(thrown).toBe(refusal);
		expect(errors()).toEqual({ el_1: "'pattern' is not a valid regular expression" });
	});

	it("ends the refusal when the element is edited", async () => {
		onSave.mockRejectedValue(
			new ApiError(
				400,
				"INVALID_REQUEST",
				"'Extract with a regular expression' (item 1): bad"
			)
		);
		await save();
		expect(errors()).toEqual({ el_1: "bad" });

		click("edit element");

		expect(errors()).toEqual({});
	});

	it.each([
		[
			"a 400 that names no item",
			new ApiError(400, "INVALID_REQUEST", "Request name is required"),
		],
		[
			"a refusal from a status other than 400",
			new ApiError(500, "INTERNAL", "'Extract with a regular expression' (item 1): bad"),
		],
		["a failure that is not an engine answer", new Error("fetch failed")],
	])("shows nothing for %s, and still rethrows", async (_name, error) => {
		onSave.mockRejectedValue(error);

		const thrown = await save();

		expect(thrown).toBe(error);
		expect(errors()).toEqual({});
	});
});
