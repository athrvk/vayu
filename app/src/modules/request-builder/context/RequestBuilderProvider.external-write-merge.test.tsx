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
 * The request builder's draft has to adopt an external write - typically an
 * MCP agent's `update_request` landing while the tab is open - for every
 * field, not only `name` (issue #1436). `RequestBuilderProvider.name-sync.test.tsx`
 * already covers the field this generalizes from; this file covers the
 * generalization itself:
 *
 *   - an untouched field adopts the external value silently, without being
 *     marked dirty (a save scheduled by adoption would write back what it
 *     just read);
 *   - a field the user has touched is left alone when the fetch disagrees,
 *     and the incoming value is surfaced as a conflict for "Take theirs" to
 *     resolve;
 *   - two different fields are independent: an adopt on one must not disturb
 *     a dirty edit on another;
 *   - a request moved to a different collection (the `move_item` case)
 *     updates just `collectionId` in place, keeping the rest of a dirty draft;
 *   - a request deleted elsewhere disables the save manager, so its autosave
 *     timer cannot fire a PUT against an id that now 404s;
 *   - a foreign write landing while a save is in flight bumps the generation,
 *     so the save cannot claim the request clean over a field the merge just
 *     changed underneath its response.
 *
 * The harness mirrors `RequestBuilderProvider.save-generation.test.tsx`: a
 * mocked `useSaveManager` that hands back its options for the test to drive
 * and read, and a mocked `useVariableResolver` since none of this is about
 * resolution.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import type { RequestState } from "../types";

let managerOptions: {
	onSave: () => Promise<void>;
	hasChanges: boolean;
	changeToken: number;
	enabled: boolean;
};

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useSaveManager: (options: {
		onSave: () => Promise<void>;
		hasChanges: boolean;
		changeToken: number;
		enabled: boolean;
	}) => {
		managerOptions = options;
		return { forceSave: vi.fn(), status: "idle", isSaving: false };
	},
}));

vi.mock("@/queries", () => ({
	// RequestBuilderProvider now reads the catalogue itself (issue #1635); an
	// empty list means "nothing required", so the save-skip check is inert.
	useElementKindsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

/** Shows the fields these cases touch, and offers the writes they make. */
function FieldProbe() {
	const { request, updateField, hasUnsavedChanges, fieldConflicts, takeExternalField } =
		useRequestBuilderContext();
	return (
		<>
			<span data-testid="url">{request.url}</span>
			<span data-testid="description">{request.description}</span>
			<span data-testid="collectionId">{request.collectionId}</span>
			<span data-testid="dirty">{String(hasUnsavedChanges)}</span>
			<span data-testid="conflicts">{Object.keys(fieldConflicts).sort().join(",")}</span>
			<span data-testid="conflict-url">{String(fieldConflicts.url ?? "")}</span>
			<button onClick={() => updateField("url", "https://typed.test/mine")}>type url</button>
			<button onClick={() => updateField("description", "typed description")}>
				type description
			</button>
			<button onClick={() => takeExternalField("url")}>take theirs: url</button>
		</>
	);
}

function Harness({
	initialRequest,
	collectionId,
	onSave,
}: {
	initialRequest?: Partial<RequestState>;
	collectionId?: string | null;
	onSave?: (request: RequestState, changed: ReadonlySet<string>) => Promise<void>;
}) {
	return (
		<RequestBuilderProvider
			initialRequest={initialRequest}
			collectionId={collectionId ?? "col_1"}
			onSave={onSave}
		>
			<FieldProbe />
		</RequestBuilderProvider>
	);
}

const shown = (testId: string) => screen.getByTestId(testId).textContent;
const click = (label: string) => act(() => screen.getByText(label).click());

describe("the request builder's draft adopts an external write per field", () => {
	it("adopts an untouched field silently, without marking the tab dirty", () => {
		const { rerender } = render(
			<Harness initialRequest={{ id: "req_1", url: "https://api.test/a" }} />
		);
		expect(shown("url")).toBe("https://api.test/a");

		// An MCP agent's update_request landing on the same request.
		act(() =>
			rerender(<Harness initialRequest={{ id: "req_1", url: "https://api.test/b" }} />)
		);

		expect(shown("url")).toBe("https://api.test/b");
		expect(shown("dirty")).toBe("false");
		expect(shown("conflicts")).toBe("");
	});

	it("keeps the user's edit and flags a conflict when the same field changed on both sides", () => {
		const { rerender } = render(
			<Harness initialRequest={{ id: "req_1", url: "https://api.test/a" }} />
		);

		click("type url");
		expect(shown("url")).toBe("https://typed.test/mine");

		act(() =>
			rerender(<Harness initialRequest={{ id: "req_1", url: "https://api.test/agent" }} />)
		);

		// The user's edit is kept, not silently overwritten either direction.
		expect(shown("url")).toBe("https://typed.test/mine");
		expect(shown("conflicts")).toBe("url");
		expect(shown("conflict-url")).toBe("https://api.test/agent");

		click("take theirs: url");

		expect(shown("url")).toBe("https://api.test/agent");
		expect(shown("conflicts")).toBe("");
	});

	it("adopts one field while a different field stays dirty from the user's own edit", () => {
		const { rerender } = render(
			<Harness
				initialRequest={{
					id: "req_1",
					url: "https://api.test/a",
					description: "old description",
				}}
			/>
		);

		click("type description");
		expect(shown("dirty")).toBe("true");

		act(() =>
			rerender(
				<Harness
					initialRequest={{
						id: "req_1",
						url: "https://api.test/agent",
						description: "old description",
					}}
				/>
			)
		);

		// The untouched field adopts; the touched one is untouched by the merge.
		expect(shown("url")).toBe("https://api.test/agent");
		expect(shown("description")).toBe("typed description");
		expect(shown("conflicts")).toBe("");
		expect(shown("dirty")).toBe("true");
	});

	it("moves collectionId in place, keeping the rest of a dirty draft (the move_item case)", () => {
		const { rerender } = render(
			<Harness
				initialRequest={{ id: "req_1", url: "https://api.test/a" }}
				collectionId="col_1"
			/>
		);

		click("type description");
		expect(shown("dirty")).toBe("true");

		act(() =>
			rerender(
				<Harness
					initialRequest={{ id: "req_1", url: "https://api.test/a" }}
					collectionId="col_2"
				/>
			)
		);

		expect(shown("collectionId")).toBe("col_2");
		// The reset-on-id-change path would have thrown this away; the move path
		// must not.
		expect(shown("description")).toBe("typed description");
		expect(shown("dirty")).toBe("true");
	});

	it("disables the save manager once the request is deleted elsewhere", () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { rerender } = render(
			<Harness initialRequest={{ id: "req_1", url: "https://api.test/a" }} onSave={onSave} />
		);
		expect(managerOptions.enabled).toBe(true);

		click("type description");
		expect(shown("dirty")).toBe("true");

		// `index.tsx` keeps the provider mounted but stops handing it an
		// `initialRequest` once the fetch 404s.
		act(() => rerender(<Harness initialRequest={undefined} onSave={onSave} />));

		expect(managerOptions.enabled).toBe(false);
	});

	it("bumps the generation on a foreign write during an in-flight save, so the save cannot claim the request clean", async () => {
		// Same shape as `RequestBuilderProvider.save-generation.test.tsx`'s
		// `heldSave()`: a save this test holds open by hand, so a foreign write
		// can land while it is still in flight.
		let release!: () => void;
		const pending = new Promise<void>((r) => {
			release = r;
		});
		const onSave = vi.fn(() => pending);

		const { rerender } = render(
			<Harness initialRequest={{ id: "req_1", url: "https://api.test/a" }} onSave={onSave} />
		);

		click("type description");
		const savedGeneration = managerOptions.changeToken;
		// `void`, not awaited: `act` must run this synchronously, up to the
		// `await onSave(...)` inside `handleSave`, or it treats the callback as
		// async and returns before the foreign write below is even applied.
		act(() => void managerOptions.onSave());

		// A foreign write for a *different*, untouched field lands mid-flight.
		act(() =>
			rerender(
				<Harness
					initialRequest={{ id: "req_1", url: "https://api.test/agent" }}
					onSave={onSave}
				/>
			)
		);
		expect(managerOptions.changeToken).not.toBe(savedGeneration);
		expect(shown("url")).toBe("https://api.test/agent");

		await act(async () => {
			release();
			await pending;
		});

		// The save's response cannot be trusted to describe the merge that
		// happened after it was sent, so the request must still read dirty.
		expect(shown("dirty")).toBe("true");
		expect(managerOptions.hasChanges).toBe(true);
	});
});
