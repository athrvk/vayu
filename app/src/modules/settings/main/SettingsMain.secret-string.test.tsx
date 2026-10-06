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
 * The proxy URL is drawn masked (#1806).
 *
 * `http://user:pass@host:8080` carries a credential, and a plain text field puts
 * it on screen for a screenshot or a screen share. Only `proxyUrl` is masked: the
 * rule keys on the setting's name, so every other string setting keeps its plain
 * input. The value is edited and saved exactly as it was in the plain field.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import SettingsMain from "./SettingsMain";
import type { ConfigEntry } from "@/types";

const baseEntry: ConfigEntry = {
	key: "proxyUrl",
	label: "Proxy URL",
	description: "Where to send requests when the proxy mode is manual.",
	type: "string",
	value: "http://user:pass@proxy.test:8080",
	default: "",
	category: "network_performance",
	requiresRestart: false,
	advanced: false,
	keywords: [],
	updatedAt: 0,
};
const otherEntry: ConfigEntry = {
	...baseEntry,
	key: "correlationIdHeader",
	label: "Correlation header",
	value: "X-Request-Id",
	default: "X-Request-Id",
};

const mutateAsync = vi.fn((_payload: { entries: Record<string, string> }) => Promise.resolve({}));

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		data: { entries: [baseEntry, otherEntry] },
		isLoading: false,
		error: null,
	}),
	useUpdateConfigMutation: () => ({ mutateAsync, isPending: false }),
}));

// See the note in SettingsMain.category-switch.test.tsx - the Network
// category mounts the client-certificate registry card, which reads the engine.
vi.mock("./panels/ClientCertificatesCard", () => ({ ClientCertificatesCard: () => null }));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({ selectedCategory: "network_performance", restartRequiredKeys: [] }),
}));

vi.mock("@/stores", () => ({
	useEngineStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
			engineStatus: "connected",
			pendingRestart: false,
			restartRequiredKeys: [],
			addRestartRequiredKey: vi.fn(),
			clearRestartRequired: vi.fn(),
		}),
	useToastStore: (selector: (s: { showToast: () => void }) => unknown) =>
		selector({ showToast: vi.fn() }),
}));

vi.mock("@/stores/save-store", () => ({
	useSaveStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
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
			<TooltipProvider>
				<SettingsMain />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => vi.clearAllMocks());

describe("the proxy URL setting", () => {
	it("is masked until revealed, with a toggle", () => {
		renderSettings();
		const field = screen.getByLabelText("Proxy URL") as HTMLInputElement;
		expect(field.type).toBe("password");
		expect(field.value).toBe("http://user:pass@proxy.test:8080");

		fireEvent.click(screen.getByRole("button", { name: "Show value" }));
		expect(field.type).toBe("text");
	});

	it("keeps its row anchor", () => {
		const { container } = renderSettings();
		expect(container.querySelector('[data-setting-anchor="proxyUrl"]')).not.toBeNull();
	});

	it("saves an edit as the typed value", async () => {
		renderSettings();
		fireEvent.change(screen.getByLabelText("Proxy URL"), {
			target: { value: "http://other.test:3128" },
		});
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

		await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
		expect(mutateAsync).toHaveBeenCalledWith({
			entries: { proxyUrl: "http://other.test:3128" },
		});
	});

	it("leaves every other string setting as a plain input", () => {
		renderSettings();
		const field = screen.getByLabelText("Correlation header") as HTMLInputElement;
		expect(field.type).toBe("text");
		expect(screen.getAllByRole("button", { name: "Show value" })).toHaveLength(1);
	});
});
