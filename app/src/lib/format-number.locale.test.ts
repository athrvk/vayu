/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The digits a surface draws follow the user's locale as one rule (#3497): under
 * a decimal-comma locale 2.5 ms and 1234.5 ms must both use the comma, where the
 * seconds branch used to be a hand-built `toFixed` that always wrote ".". The
 * formatters build their Intl.NumberFormat on first use, so each case pins the
 * locale, resets the module graph and imports afresh. Both decimal marks are
 * asserted: a test that only saw "." would pass on a broken formatter.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const RealNumberFormat = Intl.NumberFormat;

async function loadIn(locale: string) {
	class PinnedNumberFormat extends RealNumberFormat {
		constructor(_locale?: string | string[], options?: Intl.NumberFormatOptions) {
			super(locale, options);
		}
	}
	Intl.NumberFormat = PinnedNumberFormat as typeof Intl.NumberFormat;
	vi.resetModules();
	return {
		numbers: await import("./format-number"),
		viewer: await import("@/components/shared/response-viewer/utils"),
		dashboard: await import("@/modules/dashboard/utils/format"),
		charts: await import("@/modules/dashboard/components/charts/uplot/formatters"),
		hdr: await import("@/modules/dashboard/components/charts/uplot/hdrMarkers"),
	};
}

afterEach(() => {
	Intl.NumberFormat = RealNumberFormat;
	vi.resetModules();
});

// "." locale, then "," locale; the thousands mark differs too.
const LOCALES = [
	{ locale: "en-US", mark: ".", group: "," },
	{ locale: "de-DE", mark: ",", group: "." },
] as const;

describe.each(LOCALES)("digits under $locale", ({ locale, mark, group }) => {
	it("a latency in milliseconds and in seconds use the same decimal mark", async () => {
		const { numbers } = await loadIn(locale);
		expect(numbers.formatLatency(2.5)).toBe(`2${mark}5ms`);
		expect(numbers.formatLatency(1234.5)).toBe(`1${mark}23s`);
		expect(numbers.formatLatencyParts(1234.5)).toEqual({ value: `1${mark}23`, unit: "s" });
		expect(numbers.formatLatency(1999.4)).toBe(`2${mark}00s`);
	});

	it("a duration in seconds takes the mark from the same place", async () => {
		const { numbers } = await loadIn(locale);
		expect(numbers.formatSeconds(4.2)).toBe(`4${mark}20s`);
		expect(numbers.formatSeconds(3600)).toBe(`3${group}600s`);
	});

	it("fixed and trimmed decimals", async () => {
		const { numbers } = await loadIn(locale);
		expect(numbers.formatFixed(2.5, 2)).toBe(`2${mark}50`);
		// Ungrouped, as the toFixed it replaced was.
		expect(numbers.formatFixed(1234.5, 1)).toBe(`1234${mark}5`);
		expect(numbers.formatTrimmed(2.5, 3)).toBe(`2${mark}5`);
		expect(numbers.formatTrimmed(3, 3)).toBe("3");
		// Intl signs a value that rounds to zero and a literal -0; a tick never read "-0".
		expect(numbers.formatTrimmed(-0.0001, 1)).toBe("0");
		expect(numbers.formatTrimmed(-0, 1)).toBe("0");
		expect(numbers.formatFixed(-0, 1)).toBe(`0${mark}0`);
	});

	it("a size takes the decimal mark from the same place", async () => {
		const { numbers } = await loadIn(locale);
		expect(numbers.formatBytes(1536)).toBe(`1${mark}5 KB`);
		expect(numbers.formatBytes(3 * 1024 ** 3)).toBe(`3${mark}0 GB`);
		// Whole bytes are ungrouped, as the template literal they replaced was.
		expect(numbers.formatBytes(1023)).toBe("1023 B");
	});

	it("a response phase keeps its magnitude ladder", async () => {
		const { viewer } = await loadIn(locale);
		expect(viewer.formatPhaseMs(0.04)).toBe(`0${mark}04`);
		expect(viewer.formatPhaseMs(47.83)).toBe(`47${mark}8`);
		expect(viewer.formatPhaseMs(262.4)).toBe("262");
		expect(viewer.formatPhaseDuration(1500)).toEqual({ value: `1${mark}50`, unit: "s" });
	});

	it("an error percent keeps a non-zero rate from reading as zero", async () => {
		const { dashboard } = await loadIn(locale);
		expect(dashboard.formatErrorPercent(0)).toBe(`0${mark}0`);
		expect(dashboard.formatErrorPercent(2.5)).toBe(`2${mark}5`);
		expect(dashboard.formatErrorPercent(0.01)).toBe(`<0${mark}1`);
		expect(dashboard.formatErrorPercent(0.004, 2)).toBe(`<0${mark}01`);
	});

	it("chart ticks and tooltips", async () => {
		const { charts } = await loadIn(locale);
		expect(charts.axisMs(1.5, [0, 0.5, 1, 1.5, 2])).toBe(`1${mark}5ms`);
		expect(charts.axisMs(2500, [0, 2500, 5000])).toBe(`2${mark}5s`);
		expect(charts.fmtSeconds(1.26)).toBe(`1${mark}3s`);
		expect(charts.fmtVitals(0.42)).toBe(`0${mark}420`);
	});

	it("the HDR percentile readout", async () => {
		const { hdr } = await loadIn(locale);
		// x of the 99.9th percentile, the one mark with a decimal.
		expect(hdr.xToPctLabel(hdr.pctToX(99.9))).toBe(`99${mark}9%`);
		expect(hdr.xToPctLabel(0)).toBe("0%");
	});
});
