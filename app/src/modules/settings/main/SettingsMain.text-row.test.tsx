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
 * The engine `text` card renders a textarea (issue #706).
 *
 * `text` is the multi-line string the CA bundle arrives as: several PEM blocks
 * whose line breaks are the format. Rendered through the `string` branch it
 * would be a single-line `Input` showing one line of a certificate with the
 * rest scrolled out of view - which is how the setting would look broken while
 * holding exactly what the user pasted.
 *
 * Asserted on the element rather than by the value it holds: the failure this
 * guards is the *control type*, and a value round-trips identically through
 * either one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";
import type { ConfigEntry } from "@/types";

const textEntry: ConfigEntry = {
	key: "customCaCertificates",
	label: "Custom CA Certificates",
	description: "Certificate authorities to trust in addition to the platform's own.",
	type: "text",
	value: "",
	default: "",
	category: "network_performance",
	requiresRestart: false,
	advanced: false,
	keywords: [],
	updatedAt: 0,
};

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		data: { entries: [textEntry] },
		isLoading: false,
		error: null,
	}),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: () => ({
		selectedCategory: "network_performance",
		restartRequiredKeys: [],
	}),
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
	// SettingsMain destructures nine members; a partial mock throws on the first
	// one it calls, which is easy to mistake for a defect in the component.
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
	// SettingsMain calls useQueryClient directly (for invalidation), so the
	// provider is required even with the query hooks mocked.
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SettingsMain />
		</QueryClientProvider>
	);
}

const control = () => screen.getByLabelText("Custom CA Certificates");

beforeEach(() => vi.clearAllMocks());

describe("the engine text card", () => {
	it("renders a textarea, not the single-line input", () => {
		renderSettings();
		expect(control().tagName).toBe("TEXTAREA");
	});

	it("keeps the pasted line breaks intact", () => {
		// A `<input type="text">` drops them silently, which is the shape of the
		// bug: the certificate is stored as one line and stops being a PEM.
		renderSettings();
		const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
		fireEvent.change(control(), { target: { value: pem } });
		expect((control() as HTMLTextAreaElement).value).toBe(pem);
	});

	it("shows the content as monospace, since its line structure is the format", () => {
		renderSettings();
		expect(control().className).toContain("font-mono");
	});
});
