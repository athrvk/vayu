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
 * "Copy for agent" on a variable row (#2047).
 *
 * Driven through `VariableTableEditor`, because the row has no scope of its own:
 * the editor's `config` is what decides whether the line names an environment,
 * a collection or globals. An icon button, so a copy that landed swaps the
 * glyph and raises no toast; the value and the secret flag are never reachable
 * from the line.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui";
import { useToastStore } from "@/stores/toast-store";
import VariableTableEditor from "./VariableTableEditor";
import type { Collection, Environment, VariableValue } from "@/types";

const SENTINEL = "s3cr3t-sentinel";

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useSetActiveEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
	const toastStore =
		await vi.importActual<typeof import("@/stores/toast-store")>("@/stores/toast-store");
	return {
		useSaveStore: saveStore.useSaveStore,
		useToastStore: toastStore.useToastStore,
		useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
	};
});

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

function variable(value: string, overrides: Partial<VariableValue> = {}): VariableValue {
	return { value, enabled: true, secret: false, type: "string", createdAt: 1000, ...overrides };
}

const VARIABLES: Record<string, VariableValue> = {
	API_URL: variable(SENTINEL),
	API_KEY: variable(SENTINEL, { secret: true, createdAt: 2000 }),
};

const environment: Environment = {
	id: "env_1",
	name: "Staging",
	description: "",
	isActive: false,
	variables: VARIABLES,
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

const collection: Collection = {
	id: "col_1",
	name: "Billing",
	description: "",
	order: 0,
	variables: VARIABLES,
	auth: { mode: "none" },
	elements: [],
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

function renderEditor(config: React.ComponentProps<typeof VariableTableEditor>["config"]) {
	return render(
		<TooltipProvider>
			<VariableTableEditor config={config} />
		</TooltipProvider>
	);
}

const copyButtons = () => screen.queryAllByRole("button", { name: /^Copy .* for agent$/ });

/** The glyph a button shows now; `IconSwap` keeps the other one invisible beside it. */
function liveGlyph(button: HTMLElement): string {
	return button.querySelector(".enter-fade svg")?.getAttribute("class") ?? "";
}

async function copyApiUrl(): Promise<string> {
	fireEvent.click(screen.getByRole("button", { name: "Copy API_URL for agent" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
	return writeText.mock.calls[0][0];
}

describe("Copy for agent on a variable row", () => {
	it("names the environment a variable of an environment lives in", async () => {
		renderEditor({ type: "environment", environment });

		expect(await copyApiUrl()).toBe('Vayu variable "API_URL" in environment "Staging" (env_1)');
	});

	it("names the collection a variable of a collection lives in", async () => {
		renderEditor({ type: "collection", collection });

		expect(await copyApiUrl()).toBe('Vayu variable "API_URL" in collection "Billing" (col_1)');
	});

	it("names globals, which have no id", async () => {
		renderEditor({ type: "globals", globalsData: { variables: VARIABLES } });

		expect(await copyApiUrl()).toBe('Vayu variable "API_URL" in globals');
	});

	it("never carries the variable's value", async () => {
		renderEditor({ type: "environment", environment });

		expect(await copyApiUrl()).not.toContain(SENTINEL);
	});

	it("swaps the glyph to a check and raises no toast", async () => {
		renderEditor({ type: "environment", environment });
		const button = screen.getByRole("button", { name: "Copy API_URL for agent" });
		expect(liveGlyph(button)).toContain("lucide-copy");

		fireEvent.click(button);

		await waitFor(() => expect(liveGlyph(button)).toContain("lucide-check"));
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("is absent on a secret row and on the trailing unsaved row", () => {
		renderEditor({ type: "environment", environment });

		// Three rows: API_KEY (secret), API_URL, and the blank row to type into.
		expect(screen.getAllByPlaceholderText("variable_name")).toHaveLength(3);
		expect(copyButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
			"Copy API_URL for agent",
		]);
	});

	it("is absent for every row while the environment or collection is not loaded", () => {
		renderEditor({ type: "environment" });

		expect(copyButtons()).toEqual([]);
	});

	it("is revealed on keyboard focus as well as hover", () => {
		renderEditor({ type: "environment", environment });

		const classes = screen.getByRole("button", { name: "Copy API_URL for agent" }).className;
		expect(classes).toContain("group-hover:opacity-100");
		expect(classes).toContain("group-focus-within:opacity-100");
	});
});
