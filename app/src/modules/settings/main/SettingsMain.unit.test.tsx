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
 * Engine settings put their unit on the input, from the entry's own `unit`.
 *
 * The suffix affordance existed (`NumberSettingRow`'s `unit` prop) but only
 * three hardcoded keys reached it - a list in `format-size.ts` the app kept of
 * what the engine owns - so every millisecond, second and day entry rendered a
 * bare number with its unit nowhere on screen, and six byte-valued entries
 * printed `104857600` where `100.0 MB` belonged.
 *
 * These are mutation-checkable against that: blank a seeded `unit` (or drop the
 * passthrough in `SettingsMain`) and the suffix assertions fail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";
import type { ConfigEntry } from "@/types";

const millisecondEntry: ConfigEntry = {
	key: "defaultTimeout",
	label: "Default Request Timeout",
	description: "How long an HTTP request may run before it is abandoned.",
	type: "integer",
	value: "30000",
	default: "30000",
	min: "1000",
	max: "300000",
	category: "general_engine",
	requiresRestart: false,
	advanced: false,
	keywords: [],
	unit: "ms",
	updatedAt: 0,
};

const byteEntry: ConfigEntry = {
	key: "dbCacheSize",
	label: "Database Cache Size",
	description: "Memory SQLite keeps per connection.",
	type: "integer",
	value: "2097152",
	default: "1048576",
	min: "1048576",
	max: "1073741824",
	category: "general_engine",
	requiresRestart: false,
	advanced: false,
	keywords: [],
	unit: "bytes",
	updatedAt: 0,
};

/** A count: it measures nothing, so the engine sends no `unit` at all. */
const countEntry: ConfigEntry = {
	key: "workers",
	label: "Worker Threads",
	description: "Number of background worker threads.",
	type: "integer",
	value: "8",
	default: "8",
	min: "1",
	max: "128",
	category: "general_engine",
	requiresRestart: false,
	advanced: false,
	keywords: [],
	updatedAt: 0,
};

let configEntries: ConfigEntry[] = [millisecondEntry];

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		data: { entries: configEntries },
		isLoading: false,
		error: null,
	}),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: () => ({ selectedCategory: "general_engine", restartRequiredKeys: [] }),
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

/**
 * The suffix rendered inside the input, or null when the row has none.
 *
 * Read off the rendered element rather than scanned for in the source: the
 * suffix arrives as a prop, which no source scan of this component would see.
 */
function suffixOf(label: string): string | null {
	const input = screen.getByRole("spinbutton", { name: label });
	const suffix = input.parentElement?.querySelector("span[aria-hidden='true']");
	return suffix?.textContent ?? null;
}

beforeEach(() => {
	vi.clearAllMocks();
	configEntries = [millisecondEntry];
});

describe("a numeric engine entry that declares a unit", () => {
	it("renders the unit as the input's suffix", () => {
		renderSettings();

		expect(suffixOf("Default Request Timeout")).toBe("ms");
	});

	it("states the unit once - not appended to the label, not spelled in prose", () => {
		renderSettings();

		// The label the payload carries, with nothing bolted on: the labels
		// used to end in "(ms)" / "(Days)", which is the second copy the
		// suffix replaces.
		expect(screen.getAllByText("Default Request Timeout").length).toBeGreaterThan(0);
		expect(screen.queryByText(/Default Request Timeout\s*\(/)).not.toBeInTheDocument();
		expect(screen.queryByText(/in milliseconds/i)).not.toBeInTheDocument();
	});

	it("renders no suffix for an entry that measures nothing", () => {
		configEntries = [countEntry];
		renderSettings();

		expect(suffixOf("Worker Threads")).toBeNull();
	});
});

describe("a byte-valued engine entry", () => {
	beforeEach(() => {
		configEntries = [byteEntry];
	});

	it("reads its value, range and default in human-readable sizes", () => {
		renderSettings();

		// The suffix is the formatted *value*, not the literal word "bytes" -
		// a byte count is unreadable as a raw number, which is the whole
		// reason this path exists.
		expect(suffixOf("Database Cache Size")).toBe("2.0 MB");
		expect(screen.getByText("Min: 1.0 MB, Max: 1.0 GB")).toBeInTheDocument();
		expect(screen.getByText("Default: 1.0 MB")).toBeInTheDocument();
	});

	it("formats from the declared unit, not from a list of known keys", () => {
		// The same key with no declared unit gets none of the byte treatment:
		// what selects it is the entry's own declaration, which is what the
		// hardcoded three-key list got wrong.
		configEntries = [{ ...byteEntry, unit: undefined }];
		renderSettings();

		expect(suffixOf("Database Cache Size")).toBeNull();
		expect(screen.queryByText("Min: 1.0 MB, Max: 1.0 GB")).not.toBeInTheDocument();
		expect(screen.getByText("Default: 1048576")).toBeInTheDocument();
	});
});
