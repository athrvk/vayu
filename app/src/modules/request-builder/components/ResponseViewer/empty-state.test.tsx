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
 * The response pane before the first send.
 *
 * It used to be a hand-built icon, heading and hint, a copy of the shared
 * `EmptyState` that did not receive its fixes (#2320). What is pinned is the
 * primitive carrying it and the Send chord hint surviving the move: the chord is
 * the one thing a bare title cannot say.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// The caps are platform-dependent and the platform is a module constant, so the
// hint is driven from a stub and both spellings are asserted.
const chordCaps: { current: string[] } = { current: [] };
vi.mock("@/lib/platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/platform")>()),
	chordKeys: () => chordCaps.current,
}));

const state: { response: ResponseState | null; isExecuting: boolean; request: { id: null } } = {
	response: null,
	isExecuting: false,
	request: { id: null },
};
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

function renderViewer() {
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

describe("the response pane with nothing sent yet", () => {
	it.each([
		["mac", ["⌘", "↵"]],
		["other", ["Ctrl", "↵"]],
	])("renders through EmptyState with the %s Send chord", (_platform, caps) => {
		chordCaps.current = caps;
		const { container } = renderViewer();

		const empty = container.querySelector('[data-slot="empty-state"]');
		expect(empty).not.toBeNull();
		expect(empty).toHaveTextContent("No response yet");
		expect(empty).toHaveTextContent("or click Send");
		// One key cap per key, inside the description, in order.
		const kbds = Array.from(empty!.querySelectorAll("kbd")).map((k) => k.textContent);
		expect(kbds).toEqual(caps);
		// Decorative icon, and the panel background the bespoke block painted.
		expect(empty!.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		expect(empty).toHaveClass("bg-panel");
	});

	it("keeps the hint valid HTML: nothing block-level inside the description paragraph", () => {
		chordCaps.current = ["Ctrl", "↵"];
		const { container } = renderViewer();

		const hint = container.querySelector('[data-slot="empty-state"] p:last-of-type');
		expect(hint).toHaveTextContent("Press");
		expect(hint?.querySelector("div, p")).toBeNull();
	});
});
