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
 * as the line changing on its own. `resolvedUrl` is `useMemo`'d on
 * `request.url` now; this pins the memo by counting calls to a stub resolver
 * per exact input text, since a real re-render's own timing can't otherwise
 * be asserted against.
 *
 * Calls with other input text (the key/value table's own blank placeholder
 * row resolves its empty strings through the same `resolveString`) are
 * ignored by filtering on the URL text itself - this pins the preview line,
 * not the whole panel's call volume.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";

const { default: ParamsPanel } = await import("./ParamsPanel");

const URL = "https://api.example.test/todos/{{$randomInt}}";

function contextValue(resolveString: (input: string) => string, url: string) {
	const request: RequestState = {
		...createDefaultRequestState(),
		id: "req_1",
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

describe("the resolved-URL preview", () => {
	it("does not re-resolve the URL on a re-render with nothing about it changed", () => {
		const resolveString = makeResolver();

		const { rerender } = render(panel(contextValue(resolveString, URL)));
		expect(callsFor(resolveString, URL)).toBe(1);

		// A re-render triggered by something unrelated to this URL - switching
		// away and back to the tab, another field changing - must not resolve it
		// again. `resolveDynamicVariable` would hand back a different value on a
		// second call, which is exactly what must not happen here.
		rerender(panel(contextValue(resolveString, URL)));
		expect(callsFor(resolveString, URL)).toBe(1);
	});

	it("re-resolves once the URL text actually changes", () => {
		const resolveString = makeResolver();
		const edited = `${URL}/edited`;

		const { rerender } = render(panel(contextValue(resolveString, URL)));
		expect(callsFor(resolveString, URL)).toBe(1);

		rerender(panel(contextValue(resolveString, edited)));
		expect(callsFor(resolveString, edited)).toBe(1);
	});
});
