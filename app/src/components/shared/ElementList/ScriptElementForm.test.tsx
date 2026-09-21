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
 * Three defects reported from the 0.27.0 Elements tab (issue #1605), all in
 * this one form:
 *
 * 1. The editor box resolved `height="100%"` against an auto-height card, so
 *    Monaco laid out at zero height and typed text was invisible. jsdom cannot
 *    lay Monaco out either, so what is pinned here is the box's own inline
 *    style - a definite pixel height, never a percentage.
 * 2. `ScriptSnippets` read one shared boolean, so a `script.pre` and a
 *    `script.post` row on the same screen could not be expanded
 *    independently.
 * 3. The editor could not be resized at all. The handle below the box is
 *    pinned by keyboard (the reliable path in jsdom - `PanelResizeHandle`'s
 *    own test pins its handle the same way) and by a direct pointer-event
 *    dispatch for the drag path - the drag itself writes the box's
 *    `style.height` inside a `requestAnimationFrame` callback
 *    (`PanelResizeHandle`'s own rAF-coalescing, issue #1715), which jsdom
 *    never fires on its own, so the drag tests stub it to run synchronously.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ScriptElementForm } from "./ScriptElementForm";
import { useLayoutStore } from "@/stores";
import {
	DEFAULT_SCRIPT_EDITOR_HEIGHT,
	SCRIPT_EDITOR_HEIGHT_STEP,
	SCRIPT_EDITOR_MAX_HEIGHT,
	SCRIPT_EDITOR_MIN_HEIGHT,
} from "@/constants/layout";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ ariaLabel }: { ariaLabel: string }) => (
		<div data-testid={`code-editor-${ariaLabel}`} />
	),
}));

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: false, isError: false }),
}));

beforeEach(() => {
	useLayoutStore.setState({
		scriptEditorHeights: {},
		scriptEditorHeightDefault: DEFAULT_SCRIPT_EDITOR_HEIGHT,
		scriptSnippetsCollapsed: true,
	});
});

afterEach(() => {
	cleanup();
});

function renderForm(kind: "script.pre" | "script.post" = "script.pre", id = "s1") {
	const onChange = vi.fn();
	render(
		<ScriptElementForm
			id={id}
			kind={kind}
			config={{}}
			description="A test description."
			onChange={onChange}
		/>
	);
	return {
		onChange,
		box: screen.getByTestId(
			`code-editor-${kind === "script.pre" ? "Pre-request script" : "Test script"}`
		).parentElement!,
	};
}

function heightHandle() {
	return screen.getByRole("separator");
}

describe("ScriptElementForm's editor box", () => {
	it("gets a definite pixel height, equal to the store's default, not a percentage of an absent ancestor", () => {
		const { box } = renderForm();

		expect(box).toHaveStyle({ height: `${DEFAULT_SCRIPT_EDITOR_HEIGHT}px` });
		expect(box.className).toContain("min-h-0");
	});

	it("reads whatever height the store already holds", () => {
		useLayoutStore.setState({ scriptEditorHeights: { s1: 240 } });
		const { box } = renderForm();

		expect(box).toHaveStyle({ height: "240px" });
	});
});

describe("the resize handle", () => {
	it("is a focusable, labelled window splitter announcing the current height", () => {
		renderForm("script.post");
		const handle = heightHandle();

		expect(handle).toHaveAttribute("tabindex", "0");
		expect(handle).toHaveAttribute("aria-label", "Test script editor height");
		expect(handle).toHaveAttribute("aria-valuenow", String(DEFAULT_SCRIPT_EDITOR_HEIGHT));
		expect(handle).toHaveAttribute("aria-valuemin", String(SCRIPT_EDITOR_MIN_HEIGHT));
		expect(handle).toHaveAttribute("aria-valuemax", String(SCRIPT_EDITOR_MAX_HEIGHT));
	});

	it("nudges the height by the step on ArrowDown/ArrowUp, written immediately - no debounce", () => {
		renderForm();
		const handle = heightHandle();

		fireEvent.keyDown(handle, { key: "ArrowDown" });
		expect(useLayoutStore.getState().scriptEditorHeights.s1).toBe(
			DEFAULT_SCRIPT_EDITOR_HEIGHT + SCRIPT_EDITOR_HEIGHT_STEP
		);

		fireEvent.keyDown(handle, { key: "ArrowUp" });
		expect(useLayoutStore.getState().scriptEditorHeights.s1).toBe(DEFAULT_SCRIPT_EDITOR_HEIGHT);
	});

	it("clamps at the floor", () => {
		useLayoutStore.setState({ scriptEditorHeights: { s1: SCRIPT_EDITOR_MIN_HEIGHT } });
		renderForm();

		fireEvent.keyDown(heightHandle(), { key: "ArrowUp" });

		expect(useLayoutStore.getState().scriptEditorHeights.s1).toBe(SCRIPT_EDITOR_MIN_HEIGHT);
	});

	it("clamps at the ceiling", () => {
		useLayoutStore.setState({ scriptEditorHeights: { s1: SCRIPT_EDITOR_MAX_HEIGHT } });
		renderForm();

		fireEvent.keyDown(heightHandle(), { key: "ArrowDown" });

		expect(useLayoutStore.getState().scriptEditorHeights.s1).toBe(SCRIPT_EDITOR_MAX_HEIGHT);
	});

	it("drags to a new height, previewing every frame via a direct style write and committing once on release", async () => {
		const rafSpy = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((cb: FrameRequestCallback) => {
				cb(0);
				return 0;
			});
		const { box } = renderForm();
		const handle = heightHandle();

		fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
		window.dispatchEvent(new PointerEvent("pointermove", { clientY: 140, pointerId: 1 }));

		// The frame-by-frame preview is a direct DOM write, not a re-render: the
		// store has not been touched yet, so "s1" still has no entry of its own,
		// but the box's own inline style already shows the live height.
		expect(box).toHaveStyle({ height: `${DEFAULT_SCRIPT_EDITOR_HEIGHT + 40}px` });
		expect(useLayoutStore.getState().scriptEditorHeights.s1).toBeUndefined();

		window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));

		// The one commit the whole drag makes, with the exact value the last
		// frame already painted - no revert-then-jump, because there is nothing
		// left to jump from.
		expect(useLayoutStore.getState().scriptEditorHeights.s1).toBe(
			DEFAULT_SCRIPT_EDITOR_HEIGHT + 40
		);
		expect(box).toHaveStyle({ height: `${DEFAULT_SCRIPT_EDITOR_HEIGHT + 40}px` });

		rafSpy.mockRestore();
	});

	it("clamps a drag past the ceiling", () => {
		const rafSpy = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((cb: FrameRequestCallback) => {
				cb(0);
				return 0;
			});
		renderForm();
		const handle = heightHandle();

		fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
		window.dispatchEvent(
			new PointerEvent("pointermove", {
				clientY: SCRIPT_EDITOR_MAX_HEIGHT * 2,
				pointerId: 1,
			})
		);
		window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));

		expect(useLayoutStore.getState().scriptEditorHeights.s1).toBe(SCRIPT_EDITOR_MAX_HEIGHT);

		rafSpy.mockRestore();
	});
});

/**
 * Issue #1643 part 2: `scriptEditorHeight` used to be one number for every
 * script row, so dragging any one row's handle resized every other one too.
 * Mutation check: have `ScriptElementForm` key `scriptEditorHeights` by `kind`
 * instead of `id` (both rows below are `script.pre`/`script.post`, distinct
 * kinds, so that alone would still pass) - key it by a constant instead, and
 * the first case here reds because dragging "s1" would then also move "s2".
 */
describe("the editor height, per row", () => {
	function renderTwoRows() {
		render(
			<>
				<ScriptElementForm
					id="s1"
					kind="script.pre"
					config={{}}
					description="Runs before the request is sent."
					onChange={() => {}}
				/>
				<ScriptElementForm
					id="s2"
					kind="script.post"
					config={{}}
					description="Runs after the response is received."
					onChange={() => {}}
				/>
			</>
		);
		const [preBox, postBox] = screen
			.getAllByTestId(/^code-editor-/)
			.map((editor) => editor.parentElement!);
		const [preHandle, postHandle] = screen.getAllByRole("separator");
		return { preBox, postBox, preHandle, postHandle };
	}

	it("dragging one row's handle leaves the other row's height unchanged", () => {
		const rafSpy = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((cb: FrameRequestCallback) => {
				cb(0);
				return 0;
			});
		const { preBox, postBox, preHandle } = renderTwoRows();

		fireEvent.pointerDown(preHandle, { clientY: 0, pointerId: 1 });
		window.dispatchEvent(new PointerEvent("pointermove", { clientY: 40, pointerId: 1 }));
		window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));

		expect(preBox).toHaveStyle({ height: `${DEFAULT_SCRIPT_EDITOR_HEIGHT + 40}px` });
		expect(postBox).toHaveStyle({ height: `${DEFAULT_SCRIPT_EDITOR_HEIGHT}px` });
		expect(useLayoutStore.getState().scriptEditorHeights).toEqual({
			s1: DEFAULT_SCRIPT_EDITOR_HEIGHT + 40,
		});
		expect(useLayoutStore.getState().scriptEditorHeightDefault).toBe(
			DEFAULT_SCRIPT_EDITOR_HEIGHT + 40
		);

		rafSpy.mockRestore();
	});

	it("starts a freshly mounted row with no entry of its own from the shared default", () => {
		useLayoutStore.setState({
			scriptEditorHeights: { s1: 300 },
			scriptEditorHeightDefault: 300,
		});

		const { box } = renderForm("script.pre", "s3");

		expect(box).toHaveStyle({ height: "300px" });
	});
});

describe("the Snippets disclosure, per row", () => {
	it("keeps two script rows independent - opening one leaves the other closed", () => {
		render(
			<>
				<ScriptElementForm
					id="s1"
					kind="script.pre"
					config={{}}
					description="Runs before the request is sent."
					onChange={() => {}}
				/>
				<ScriptElementForm
					id="s2"
					kind="script.post"
					config={{}}
					description="Runs after the response is received."
					onChange={() => {}}
				/>
			</>
		);
		const [preToggle, postToggle] = screen.getAllByRole("button", { name: /snippets/i });
		expect(preToggle).toHaveAttribute("aria-expanded", "false");
		expect(postToggle).toHaveAttribute("aria-expanded", "false");

		fireEvent.click(preToggle);

		expect(preToggle).toHaveAttribute("aria-expanded", "true");
		expect(postToggle).toHaveAttribute("aria-expanded", "false");
	});

	it("seeds a fresh row from the store's default", () => {
		useLayoutStore.setState({ scriptSnippetsCollapsed: false });
		renderForm();

		expect(screen.getByRole("button", { name: /snippets/i })).toHaveAttribute(
			"aria-expanded",
			"true"
		);
	});

	it("writes the toggle back as the default the next row opened will start from", () => {
		renderForm();
		fireEvent.click(screen.getByRole("button", { name: /snippets/i }));

		expect(useLayoutStore.getState().scriptSnippetsCollapsed).toBe(false);
	});
});
