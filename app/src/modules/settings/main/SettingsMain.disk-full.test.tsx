/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/services/http-client";
import { useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import SettingsMain from "./SettingsMain";

const entries = [
	{
		key: "max_connections",
		label: "Max connections",
		description: "Upper bound on concurrent connections",
		type: "integer" as const,
		value: "10",
		default: "10",
		category: "network_performance",
		min: "1",
		max: "100",
		updatedAt: 0,
	},
];

const mutateAsync = vi.fn((_payload: { entries: Record<string, string> }) => Promise.resolve({}));

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries }, isLoading: false, error: null }),
	useUpdateConfigMutation: () => ({ mutateAsync, isPending: false }),
}));

// The registry card the Network category mounts above its entries (issue
// #707) reads the engine over its own queries, which is not what this file is
// about - stubbed on the `CookiesCard` precedent in the save-model test.
vi.mock("./panels/ClientCertificatesCard", () => ({ ClientCertificatesCard: () => null }));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({ selectedCategory: "network_performance", restartRequiredKeys: [] }),
}));

const showToast = vi.fn();
vi.mock("@/stores", () => ({
	useEngineStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
			engineStatus: "connected",
			pendingRestart: false,
			restartRequiredKeys: [],
			addRestartRequiredKey: vi.fn(),
			clearRestartRequired: vi.fn(),
		}),
	// The panel toasts the edits a category-switch flush had to drop.
	useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
		selector({ showToast }),
}));

// `@/stores/save-store` is deliberately not mocked: the status this panel
// publishes is the whole subject, and the panel imports it from there directly.

function Panel() {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<SettingsMain />
		</QueryClientProvider>
	);
}

/**
 * A settings write the engine refused with a 507 must reach the quit prompt as
 * disk-full (#2685).
 *
 * `saveEntries` reports its failure through `failSave` and resolves, so the
 * store judges the context by the status it published; without the error handed
 * to `failSave` that reads as a generic failure and the prompt blames the engine
 * for a full disk. Driven through the store's `flushAll`, which is what quit runs.
 */

async function flushAnEditedPanel(rejectWith: Error) {
	mutateAsync.mockRejectedValueOnce(rejectWith);
	const { unmount } = render(<Panel />);
	fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "42" } });
	let result: Awaited<ReturnType<ReturnType<typeof useSaveStore.getState>["flushAll"]>>;
	await act(async () => {
		result = await useSaveStore.getState().flushAll();
	});
	expect(mutateAsync).toHaveBeenCalledTimes(1);
	unmount();
	return result!;
}

describe("a settings write refused at quit", () => {
	beforeEach(() => {
		mutateAsync.mockClear();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useSaveStore.getState().reset();
		useToastStore.setState({ toasts: [] });
	});

	it("is named disk-full when the engine answered 507", async () => {
		const result = await flushAnEditedPanel(
			new ApiError(507, "insufficient_storage", "The disk holding Vayu's data is full")
		);

		expect(result).toEqual({ saved: 0, failed: 1, pending: 0, reason: "disk-full" });
	});

	it("names no cause for any other failure", async () => {
		const result = await flushAnEditedPanel(new ApiError(503, "unavailable", "busy"));

		expect(result).toEqual({ saved: 0, failed: 1, pending: 0 });
	});
});
