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
 * Issue #1635: `buildUpdatePayload` sends the whole `elements` array whenever
 * it is touched, and the engine 400s the *entire* payload if any one element
 * is missing a required config key - which is exactly what a freshly added
 * element has. `RequestBuilderProvider`'s `handleSave` (the function it hands
 * `useSaveManager` as `onSave`) is the one place that sees both the touched
 * fields and the element list before a payload goes out, so it is where the
 * skip belongs.
 *
 * Mutation check: comment out the `hasIncompleteElement` guard in
 * `RequestBuilderProvider.tsx`'s `handleSave` and the first two cases below
 * redden - the outer `onSave` prop would be called with the incomplete
 * element still in `elements`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import type { RequestState, MergeableRequestField } from "../types";
import type { ElementKindSchema } from "@/types";

type OnSave = (
	request: RequestState,
	changedFields: ReadonlySet<MergeableRequestField>
) => Promise<void>;

/** The options the provider handed the save manager on the last render. */
let managerOptions: { onSave: () => Promise<void>; hasChanges: boolean; changeToken: number };

const REQUIRED_KIND: ElementKindSchema = {
	kind: "extract.json",
	version: 1,
	label: "Extract JSON",
	description: "",
	category: "extract",
	hotPathClass: "declarative",
	collectionOnly: false,
	configSchema: { type: "object", required: ["variable"] },
	phases: [],
};

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: (options: {
		onSave: () => Promise<void>;
		hasChanges: boolean;
		changeToken: number;
	}) => {
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
	useElementKindsQuery: () => ({ data: [REQUIRED_KIND] }),
}));

/** Reads the dirty flag and offers the one edit each case makes. */
function ElementsProbe() {
	const { request, updateField, hasUnsavedChanges } = useRequestBuilderContext();
	return (
		<>
			<span data-testid="dirty">{String(hasUnsavedChanges)}</span>
			<span data-testid="element-count">{request.elements.length}</span>
			<button
				onClick={() =>
					updateField("elements", [
						{ id: "el_1", kind: "extract.json", enabled: true, config: {} },
					])
				}
			>
				add incomplete element
			</button>
			<button
				onClick={() =>
					updateField("elements", [
						{
							id: "el_1",
							kind: "extract.json",
							enabled: true,
							config: { variable: "token" },
						},
					])
				}
			>
				fill in the field
			</button>
			<button onClick={() => updateField("name", "renamed")}>edit something else</button>
		</>
	);
}

const dirty = () => screen.getByTestId("dirty").textContent;
const click = (label: string) => act(() => screen.getByText(label).click());
// `handleSave` (what `managerOptions.onSave` is here) throws `SaveBlockedError`
// when the elements list is incomplete - `useSaveManager.performSave` is what
// catches that in the real app; standing in for it here the same way lets
// `act` await the rejection instead of letting it escape as unhandled.
const save = () => act(() => managerOptions.onSave().catch(() => {}));

describe("a save the elements list makes known-incomplete", () => {
	let onSave: ReturnType<typeof vi.fn<OnSave>>;

	beforeEach(() => {
		onSave = vi.fn<OnSave>().mockResolvedValue(undefined);
		const initialRequest: Partial<RequestState> = { id: "req_1", name: "Req" };
		render(
			<RequestBuilderProvider
				initialRequest={initialRequest}
				collectionId="col_1"
				onSave={onSave}
			>
				<ElementsProbe />
			</RequestBuilderProvider>
		);
	});

	it("skips the network call rather than sending the incomplete element", async () => {
		click("add incomplete element");
		await save();

		expect(onSave).not.toHaveBeenCalled();
	});

	it("keeps the request dirty, so nothing is silently dropped", async () => {
		click("add incomplete element");
		await save();

		expect(dirty()).toBe("true");
		expect(managerOptions.hasChanges).toBe(true);
	});

	it("still skips a save that touches an unrelated field, while the element stays incomplete", async () => {
		click("add incomplete element");
		click("edit something else");
		await save();

		expect(onSave).not.toHaveBeenCalled();
	});

	it("saves normally, carrying every edit made while blocked, once the field is filled in", async () => {
		click("add incomplete element");
		click("edit something else");
		await save();
		expect(onSave).not.toHaveBeenCalled();

		click("fill in the field");
		await save();

		expect(onSave).toHaveBeenCalledTimes(1);
		const [sentRequest, sentFields] = onSave.mock.calls[0] as [
			RequestState,
			ReadonlySet<string>,
		];
		expect(sentRequest.elements[0].config).toEqual({ variable: "token" });
		// The rename from while it was blocked is still in the payload - the
		// skip must not have dropped it.
		expect(sentFields.has("name")).toBe(true);
		expect(sentRequest.name).toBe("renamed");
		expect(dirty()).toBe("false");
	});
});
