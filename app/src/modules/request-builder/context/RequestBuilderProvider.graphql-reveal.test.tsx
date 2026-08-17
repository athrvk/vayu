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
 * The provider's part in the outline's click-to-scroll: bringing the Body tab
 * forward, and dropping a command nothing under it can serve.
 *
 * It is here rather than in `BodyPanel` because the editor only exists while
 * the Body tab is on screen - Radix unmounts every other panel - so a click
 * from the Headers tab has nothing to scroll until the tab comes back. The
 * scrolling itself belongs to `GraphQLBody` (`GraphQLBody.reveal.test.tsx`),
 * which is also what clears a served command; what is guarded here is the tab
 * and the commands that would otherwise sit in the slot forever.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useEffect } from "react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { useRevealStore, type OperationRevealCommand } from "@/lib/graphql/reveal-store";
import type { BodyMode, RequestState } from "../types";

// The provider is wired to variable resolution, the save manager and several
// TanStack Query hooks. None of them matter to which tab is on screen.
vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
	}),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
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
	// The provider reads the engine data caps for Send-with-row's row cap
	// (`useDataFileLimits`); empty entries leave it on the seeds.
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

/** The tab the provider currently has on screen. */
const seen = { activeTab: "" };

function TabWatcher() {
	const { activeTab } = useRequestBuilderContext();
	useEffect(() => {
		seen.activeTab = activeTab;
	}, [activeTab]);
	return null;
}

function mount(id: string | null, bodyMode: BodyMode) {
	render(
		<RequestBuilderProvider
			initialRequest={{ id, name: "r", bodyMode } as Partial<RequestState>}
		>
			<TabWatcher />
		</RequestBuilderProvider>
	);
}

const reveal = (command: OperationRevealCommand) =>
	act(() => {
		useRevealStore.getState().revealOperation(command);
	});

beforeEach(() => {
	seen.activeTab = "";
	useRevealStore.setState({ pending: null });
});

describe("a reveal command for the request on screen", () => {
	it("brings the Body tab forward, since the editor is unmounted anywhere else", () => {
		mount("r1", "graphql");
		expect(seen.activeTab).toBe("params");

		reveal({ requestId: "r1", name: "Users", index: 0 });
		expect(seen.activeTab).toBe("body");
	});

	it("leaves the command in the slot for the editor to serve", () => {
		mount("r1", "graphql");
		const command: OperationRevealCommand = { requestId: "r1", name: "Users", index: 0 };
		reveal(command);

		// Clearing here would race `GraphQLBody`, which is mounting for the first
		// time in the case this exists for and has not read the slot yet.
		expect(useRevealStore.getState().pending).toEqual(command);
	});
});

describe("a reveal command nothing here can serve", () => {
	it("drops another request's command rather than leaving it to replay", () => {
		mount("r2", "graphql");
		reveal({ requestId: "r1", name: "Users", index: 0 });

		expect(useRevealStore.getState().pending).toBeNull();
		expect(seen.activeTab).toBe("params");
	});

	it("drops a command for a request that no longer sends a GraphQL body", () => {
		// Mutation check: serve it anyway and the Body tab opens on a JSON editor
		// that will never consume the command, which then fires at the next
		// GraphQL request the user opens.
		mount("r1", "json");
		reveal({ requestId: "r1", name: "Users", index: 0 });

		expect(useRevealStore.getState().pending).toBeNull();
		expect(seen.activeTab).toBe("params");
	});
});
