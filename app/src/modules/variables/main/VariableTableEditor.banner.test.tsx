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
 * The info banner states the precedence ladder, not its inverse (#1880).
 *
 * `docs/app/variable-resolution.md` is the contract: globals < collection
 * chain < active environment < bound data row. The banners once told the user
 * a collection variable had "the highest priority", the opposite of what
 * `/compose` does.
 *
 * Mutation-check: restore the old environment banner ("...overridden by
 * collection scope.") or the old collection banner ("...highest priority...")
 * and the matching case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui";
import VariableTableEditor from "./VariableTableEditor";
import type { Collection, Environment } from "@/types";

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useSetActiveEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useDeleteEnvironmentMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn(),
		isPending: false,
	}),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	return {
		useSaveStore: saveStore.useSaveStore,
		useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
	};
});

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

const collection: Collection = {
	id: "col_1",
	name: "demo",
	description: "",
	order: 0,
	variables: {},
	auth: { mode: "none" },
	elements: [],
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

const environment: Environment = {
	id: "env_1",
	name: "staging",
	description: "",
	isActive: false,
	variables: {},
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

function renderEditor(config: React.ComponentProps<typeof VariableTableEditor>["config"]) {
	return render(
		<TooltipProvider>
			<VariableTableEditor config={config} />
		</TooltipProvider>
	);
}

/** The banner is the one element whose text reads "Variables in this scope". */
function bannerText(): string {
	const banner = screen.getByText(/^Variables in this scope/);
	expect(banner.textContent).not.toBe("");
	return banner.textContent ?? "";
}

describe("the Variables pane info banner", () => {
	it("tells an environment it overrides collections and globals", () => {
		renderEditor({ type: "environment", environment });

		const text = bannerText();
		expect(text).toMatch(/override collection/i);
		expect(text).not.toMatch(/overridden by collection/i);
		expect(text).not.toMatch(/highest priority/i);
	});

	it("tells a collection it is overridden by the active environment", () => {
		renderEditor({ type: "collection", collection });

		const text = bannerText();
		expect(text).toMatch(/overridden by the active environment/i);
		expect(text).not.toMatch(/overridden by collection/i);
		expect(text).not.toMatch(/highest priority/i);
	});
});
