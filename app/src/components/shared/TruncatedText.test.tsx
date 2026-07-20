/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The point of this component is that the tooltip is *conditional*. An
 * unconditional `title` would pass any test that only checks "long name shows a
 * tooltip", so every case here also pins down when the tooltip must be absent.
 *
 * jsdom does no layout: scrollWidth and clientWidth are always 0, so the hook
 * would never see an overflow. The tests below define those two properties on
 * the element to stand in for a real measurement.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TruncatedText } from "./TruncatedText";

/** Force a measured size onto the rendered node, as jsdom reports none. */
function setMeasured(el: HTMLElement, scrollWidth: number, clientWidth: number) {
	Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
	Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
}

/**
 * Swap in a ResizeObserver whose callback we can fire on demand — the global
 * test stub is a no-op, so a resize would never reach the hook.
 */
function installControllableResizeObserver() {
	const callbacks: Array<() => void> = [];
	const original = globalThis.ResizeObserver;
	globalThis.ResizeObserver = class {
		constructor(cb: () => void) {
			callbacks.push(cb);
		}
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	return {
		fireResize: () => act(() => callbacks.forEach((cb) => cb())),
		restore: () => {
			globalThis.ResizeObserver = original;
		},
	};
}

describe("TruncatedText", () => {
	afterEach(() => vi.restoreAllMocks());

	it("adds no tooltip when the text fits", () => {
		const { fireResize, restore } = installControllableResizeObserver();
		render(<TruncatedText>Short name</TruncatedText>);
		const el = screen.getByText("Short name");

		setMeasured(el, 80, 200);
		fireResize();
		restore();

		expect(el).not.toHaveAttribute("title");
	});

	it("adds the full text as a tooltip once it is clipped", () => {
		const { fireResize, restore } = installControllableResizeObserver();
		const name = "A Very Long Collection Name That Does Not Fit";
		render(<TruncatedText>{name}</TruncatedText>);
		const el = screen.getByText(name);

		setMeasured(el, 420, 200);
		fireResize();
		restore();

		expect(el).toHaveAttribute("title", name);
	});

	it("removes the tooltip when the element grows enough to show the text", () => {
		const { fireResize, restore } = installControllableResizeObserver();
		const name = "A Very Long Collection Name That Does Not Fit";
		render(<TruncatedText>{name}</TruncatedText>);
		const el = screen.getByText(name);

		setMeasured(el, 420, 200);
		fireResize();
		expect(el).toHaveAttribute("title", name);

		// The user widens the drawer; the name now fits and the tooltip would be
		// redundant with what is already on screen.
		setMeasured(el, 420, 420);
		fireResize();
		restore();

		expect(el).not.toHaveAttribute("title");
	});

	it("ignores a 1px rounding difference", () => {
		const { fireResize, restore } = installControllableResizeObserver();
		render(<TruncatedText>Borderline</TruncatedText>);
		const el = screen.getByText("Borderline");

		// scrollWidth/clientWidth are integers, so sub-pixel layout can report a
		// 1px gap with nothing actually clipped.
		setMeasured(el, 201, 200);
		fireResize();
		restore();

		expect(el).not.toHaveAttribute("title");
	});

	it("always truncates, since the measurement depends on hidden overflow", () => {
		render(<TruncatedText className="text-sm">Name</TruncatedText>);
		const el = screen.getByText("Name");

		expect(el).toHaveClass("truncate");
		expect(el).toHaveClass("text-sm");
	});
});
