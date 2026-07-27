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
 * The Timing tab's palette, and the Raw tab's two silent no-ops.
 *
 * **Two phases were painted from outside the categorical set.** TTFB took
 * `--primary` and Download took `--success`. The design system forbids a chart
 * series on `--primary` because it tracks the user's accent, and this is what
 * that costs: under the green scheme `--primary` is hue 142 and `--success` is
 * hue 142, three points of lightness apart, so two of five phases rendered as
 * the same swatch. Under the default orange, TTFB sat 14 degrees from Connect's
 * amber. `--success` was independently wrong - a status token spent on a series
 * with no status.
 *
 * The colours are inline `style` values rather than classes, so this reads them
 * off the element. jsdom does not resolve `var()`, which is the point: the
 * assertion is about *which token was named*, and naming is exactly what went
 * wrong.
 *
 * **The Raw tab's empty state could never render, and is gone.** The guard was
 * `if (!rawRequest && !response)` where `response` is a required object -
 * always truthy, so the condition was always false. Rewriting the condition was
 * the first attempt and was *also* dead: `buildRawResponse` always emits a
 * status line, and the tab is mounted behind `hasRaw = !!response.rawRequest`.
 * Nothing this component renders can be empty; the check is the tab's
 * existence, one level up.
 *
 * **And its editor asked for a language that did not exist.** Monaco ships no
 * `http`; unknown ids fall back to plain text, so the one tab whose job is
 * reading a protocol exchange was undifferentiated grey.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseTiming } from "../../types";

/** Captures what language the Raw tab actually asks its editor for. */
const editorProps: { language?: string; value?: string }[] = [];
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: (p: { language?: string; value?: string }) => {
		editorProps.push(p);
		return <div data-testid="code-editor" />;
	},
}));

const ResponseTimingTab = (await import("./ResponseTimingTab")).default;
const RawRequestResponse = (await import("./RawRequestResponse")).default;

const { registerHttpLanguage, HTTP_LANGUAGE_ID, RAW_SEPARATOR } =
	await import("@/lib/http-language");

/** `Array.at` is outside this tsconfig's lib target. */
const last = () => editorProps[editorProps.length - 1];

const timing: ResponseTiming = {
	totalMs: 1011,
	wireMs: 1008,
	queueWaitMs: 0.2,
	dnsMs: 64,
	connectMs: 214,
	tlsMs: 517,
	firstByteMs: 213,
	downloadMs: 12,
};

function swatchTokens() {
	const { container } = render(
		<TooltipProvider>
			<ResponseTimingTab timing={timing} />
		</TooltipProvider>
	);
	return Array.from(container.querySelectorAll<HTMLElement>("[style]"))
		.map((el) => el.getAttribute("style") ?? "")
		.map((s) => /var\((--[a-z0-9-]+)\)/.exec(s)?.[1])
		.filter((t): t is string => Boolean(t));
}

describe("the timing waterfall's palette", () => {
	it("names a token for every phase (guards the scan itself)", () => {
		// The bar segments and the legend swatches both carry one.
		expect(swatchTokens().length).toBeGreaterThanOrEqual(5);
	});

	it("spends no accent-tracking token on a series", () => {
		// `--primary` and `--chart-1` are the same value per scheme, and both
		// move with the user's accent - so either can land on a neighbour.
		const tokens = swatchTokens();
		expect(tokens).not.toContain("--primary");
		expect(tokens).not.toContain("--chart-1");
	});

	it("spends no status token on a series", () => {
		const tokens = swatchTokens();
		for (const token of tokens) {
			expect(token).not.toMatch(
				new RegExp(String.raw`^--(success|destructive|warning|status)`)
			);
		}
	});

	it("gives the five phases five distinct hues", () => {
		// The failure this replaces was two phases resolving to the same colour,
		// which is invisible in the source because the tokens were spelled
		// differently.
		const phases = swatchTokens().filter((t) => t.startsWith("--chart-"));
		expect(new Set(phases).size).toBe(5);
	});
});

describe("the http language the Raw tab asks for", () => {
	it("is registered, because Monaco ships no such language", () => {
		const registered: string[] = [];
		const fake = {
			languages: {
				getLanguages: () => registered.map((id) => ({ id })),
				register: ({ id }: { id: string }) => registered.push(id),
				setMonarchTokensProvider: () => {},
			},
		} as unknown as typeof import("monaco-editor");

		registerHttpLanguage(fake);
		expect(registered).toEqual([HTTP_LANGUAGE_ID]);
	});

	it("does not register twice, which would stack a second tokenizer", () => {
		const registered: string[] = [];
		const fake = {
			languages: {
				getLanguages: () => registered.map((id) => ({ id })),
				register: ({ id }: { id: string }) => registered.push(id),
				setMonarchTokensProvider: () => {},
			},
		} as unknown as typeof import("monaco-editor");

		registerHttpLanguage(fake);
		registerHttpLanguage(fake);
		expect(registered).toHaveLength(1);
	});
});

describe("the Raw tab", () => {
	const response = { status: 200, statusText: "OK", headers: { server: "nginx" }, body: "{}" };

	it("shows the exchange, with a separator that is not a fixed-width rule", () => {
		editorProps.length = 0;
		render(<RawRequestResponse rawRequest="GET /orders HTTP/1.1" response={response} />);

		const value = last()?.value ?? "";
		expect(value).toContain("GET /orders HTTP/1.1");
		expect(value).toContain(RAW_SEPARATOR);
		// 60 box characters in a resizable pane, and in the clipboard.
		expect(value).not.toMatch(/─{20,}/);
	});

	it("asks for the language that now exists", () => {
		editorProps.length = 0;
		render(<RawRequestResponse rawRequest="GET / HTTP/1.1" response={response} />);
		expect(last()?.language).toBe(HTTP_LANGUAGE_ID);
	});

	it("still renders the response when the request was not recorded", () => {
		// Restored traces omit `rawRequest`. That is not an empty tab.
		editorProps.length = 0;
		render(<RawRequestResponse rawRequest="" response={response} />);

		const value = last()?.value ?? "";
		expect(value).toContain("200");
		expect(value).not.toContain(RAW_SEPARATOR);
	});

	it("has no empty state, because nothing it renders can be empty", () => {
		/*
		 * The original guard `!rawRequest && !response` could not fire -
		 * `response` is a required object. Rewriting the condition was the first
		 * attempt and was also dead: `buildRawResponse` always emits a status
		 * line, and the tab is mounted behind `hasRaw = !!response.rawRequest`.
		 * The emptiness check is the tab's existence, one level up.
		 */
		editorProps.length = 0;
		render(
			<RawRequestResponse
				rawRequest=""
				response={{ status: 0, statusText: "", headers: {}, body: "" }}
			/>
		);
		expect(screen.queryByText(/no raw data available/i)).toBeNull();
		expect(last()?.value).toContain("HTTP/1.1");
	});
});
