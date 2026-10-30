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
 * A request's editor models live exactly as long as its tab, and no longer than
 * the builder (#3136). The models survive a request switch on purpose - that is
 * what keeps each request's undo stack - so a tab closing is the only thing
 * that ends one while the builder is up.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useTabsStore } from "@/stores";
import { realMonaco } from "@/test/real-monaco.testkit";
import { requestModelPath } from "../utils/editor-models";

vi.mock("@/lib/monaco-loader", async () =>
	(await import("@/test/real-monaco.testkit")).realMonacoLoader()
);

const { useRequestModelLifecycle } = await import("./useRequestModelLifecycle");
const monaco = await realMonaco();

const UNRELATED = "inmemory://model/script";

function modelFor(id: string | null, pane: "body" | "graphql-query" = "body") {
	return monaco.editor.createModel(
		"x",
		"plaintext",
		monaco.Uri.parse(requestModelPath(id, pane))
	);
}

function openRequestTabs(...ids: string[]) {
	useTabsStore.setState({
		openTabs: ids.map((id) => ({ id: `tab_${id}`, type: "request", entityId: id })),
	});
}

afterEach(() => {
	cleanup();
	monaco.editor.getModels().forEach((m) => m.dispose());
	useTabsStore.setState({ openTabs: [] });
});

describe("useRequestModelLifecycle", () => {
	it("disposes the models of a request with no tab, on mount", () => {
		openRequestTabs("open");
		const open = modelFor("open");
		const gone = modelFor("gone");

		renderHook(() => useRequestModelLifecycle());

		expect(open.isDisposed()).toBe(false);
		expect(gone.isDisposed()).toBe(true);
	});

	it("disposes every pane of a request when its tab closes", () => {
		openRequestTabs("a", "b");
		const a = [modelFor("a"), modelFor("a", "graphql-query")];
		const b = modelFor("b");
		renderHook(() => useRequestModelLifecycle());

		act(() => openRequestTabs("b"));

		expect(a.map((m) => m.isDisposed())).toEqual([true, true]);
		expect(b.isDisposed()).toBe(false);
	});

	it("keeps a run's models and the id-less builder's, which name no request tab", () => {
		useTabsStore.setState({ openTabs: [{ id: "t", type: "run", entityId: "run_1" }] });
		const run = modelFor("run_1");
		const unsaved = modelFor(null);

		renderHook(() => useRequestModelLifecycle());

		expect(run.isDisposed()).toBe(false);
		expect(unsaved.isDisposed()).toBe(false);
	});

	it("leaves models that are not a request's alone", () => {
		openRequestTabs();
		const script = monaco.editor.createModel("x", "javascript", monaco.Uri.parse(UNRELATED));

		renderHook(() => useRequestModelLifecycle());

		expect(script.isDisposed()).toBe(false);
	});

	it("disposes them all when the builder goes away, so a remount reads fresh text", () => {
		openRequestTabs("a", "b");
		const models = [modelFor("a"), modelFor("b")];
		const { unmount } = renderHook(() => useRequestModelLifecycle());
		expect(models.map((m) => m.isDisposed())).toEqual([false, false]);

		unmount();

		expect(models.map((m) => m.isDisposed())).toEqual([true, true]);
	});

	it("stops listening to the tabs once unmounted", () => {
		openRequestTabs("a");
		const { unmount } = renderHook(() => useRequestModelLifecycle());
		unmount();
		const late = modelFor("late");

		act(() => openRequestTabs("a"));

		expect(late.isDisposed()).toBe(false);
	});
});
