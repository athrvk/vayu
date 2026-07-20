import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScrollOnOverflow } from "./ScrollOnOverflow";

/**
 * jsdom does no layout, so scrollWidth/clientWidth are always 0. Stub them at
 * the prototype level to model "text wider than its box" and "text that fits".
 */
function stubWidths({ track, viewport }: { track: number; viewport: number }) {
	Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
		configurable: true,
		get() {
			return this.dataset.role === "viewport" ? viewport : track;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get() {
			return viewport;
		},
	});
}

beforeEach(() => {
	// ResizeObserver is not implemented in jsdom
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		}
	);
});

describe("ScrollOnOverflow", () => {
	// Attaching the animation to every label would leave a strip of short tabs
	// permanently animating on hover for no reason.
	it("does not mark text that fits", () => {
		stubWidths({ track: 80, viewport: 200 });
		const { container } = render(<ScrollOnOverflow>Short</ScrollOnOverflow>);
		const viewport = container.firstElementChild!;
		expect(viewport.className).not.toContain("scroll-on-overflow");
		expect(viewport.firstElementChild!.getAttribute("style")).toBeNull();
	});

	it("marks overflowing text and scrolls by the measured distance", () => {
		stubWidths({ track: 380, viewport: 200 });
		const { container } = render(<ScrollOnOverflow>A very long tab title</ScrollOnOverflow>);
		const viewport = container.firstElementChild!;
		expect(viewport.className).toContain("scroll-on-overflow");

		const style = viewport.firstElementChild!.getAttribute("style") ?? "";
		// exactly the overflow, not a guessed amount
		expect(style).toContain("--scroll-distance: -180px");
		expect(style).toMatch(/--scroll-duration: [\d.]+s/);
	});

	// Constant speed: a longer label takes proportionally longer rather than
	// racing past at the same duration.
	it("scales duration with distance", () => {
		const durationFor = (track: number) => {
			stubWidths({ track, viewport: 200 });
			const { container, unmount } = render(<ScrollOnOverflow>x</ScrollOnOverflow>);
			const style =
				container.firstElementChild!.firstElementChild!.getAttribute("style") ?? "";
			const s = Number(/--scroll-duration: ([\d.]+)s/.exec(style)?.[1]);
			unmount();
			return s;
		};
		expect(durationFor(600)).toBeGreaterThan(durationFor(260));
	});

	it("renders its children", () => {
		stubWidths({ track: 80, viewport: 200 });
		render(<ScrollOnOverflow>Requests</ScrollOnOverflow>);
		expect(screen.getByText("Requests")).toBeInTheDocument();
	});
});
