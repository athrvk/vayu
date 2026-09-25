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
 * The script completion list and the script type declarations are fetched once
 * an editor has loaded Monaco, not at launch.
 *
 * `App` mounts both provider hooks at startup and they only ever hand their
 * data to Monaco, which loads on demand (#1146) - so fetching at mount put two
 * requests (one of them a generated `.d.ts`) into the launch burst with nothing
 * to read them. Mutation check: drop either hook's `enabled` gate and its fetch
 * shows up in the first assertion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const monacoStub = {
	languages: { registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })) },
	typescript: {
		ScriptTarget: { ESNext: 99, ES2020: 7 },
		javascriptDefaults: {
			addExtraLib: vi.fn(() => ({ dispose: vi.fn() })),
			setCompilerOptions: vi.fn(),
			setDiagnosticsOptions: vi.fn(),
			setModeConfiguration: vi.fn(),
			getCompilerOptions: vi.fn(() => ({})),
			modeConfiguration: {},
		},
	},
};

let loadedMonaco: typeof monacoStub | null = null;
vi.mock("@/lib/monaco-loader", () => ({
	useLoadedMonaco: () => loadedMonaco,
	ensureMonaco: () => Promise.resolve(monacoStub),
}));

const getScriptCompletions = vi.fn();
const getScriptTypeDefinitions = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: {
		getScriptCompletions: () => getScriptCompletions(),
		getScriptTypeDefinitions: () => getScriptTypeDefinitions(),
	},
}));

import { useScriptCompletionProvider } from "./useScriptCompletionProvider";
import { useScriptTypeDefinitions } from "./useScriptTypeDefinitions";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function useBoth() {
	useScriptCompletionProvider();
	useScriptTypeDefinitions();
}

beforeEach(() => {
	vi.clearAllMocks();
	loadedMonaco = null;
	getScriptCompletions.mockResolvedValue({ completions: [] });
	getScriptTypeDefinitions.mockResolvedValue({
		version: "1.0.0",
		engine: "quickjs",
		libUri: "ts:vayu/pm.d.ts",
		typeDefinitions: "",
	});
});

describe("script editor data", () => {
	it("is not fetched while no editor has loaded Monaco", async () => {
		const { rerender } = renderHook(() => useBoth(), { wrapper });
		rerender();
		// A tick for any fetch the mount scheduled to have been issued.
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(getScriptCompletions).not.toHaveBeenCalled();
		expect(getScriptTypeDefinitions).not.toHaveBeenCalled();
	});

	it("is fetched once Monaco has loaded", async () => {
		const { rerender } = renderHook(() => useBoth(), { wrapper });
		loadedMonaco = monacoStub;
		rerender();

		await waitFor(() => expect(getScriptCompletions).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(getScriptTypeDefinitions).toHaveBeenCalledTimes(1));
	});
});
