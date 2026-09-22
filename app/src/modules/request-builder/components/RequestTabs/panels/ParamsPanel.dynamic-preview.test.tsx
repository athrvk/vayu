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
 * The "Sends" line's resolved URL used to be `resolveString(request.url)`
 * called inline, in the component body. A dynamic variable like
 * `{{$randomInt}}` generates a fresh value on every call
 * (`lib/dynamic-variables.ts`'s own contract), so every re-render this panel
 * took for any reason - not only a URL edit - rerolled the value, which read
 * as the line changing on its own.
 *
 * **The remount is the case that matters, and a `useMemo` cannot answer it.**
 * Params is not force-mounted (`RequestTabs/index.tsx` force-mounts Body and
 * Elements only), so Params → Headers → Params destroys this component and
 * builds a new one; a memo dies with the old instance and the new one's first
 * render resolves fresh. The user-visible symptom was exactly that: the number
 * changed on every round trip through another tab. `stableResolvedUrl` is the
 * module-scope cache from `lib/dynamic-variable-cache.ts`, which outlives the
 * component.
 *
 * Both cases are pinned by counting calls to a stub resolver per exact input
 * text, since a real render's own timing can't otherwise be asserted against.
 * Calls with other input text (the key/value table's own blank placeholder row
 * resolves its empty strings through the same `resolveString`) are ignored by
 * filtering on the URL text itself - this pins the preview line, not the whole
 * panel's call volume.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";

const { default: ParamsPanel } = await import("./ParamsPanel");

const URL = "https://api.example.test/todos/{{$randomInt}}";

function contextValue(resolveString: (input: string) => string, url: string, id: string) {
	const request: RequestState = {
		...createDefaultRequestState(),
		id,
		url,
	};
	return {
		request,
		updateField: vi.fn(),
		resolveString,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
}

function panel(value: RequestBuilderContextValue) {
	return (
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<ParamsPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

/** Never caches - a fresh call is a fresh call, matching the generator table. */
function makeResolver() {
	return vi.fn((input: string) => input);
}

function callsFor(resolveString: ReturnType<typeof makeResolver>, input: string): number {
	return resolveString.mock.calls.filter(([arg]) => arg === input).length;
}

/**
 * A resolver that behaves the way the dynamic-variable table does: every call
 * hands back a *different* value for the same input. Anything that resolves
 * twice therefore shows two different strings, which is the defect itself.
 */
function makeRerollingResolver() {
	let n = 0;
	return vi.fn((input: string) => input.replace("{{$randomInt}}", String(++n)));
}

/**
 * The text beside the "Sends" label. Found through the label rather than by a
 * class, because the panel renders other `font-mono` spans (the bulk-edit
 * hint's `key=value` samples among them).
 */
function sendsLine(container: HTMLElement): string {
	const label = [...container.querySelectorAll("span")].find((el) => el.textContent === "Sends");
	return label?.nextElementSibling?.textContent ?? "";
}

describe("the resolved-URL preview", () => {
	it("does not re-resolve the URL on a re-render with nothing about it changed", () => {
		const resolveString = makeResolver();

		const { rerender } = render(panel(contextValue(resolveString, URL, "req_rerender")));
		expect(callsFor(resolveString, URL)).toBe(1);

		// A re-render triggered by something unrelated to this URL - another
		// field changing, a store update elsewhere - must not resolve it again.
		// `resolveDynamicVariable` would hand back a different value on a second
		// call, which is exactly what must not happen here.
		rerender(panel(contextValue(resolveString, URL, "req_rerender")));
		expect(callsFor(resolveString, URL)).toBe(1);
	});

	it("keeps the same resolved URL across the unmount a tab switch causes", () => {
		// The reported repro: Params → Headers → Params. Radix unmounts an
		// inactive `TabsContent` and this panel is not force-mounted, so the
		// second visit is a *new component instance*, not a re-render - which is
		// why a `useMemo` could not hold this and the module-scope cache can.
		const resolveString = makeRerollingResolver();

		const first = render(panel(contextValue(resolveString, URL, "req_remount")));
		const before = sendsLine(first.container);
		// Sanity: the line really carries a generated value, not the raw token.
		expect(before).toBe("https://api.example.test/todos/1");
		first.unmount();

		const second = render(panel(contextValue(resolveString, URL, "req_remount")));
		expect(sendsLine(second.container)).toBe(before);
	});

	it("re-resolves once the URL text actually changes", () => {
		const resolveString = makeResolver();
		const edited = `${URL}/edited`;

		const { rerender } = render(panel(contextValue(resolveString, URL, "req_edit")));
		expect(callsFor(resolveString, URL)).toBe(1);

		rerender(panel(contextValue(resolveString, edited, "req_edit")));
		expect(callsFor(resolveString, edited)).toBe(1);
	});

	it("gives two requests their own value rather than one keyed by URL text", () => {
		// Byte-identical templates on two different requests. Keying the cache on
		// the text alone would collapse them, which is the collision the resolver
		// conformance fixture forbids for two distinct occurrences.
		const resolveString = makeRerollingResolver();

		const a = render(panel(contextValue(resolveString, URL, "req_a")));
		const b = render(panel(contextValue(resolveString, URL, "req_b")));
		expect(sendsLine(a.container)).not.toBe(sendsLine(b.container));
	});
});
