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
const setModeConfiguration = vi.fn();
const getCompilerOptions = vi.fn(() => ({ strict: false }));

const monacoStub = {
	typescript: {
		ScriptTarget: { ESNext: 99, ES2020: 7 },
		javascriptDefaults: {
			addExtraLib,
			setCompilerOptions,
			setDiagnosticsOptions,
			setModeConfiguration,
			getCompilerOptions,
			modeConfiguration: { inlayHints: true },
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
	 * The null half of semantic validation is off on purpose (#443), and the
	 * option is written down rather than inherited: Monaco does not default it
	 * on today, but the spread above carries whatever the worker already had,
	 * and a `strict: true` arriving there would turn it on as a side effect.
	 *
	 * Decided on a count, not a preference: over the 54 `pm.*` examples in the
	 * two script docs plus three realistic scripts, turning it on adds 13
	 * diagnostics and 8 of them land on the docs' own recommended lines. The
	 * reasoning lives on the option itself.
	 */
	it("leaves strictNullChecks off, written down rather than inherited", async () => {
		renderHook(() => useScriptTypeDefinitions(), { wrapper });
		await waitFor(() => expect(setCompilerOptions).toHaveBeenCalled());

		const options = setCompilerOptions.mock.calls[0][0] as {
			strictNullChecks?: boolean;
		};
		expect(options.strictNullChecks).toBe(false);
	});

	it("turns semantic validation on - that is what squiggles a typo", async () => {
		renderHook(() => useScriptTypeDefinitions(), { wrapper });
		await waitFor(() => expect(setDiagnosticsOptions).toHaveBeenCalled());
		expect(setDiagnosticsOptions.mock.calls[0][0]).toMatchObject({
			noSemanticValidation: false,
			noSyntaxValidation: false,
		});
	});

	/*
	 * The two diagnostics a *correct* script produces here, both because the
	 * editor holds a fragment while the engine runs something larger: a
	 * top-level `return` (the engine wraps the script in an IIFE) and a name
	 * declared in the collection-level part (joined before the engine runs it).
	 *
	 * The exact list matters in both directions. Too narrow and correct scripts
	 * squiggle; too wide and real mistakes go unreported - so assert the codes,
	 * not merely that something is suppressed.
	 */
	it("suppresses only the two diagnostics a correct script produces", async () => {
		renderHook(() => useScriptTypeDefinitions(), { wrapper });
		await waitFor(() => expect(setDiagnosticsOptions).toHaveBeenCalled());
		const options = setDiagnosticsOptions.mock.calls[0][0] as {
			diagnosticCodesToIgnore: number[];
		};
		// 1108 top-level return, 2304 cannot find name.
		expect(options.diagnosticCodesToIgnore).toEqual([1108, 2304]);
		// 2339/2551 (property does not exist / did you mean) and 2345 (bad
		// argument type) are the point of the feature and must survive.
		expect(options.diagnosticCodesToIgnore).not.toContain(2551);
		expect(options.diagnosticCodesToIgnore).not.toContain(2339);
		expect(options.diagnosticCodesToIgnore).not.toContain(2345);
	});

	/*
	 * Quick fixes, rename, references and go-to-definition all default to true
	 * in Monaco, so this asserts intent rather than a change: they arrived with
	 * diagnostics and a default flipping off would remove them silently.
	 */
	it("keeps the language-service providers on, over the existing config", async () => {
		renderHook(() => useScriptTypeDefinitions(), { wrapper });
		await waitFor(() => expect(setModeConfiguration).toHaveBeenCalled());
		expect(setModeConfiguration.mock.calls[0][0]).toMatchObject({
			diagnostics: true,
			codeActions: true,
			rename: true,
			references: true,
			definitions: true,
			hovers: true,
			signatureHelp: true,
			// Spread over what was already there, not a replacement of it.
			inlayHints: true,
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
