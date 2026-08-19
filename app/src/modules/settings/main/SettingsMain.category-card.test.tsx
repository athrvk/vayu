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
 * An engine category can carry a card, and the Network one does (issue #707).
 *
 * The engine half of Settings renders `/config` entries and nothing else, so
 * the client-certificate registry - data with its own CRUD routes, which
 * `/config` does not describe - needed a way in. `EngineSettingsCategoryMeta`
 * grew an optional `Card`, and this asserts the two halves of that: the
 * category declares one, and the view mounts it.
 *
 * Both halves matter separately. Drop the render from `SettingsMain` and the
 * registry is unreachable while `engine-categories.ts` still claims it;
 * drop the declaration and the view goes on working for every other category.
 * The sibling `SettingsMain.*` files stub the card out because they are about
 * the shell - which is exactly why one file has to not stub it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";
import { ENGINE_SETTINGS_CATEGORIES } from "@/modules/settings/engine-categories";

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: [] }, isLoading: false, error: null }),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	// The card's own reads. Present rather than stubbing the component, because
	// what is under test is that the component is mounted at all.
	useClientCertificatesQuery: () => ({ data: [], isError: false }),
	useCreateClientCertificateMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteClientCertificateMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: () => ({ selectedCategory: "network_performance", restartRequiredKeys: [] }),
}));

vi.mock("@/stores", () => ({
	useEngineStore: () => ({
		isEngineConnected: true,
		pendingRestart: false,
		restartRequiredKeys: [],
		addRestartRequiredKey: vi.fn(),
		clearRestartRequired: vi.fn(),
	}),
	useToastStore: (selector: (s: { showToast: () => void }) => unknown) =>
		selector({ showToast: vi.fn() }),
}));

vi.mock("@/stores/save-store", () => ({
	useSaveStore: () => ({
		startSaving: vi.fn(),
		completeSaveThenIdle: vi.fn(),
		failSave: vi.fn(),
		setStatus: vi.fn(),
		markPendingSave: vi.fn(),
		registerContext: vi.fn(),
		unregisterContext: vi.fn(),
		setActiveContext: vi.fn(),
		updateContext: vi.fn(),
	}),
}));

function renderSettings() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SettingsMain />
		</QueryClientProvider>
	);
}

describe("an engine category's cards", () => {
	it("are declared on Network & connectivity", () => {
		const network = ENGINE_SETTINGS_CATEGORIES.find((c) => c.id === "network_performance");
		expect(network?.Cards?.length).toBeGreaterThan(0);
	});

	it("are all rendered by the engine settings view, with no config entry present", () => {
		// No entries at all, so nothing but the declared cards can put these on
		// screen - a category with entries would leave the source of the text
		// ambiguous. Every declared card is asserted rather than the first,
		// because the list used to be a single component and a second one that
		// silently never rendered would look exactly like this test passing.
		renderSettings();
		expect(screen.getByText("Client certificates")).toBeInTheDocument();
		expect(screen.getByText("Connection test")).toBeInTheDocument();
	});

	it("leave a category that declares none alone", () => {
		// The opposite half: the view must not assume every engine category has
		// one, or every other category throws on an undefined component.
		const others = ENGINE_SETTINGS_CATEGORIES.filter((c) => c.id !== "network_performance");
		expect(others.length).toBeGreaterThan(0);
		expect(others.every((c) => c.Cards === undefined)).toBe(true);
	});
});
