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
 * The declarations reach Monaco's TypeScript worker, and reach it configured
 * the way the sandbox actually behaves.
 *
 * Driven through the hook with a stubbed `javascriptDefaults` rather than
 * scanned as source: what matters is the options object that ends up on the
 * worker, and it is assembled from a spread of the existing options plus the
 * fetched text - none of which a grep can see.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const dispose = vi.fn();
const addExtraLib = vi.fn(() => ({ dispose }));
const setCompilerOptions = vi.fn();
const setDiagnosticsOptions = vi.fn();
const getCompilerOptions = vi.fn(() => ({ strict: false }));

const monacoStub = {
	typescript: {
		ScriptTarget: { ESNext: 99, ES2020: 7 },
		javascriptDefaults: {
			addExtraLib,
			setCompilerOptions,
			setDiagnosticsOptions,
			getCompilerOptions,
		},
	},
};

vi.mock("@monaco-editor/react", () => ({
	useMonaco: () => monacoStub,
}));

const getScriptTypeDefinitions = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: {
		getScriptTypeDefinitions: () => getScriptTypeDefinitions(),
	},
}));

import { useScriptTypeDefinitions } from "./useScriptTypeDefinitions";

const DTS = "declare const pm: { test(name: string, fn: () => void): void };";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useScriptTypeDefinitions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getScriptTypeDefinitions.mockResolvedValue({
			version: "1.0.0",
			engine: "quickjs",
			libUri: "ts:vayu/pm.d.ts",
			typeDefinitions: DTS,
		});
	});

	it("registers the engine-generated declarations under the engine's uri", async () => {
		renderHook(() => useScriptTypeDefinitions(), { wrapper });
		await waitFor(() => expect(addExtraLib).toHaveBeenCalled());
		expect(addExtraLib).toHaveBeenCalledWith(DTS, "ts:vayu/pm.d.ts");
	});

	/*
	 * The sandbox has no DOM and no Node. Including `dom` in the lib list would
	 * have the editor confidently offer `fetch` and `setTimeout`, which do not
	 * exist at runtime - the failure would surface only when the script ran.
	 */
	it("configures the worker for the sandbox: es2022, no dom", async () => {
		renderHook(() => useScriptTypeDefinitions(), { wrapper });
		await waitFor(() => expect(setCompilerOptions).toHaveBeenCalled());

		const options = setCompilerOptions.mock.calls[0][0] as {
			lib: string[];
			target: number;
			allowJs: boolean;
			strict?: boolean;
		};
		expect(options.lib).toEqual(["es2022"]);
		expect(options.lib).not.toContain("dom");
		// ESNext, not ES2020: the runtime is quickjs-ng, where `Object.hasOwn`
		// and `.at()` work, and ES2020 would mark them as errors.
		expect(options.target).toBe(99);
		expect(options.allowJs).toBe(true);
		// Spread over whatever the worker already had, not a replacement of it.
		expect(options.strict).toBe(false);
	});

	/*
	 * Deliberate, and the reason is in the hook: a script editor holds a
	 * fragment, and the two fragments of one request are separate models, so
	 * semantic validation would squiggle correct scripts. If this flips, it
	 * should be because that changed - not by accident.
	 */
	it("leaves semantic diagnostics off", async () => {
		renderHook(() => useScriptTypeDefinitions(), { wrapper });
		await waitFor(() => expect(setDiagnosticsOptions).toHaveBeenCalled());
		expect(setDiagnosticsOptions.mock.calls[0][0]).toMatchObject({
			noSemanticValidation: true,
		});
	});

	it("disposes the lib so a refetch cannot register it twice", async () => {
		const { unmount } = renderHook(() => useScriptTypeDefinitions(), { wrapper });
		await waitFor(() => expect(addExtraLib).toHaveBeenCalled());
		unmount();
		expect(dispose).toHaveBeenCalled();
	});

	it("does nothing when the engine cannot be reached", async () => {
		getScriptTypeDefinitions.mockRejectedValue(new Error("engine down"));
		renderHook(() => useScriptTypeDefinitions(), { wrapper });
		await waitFor(() => expect(getScriptTypeDefinitions).toHaveBeenCalled());
		expect(addExtraLib).not.toHaveBeenCalled();
	});
});
