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
 * The builder's editor state in the `editorDraft` slot (#2638), which the
 * context bar's Code section composes from.
 *
 * The read has to be the draft *as edited* and its collection chain, published
 * once per request rather than once per keystroke, gone when the builder goes,
 * and refused for any request but its own. The provider is mocked down to the
 * seams `send-request-command-surface.test.tsx` uses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { RequestBuilderProvider, useRequestBuilderContext } from "./context";
import EditorDraftSurface from "./components/EditorDraftSurface";
import { editorDraftFor, useLiveCommandSurfaceStore } from "@/lib/commands/live-surfaces";
import type { Collection } from "@/types";
import type { RequestState } from "./types";

const CHAIN = [{ id: "col_1", name: "Users", elements: [] }] as unknown as Collection[];
const ancestorsFor = (collectionId: string | null | undefined) =>
	collectionId === "col_1" ? CHAIN : [];

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

vi.mock("@/queries", () => ({
	useElementKindsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: (collectionId: string | null | undefined) => ancestorsFor(collectionId),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

/** Edits the draft the way the URL bar does. */
function UrlEditor() {
	const { updateField } = useRequestBuilderContext();
	return <button onClick={() => updateField("url", "https://api.test/edited")}>edit url</button>;
}

function Harness({ id = "req_1" }: { id?: string }) {
	const initialRequest: Partial<RequestState> = {
		id,
		name: "Charge card",
		url: "https://api.test/saved",
	};
	return (
		<RequestBuilderProvider initialRequest={initialRequest} collectionId="col_1">
			<UrlEditor />
			<EditorDraftSurface />
		</RequestBuilderProvider>
	);
}

const published = () => useLiveCommandSurfaceStore.getState().editorDraft;

beforeEach(() => {
	useLiveCommandSurfaceStore.setState({ editorDraft: null });
});

describe("the request builder publishes its editor state for the Code section", () => {
	it("publishes nothing until a builder is mounted", () => {
		expect(published()).toBeNull();
		expect(editorDraftFor("req_1")).toBeUndefined();
	});

	it("names its request and reads the draft as edited, with its collection's chain", () => {
		render(<Harness />);
		expect(published()?.requestId).toBe("req_1");

		act(() => screen.getByText("edit url").click());

		const draft = editorDraftFor("req_1");
		expect(draft?.request.url).toBe("https://api.test/edited");
		expect(draft?.ancestors).toBe(CHAIN);
	});

	it("keeps one publication across edits, so typing does not churn the store", () => {
		render(<Harness />);
		const first = published();

		act(() => screen.getByText("edit url").click());

		expect(published()).toBe(first);
	});

	it("answers for its own request only", () => {
		render(<Harness />);
		expect(editorDraftFor("req_2")).toBeUndefined();
	});

	it("republishes under the new id when the builder switches request", () => {
		const { rerender } = render(<Harness />);
		const first = published();

		rerender(<Harness id="req_2" />);

		expect(published()).not.toBe(first);
		expect(published()?.requestId).toBe("req_2");
		expect(editorDraftFor("req_1")).toBeUndefined();
		expect(editorDraftFor("req_2")?.request.id).toBe("req_2");
	});

	it("clears the slot on unmount, so a closed tab leaves no draft behind", () => {
		const { unmount } = render(<Harness />);
		expect(published()).not.toBeNull();

		unmount();

		expect(published()).toBeNull();
		expect(editorDraftFor("req_1")).toBeUndefined();
	});

	it("leaves the clear to the current holder, so a remount out of order still stands", () => {
		render(<Harness />);
		const current = published();

		act(() =>
			useLiveCommandSurfaceStore.getState().clearSurface("editorDraft", {
				requestId: "req_1",
				read: () => ({ request: {} as RequestState, ancestors: [] }),
			})
		);

		expect(published()).toBe(current);
	});
});
