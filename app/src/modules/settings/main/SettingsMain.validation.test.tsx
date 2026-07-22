/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An out-of-range setting has to say so to everyone.
 *
 * The field turned its border red and a line of text appeared beside it -
 * colour, plus a message the field did not point at. Nothing marked the input
 * invalid, so `aria-invalid` appeared nowhere in the app and a screen reader
 * user got no signal at all that a save was being blocked.
 *
 * These assert structure - the attributes and the id they resolve to. Whether
 * a screen reader speaks them is not something jsdom can answer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";

const entry = {
	key: "max_connections",
	label: "Max connections",
	description: "Upper bound on concurrent connections",
	type: "integer" as const,
	value: "10",
	default: "10",
	category: "network",
	// Strings, not numbers - that is the shape ConfigEntry declares and what
	// the engine sends.
	min: "1",
	max: "100",
	updatedAt: 0,
};

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		// The component reads `entries`, filtered by `category`.
		data: { entries: [entry] },
		isLoading: false,
		error: null,
	}),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: () => ({ selectedCategory: "network", restartRequiredKeys: [] }),
}));

vi.mock("@/stores", () => ({
	useEngineStore: () => ({
		isEngineConnected: true,
		pendingRestart: false,
		restartRequiredKeys: [],
		addRestartRequiredKey: vi.fn(),
		clearRestartRequired: vi.fn(),
	}),
}));

vi.mock("@/stores/save-store", () => ({
	// SettingsMain destructures nine members; a partial mock throws on the first
	// one it calls, which is easy to mistake for a defect in the component.
	useSaveStore: () => ({
		startSaving: vi.fn(),
		completeSave: vi.fn(),
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
	// SettingsMain calls useQueryClient directly (for invalidation), so the
	// provider is required even with the query hooks mocked.
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SettingsMain />
		</QueryClientProvider>
	);
}

const field = () => screen.getByRole("spinbutton", { name: /Max connections/i });

beforeEach(() => {
	vi.clearAllMocks();
});

describe("an invalid engine setting", () => {
	it("carries no aria-invalid while the value is in range", () => {
		// `aria-invalid="false"` on every field on the screen is noise; the
		// attribute should be absent until something is actually wrong.
		renderSettings();
		expect(field()).not.toHaveAttribute("aria-invalid");
		expect(field()).not.toHaveAttribute("aria-describedby");
	});

	it("marks the field invalid and points it at the reason", () => {
		renderSettings();
		fireEvent.change(field(), { target: { value: "999" } });

		expect(field()).toHaveAttribute("aria-invalid", "true");

		const describedBy = field().getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		// The reference has to resolve - an id pointing at nothing is worse than
		// no reference, because assistive tech reports the field as described.
		const message = document.getElementById(describedBy as string);
		expect(message).not.toBeNull();
		expect(message?.textContent).toMatch(/at most 100/i);
	});

	it("clears both attributes once the value is valid again", () => {
		renderSettings();
		fireEvent.change(field(), { target: { value: "999" } });
		expect(field()).toHaveAttribute("aria-invalid", "true");

		fireEvent.change(field(), { target: { value: "50" } });
		expect(field()).not.toHaveAttribute("aria-invalid");
		expect(field()).not.toHaveAttribute("aria-describedby");
	});
});
