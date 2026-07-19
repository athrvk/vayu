import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

/**
 * jsdom has no Canvas 2D implementation, but uPlot (our centralized chart engine)
 * needs a context to construct. Stub a permissive no-op 2D context so chart
 * components mount in tests without pulling in the native `canvas` package. We
 * assert data-shaping in pure-function tests; rendering fidelity is validated
 * visually (Playwright), not in jsdom.
 */
const noopContext = new Proxy(
	{
		canvas: {} as HTMLCanvasElement,
		measureText: () => ({ width: 0 }) as TextMetrics,
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		createLinearGradient: () => ({ addColorStop: () => {} }),
		setLineDash: () => {},
		getLineDash: () => [],
	},
	{
		get: (target, prop) =>
			prop in target ? (target as Record<string | symbol, unknown>)[prop] : () => {},
		set: () => true,
	}
) as unknown as CanvasRenderingContext2D;

HTMLCanvasElement.prototype.getContext = vi.fn(
	() => noopContext
) as unknown as HTMLCanvasElement["getContext"];

// uPlot builds paths with Path2D (jsdom has none); a no-op class is enough since
// the stubbed context's stroke/fill are no-ops.
if (typeof globalThis.Path2D === "undefined") {
	globalThis.Path2D = class {
		addPath() {}
		arc() {}
		arcTo() {}
		bezierCurveTo() {}
		closePath() {}
		ellipse() {}
		lineTo() {}
		moveTo() {}
		quadraticCurveTo() {}
		rect() {}
		roundRect() {}
	} as unknown as typeof Path2D;
}

if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}

// uPlot watches devicePixelRatio via matchMedia, which jsdom doesn't implement.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	})) as unknown as typeof window.matchMedia;
}
