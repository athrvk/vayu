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
 * The `enum` config type (Task 4) reached `GET /config` with no renderer on
 * this side - `defaultHttpVersion` existed but was invisible in Settings.
 *
 * Labels come from the payload's `options: {value,label}[]`, never from a map
 * kept in this component - that is the "config one branch defines and another
 * re-derives" defect CLAUDE.md calls out, and the mutation-check below proves
 * the guard actually catches it rather than passing by accident.
 *
 * The parity test is this repo's C++/TS drift guard for `defaultHttpVersion`,
 * the same idiom `cache-key.test.ts` uses for the OAuth cache key: read the
 * engine's own source of truth and compare, rather than trusting that two
 * hand-maintained lists were kept in sync.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import SettingsMain from "./SettingsMain";
import { HTTP_VERSIONS } from "@/constants/request";
import type { ConfigEntry } from "@/types";

const enumEntry: ConfigEntry = {
	key: "defaultHttpVersion",
	label: "Default HTTP Version",
	description: "Protocol a newly created request starts with.",
	type: "enum",
	value: "auto",
	default: "auto",
	category: "general_engine",
	requiresRestart: false,
	advanced: false,
	updatedAt: 0,
	options: [
		{ value: "auto", label: "Auto" },
		{ value: "http1.1", label: "HTTP/1.x" },
		{ value: "http2", label: "HTTP/2" },
	],
};

const enumEntryNoOptions: ConfigEntry = {
	...enumEntry,
	options: undefined,
};

let configEntries: ConfigEntry[] = [enumEntry];
const mutateAsync = vi.fn().mockResolvedValue(undefined);

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		// The component reads `entries`, filtered by `category`.
		data: { entries: configEntries },
		isLoading: false,
		error: null,
	}),
	useUpdateConfigMutation: () => ({ mutateAsync, isPending: false }),
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

beforeEach(() => {
	vi.clearAllMocks();
	mutateAsync.mockResolvedValue(undefined);
	configEntries = [enumEntry];
});

describe("an enum config entry", () => {
	it("renders a select with one option per payload entry, labelled from the payload", () => {
		renderSettings();

		fireEvent.click(screen.getByRole("combobox", { name: /Default HTTP Version/i }));

		for (const option of enumEntry.options ?? []) {
			expect(screen.getByRole("option", { name: option.label })).toBeInTheDocument();
		}
	});

	it("saves the selected value, not the label", async () => {
		renderSettings();

		fireEvent.click(screen.getByRole("combobox", { name: /Default HTTP Version/i }));
		fireEvent.click(screen.getByRole("option", { name: "HTTP/2" }));

		fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

		await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
		expect(mutateAsync).toHaveBeenCalledWith({ entries: { defaultHttpVersion: "http2" } });
	});

	it("renders nothing rather than crashing when options is missing", () => {
		configEntries = [enumEntryNoOptions];

		expect(() => renderSettings()).not.toThrow();
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		// The rest of the card (label/description) still renders - only the
		// control itself is absent.
		expect(screen.getByText("Default HTTP Version")).toBeInTheDocument();
	});
});

describe("HTTP_VERSIONS parity with the engine", () => {
	// engine/include/vayu/types.hpp is the single domain enumeration
	// (`all_http_versions()`) that both request validation and the seeded
	// `defaultHttpVersion` config `options` derive from - see the comment on
	// `HttpVersion` there. Reading it here, rather than trusting a second
	// hand-copied list, is what makes this a drift guard instead of a tautology.
	const enginePath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
		"..",
		"..",
		"engine",
		"include",
		"vayu",
		"types.hpp"
	);
	const source = readFileSync(enginePath, "utf8");

	// `types.hpp` only proves the two sides agree on the *domain*. What the
	// engine actually seeds into `defaultHttpVersion.options` is built by
	// `http_version_options_json()` in database.cpp - so the guard also has to
	// pin that this function still *derives* the seeded list from
	// `all_http_versions()` / `to_string` / `http_version_label`, rather than a
	// literal array someone swapped in later that could silently drift or
	// reorder without either of the checks above noticing.
	const databasePath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
		"..",
		"..",
		"engine",
		"src",
		"db",
		"database.cpp"
	);
	const databaseSource = readFileSync(databasePath, "utf8");

	it("read non-empty engine source files", () => {
		// Guards against the failure mode CLAUDE.md documents: a source-scanning
		// test that silently reads "" (or a wrong/missing path) and passes for
		// weeks because an empty scan trivially satisfies every assertion below.
		expect(source.length).toBeGreaterThan(0);
		expect(databaseSource.length).toBeGreaterThan(0);
	});

	it("seeds defaultHttpVersion's options by deriving from the same enumeration", () => {
		const fnMatch = databaseSource.match(
			/std::string http_version_options_json \(\) \{([\s\S]*?)\n\}/
		);
		expect(fnMatch, "http_version_options_json() not found in database.cpp").not.toBeNull();

		const body = fnMatch?.[1] ?? "";
		expect(body).toContain("all_http_versions ()");
		expect(body).toContain("vayu::to_string (version)");
		expect(body).toContain("vayu::http_version_label (version)");

		// And the seed call site actually feeds that JSON into the
		// "defaultHttpVersion" entry's options column, not some other field.
		const seedMatch = databaseSource.match(
			/upsert_config \(ConfigEntry\{ "defaultHttpVersion",[\s\S]*?\}\);/
		);
		expect(seedMatch, "defaultHttpVersion upsert_config call not found").not.toBeNull();
		expect(seedMatch?.[0]).toContain("http_version_options_json ()");
	});

	function extractOrder(text: string): string[] {
		const match = text.match(
			/static const std::vector<HttpVersion> versions = \{([\s\S]*?)\};/
		);
		if (!match) return [];
		return [...match[1].matchAll(/HttpVersion::(\w+)/g)].map((m) => m[1]);
	}

	function extractSwitchMap(text: string, functionName: string): Map<string, string> {
		// `to_string` is overloaded (HttpMethod has its own); pin the parameter
		// type so this matches the HttpVersion overload specifically, not
		// whichever `to_string` happens to appear first in the file.
		const fnMatch = text.match(
			new RegExp(`${functionName} \\(HttpVersion version\\) \\{([\\s\\S]*?)\\n\\}`)
		);
		const map = new Map<string, string>();
		if (!fnMatch) return map;
		for (const caseMatch of fnMatch[1].matchAll(
			/case HttpVersion::(\w+):\s*return "([^"]*)";/g
		)) {
			map.set(caseMatch[1], caseMatch[2]);
		}
		return map;
	}

	it("derives a non-empty ordered enum member list from the engine source", () => {
		const order = extractOrder(source);
		expect(order.length).toBeGreaterThan(0);
	});

	it("matches HTTP_VERSIONS value-for-value, label-for-label, in order", () => {
		const order = extractOrder(source);
		const values = extractSwitchMap(source, "to_string");
		const labels = extractSwitchMap(source, "http_version_label");
		expect(order.length).toBeGreaterThan(0);
		expect(values.size).toBeGreaterThan(0);
		expect(labels.size).toBeGreaterThan(0);

		const engineVersions = order.map((member) => ({
			value: values.get(member),
			label: labels.get(member),
		}));

		expect(engineVersions).toEqual(HTTP_VERSIONS.map((v) => ({ ...v })));
	});
});
