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
 * The two rules `monaco-loader` exists to hold (#1146).
 *
 * The first is the whole point of the split: subscribing to Monaco must not
 * *load* it. Four provider hooks call `useLoadedMonaco` from `App`, which
 * mounts before any editor exists - if that hook pulled the module in, the
 * 4MB graph would be back on the startup path and, worse, `loader.init()`
 * would run before `loader.config({ monaco })` and send
 * @monaco-editor/react to the jsdelivr CDN.
 *
 * The second is that the load happens once. `monaco-setup` registers
 * completion, hover and diagnostics providers whose disposables nobody holds,
 * so a second evaluation would double-register every one of them.
 *
 * The module keeps its state in module scope, so each case re-imports it after
 * `vi.resetModules()` rather than sharing one loaded instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

/** How many times the setup module has been evaluated. */
let setupEvaluations = 0;
const fakeMonaco = { languages: {} } as unknown as typeof import("monaco-editor");

type Loader = typeof import("./monaco-loader");

/**
 * A loader with no history: fresh module state, and a fresh stub of the setup
 * module whose factory runs on each evaluation, which is what
 * `setupEvaluations` counts. `vi.doMock` rather than `vi.mock` because the
 * hoisted form registers the stub once and would report every later case as
 * zero evaluations.
 */
async function freshLoader(): Promise<Loader> {
	vi.resetModules();
	setupEvaluations = 0;
	vi.doMock("./monaco-setup", () => {
		setupEvaluations++;
		return { monaco: fakeMonaco };
	});
	return import("./monaco-loader");
}

/** Renders the hook and reports what it returned on the latest render. */
function renderHookProbe(useLoadedMonaco: Loader["useLoadedMonaco"]) {
	const seen: (typeof fakeMonaco | null)[] = [];
	function Probe() {
		seen.push(useLoadedMonaco());
		return null;
	}
	render(<Probe />);
	return seen;
}

/** The value the hook returned on the most recent render. */
function latest(seen: (typeof fakeMonaco | null)[]) {
	return seen[seen.length - 1];
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("subscribing does not load", () => {
	it("returns null and evaluates nothing until someone asks for Monaco", async () => {
		const { useLoadedMonaco } = await freshLoader();

		const seen = renderHookProbe(useLoadedMonaco);
		// Long enough for a load this render might have started to arrive: the
		// import resolves in a microtask, so asserting straight after `render`
		// would read zero either way and prove nothing.
		await act(async () => {});

		// The mutation check: point the hook at `@monaco-editor/react`'s
		// `useMonaco`, or have it call `ensureMonaco()` itself, and this count
		// goes to 1 - which is the startup cost #1146 removed.
		expect(setupEvaluations).toBe(0);
		expect(latest(seen)).toBeNull();
	});

	it("hands the instance to its subscribers once an editor loads it", async () => {
		const { useLoadedMonaco, ensureMonaco } = await freshLoader();
		const seen = renderHookProbe(useLoadedMonaco);
		expect(latest(seen)).toBeNull();

		await act(async () => {
			await ensureMonaco();
		});

		expect(latest(seen)).toBe(fakeMonaco);
		expect(setupEvaluations).toBe(1);
	});
});

describe("the load happens once", () => {
	it("evaluates the setup module once for concurrent callers", async () => {
		const { ensureMonaco } = await freshLoader();

		const [a, b] = await Promise.all([ensureMonaco(), ensureMonaco()]);

		expect(a).toBe(fakeMonaco);
		expect(b).toBe(fakeMonaco);
		expect(setupEvaluations).toBe(1);
	});

	it("evaluates it once for a later caller too", async () => {
		const { ensureMonaco } = await freshLoader();

		await ensureMonaco();
		await ensureMonaco();

		expect(setupEvaluations).toBe(1);
	});
});
