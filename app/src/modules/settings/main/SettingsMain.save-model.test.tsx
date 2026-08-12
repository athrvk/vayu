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
 * Three save models coexist in Settings - the app panels autosave, the engine
 * view stages and writes on Save, and MCP commits its caps on blur - and
 * nothing on screen said which one you were in. Every category now states its
 * own, which is only true if the statement is rendered for *every* panel: hence
 * the walk over the registry rather than a spot check on one.
 *
 * The engine categories also assert their titles against the category registry,
 * which is the drift test for it: the sidebar and this view used to hold two
 * hand-maintained copies of the same five labels.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";
import { APP_SETTINGS_PANELS, DEFAULT_SAVE_NOTE } from "./app-panels";
import { ENGINE_SETTINGS_CATEGORIES } from "../engine-categories";
import type { SettingsCategory } from "@/types";

let selectedCategory: SettingsCategory = "appearance";

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: [] }, isLoading: false, error: null }),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The panels are rendered for real - the statement under test is in their
// shared shell - so the things they reach outside Settings are stubbed: the
// engine's run store and cookie jar, and the Electron updater bridge.
vi.mock("@/queries/runs", () => ({
	useAllRunsQuery: () => ({ data: [] }),
	useInvalidateRuns: () => vi.fn(),
}));
vi.mock("./panels/UpdatesCard", () => ({ UpdatesCard: () => null }));
vi.mock("./panels/CookiesCard", () => ({ CookiesCard: () => null }));

const clearHighlight = vi.fn();
vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: (selector?: (s: unknown) => unknown) => {
		const state = { selectedCategory, highlightedKey: null, clearHighlight };
		return selector ? selector(state) : state;
	},
}));

const showToast = vi.fn();
vi.mock("@/stores", async (importOriginal) => {
	// The app panels are rendered for real here, so they need the real client
	// settings store; only the engine and toast stores are stubbed.
	const actual = await importOriginal<typeof import("@/stores")>();
	return {
		...actual,
		useEngineStore: () => ({
			isEngineConnected: true,
			pendingRestart: false,
			restartRequiredKeys: [],
			addRestartRequiredKey: vi.fn(),
			clearRestartRequired: vi.fn(),
		}),
		useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
			selector({ showToast }),
	};
});

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

function renderCategory(category: SettingsCategory) {
	selectedCategory = category;
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SettingsMain />
		</QueryClientProvider>
	);
}

beforeEach(cleanup);

describe("the save-model statement", () => {
	it("is on every app panel, and says the autosave default unless the panel overrides it", () => {
		for (const panel of APP_SETTINGS_PANELS) {
			cleanup();
			renderCategory(panel.id);
			expect(screen.getByText(panel.saveNote ?? DEFAULT_SAVE_NOTE)).toBeInTheDocument();
		}
	});

	it("lets a panel that saves differently say so - MCP is the one that does", () => {
		const mcp = APP_SETTINGS_PANELS.find((p) => p.id === "mcp");
		// Mutation check on the override itself: if MCP stopped carrying its own
		// note it would silently claim the autosave story, which is not how its
		// cap fields behave.
		expect(mcp?.saveNote).toBeDefined();
		expect(mcp?.saveNote).not.toBe(DEFAULT_SAVE_NOTE);

		renderCategory("mcp");
		expect(screen.queryByText(DEFAULT_SAVE_NOTE)).toBeNull();
	});

	it("states the engine view's explicit model beside its Save bar", () => {
		renderCategory("general_engine");

		expect(screen.getByRole("button", { name: /Save Changes/i })).toBeInTheDocument();
		expect(screen.getByText(/staged here and written when you save/i)).toBeInTheDocument();
	});
});

describe("the engine category registry", () => {
	it("titles every engine view from the same registry the sidebar renders", () => {
		// One label per category. The sidebar's `ENGINE_CATEGORY_META` and this
		// view's `CATEGORY_TITLES` were two hand-maintained maps of the same five
		// names, free to disagree.
		for (const category of ENGINE_SETTINGS_CATEGORIES) {
			cleanup();
			renderCategory(category.id);
			expect(screen.getByRole("heading", { name: category.label })).toBeInTheDocument();
			expect(screen.getByText(category.description)).toBeInTheDocument();
		}
	});
});
