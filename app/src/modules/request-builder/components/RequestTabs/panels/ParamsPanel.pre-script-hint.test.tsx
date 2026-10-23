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
 * The "Sends" line states the URL as the previews resolve it, which cannot know
 * what a pre-request script sets. For a request the engine says runs one
 * (`runsPreRequestScript`, #2741 - its own, its folder's or its collection's),
 * the line must not stand as the final URL: it says so and keeps a scope's
 * `{{name}}` written, which is the value the stored scopes cannot vouch for.
 *
 * Mutation check: drop the `{runsPreRequestScript && ...}` block and the hint
 * cases fail; pass `sendsCacheInput(request)` without the flag and the toggle
 * case fails (the stable cache serves the other line); resolve a flagged
 * request through the caller's resolver and the `{{token}}` cases fail.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import ParamsPanel from "./ParamsPanel";
import { fieldResolverOf } from "@/test/variable-support";
import { resolveTemplate } from "@/lib/variable-resolution";

afterEach(cleanup);

const HINT = "A pre-request script can change this URL before it is sent.";

// One identity for the whole file, as the provider's `useCallback` gives the
// panel across a re-render: the stable cache compares the resolver by identity.
const resolve = (s: string) =>
	resolveTemplate(s, (name) => (name === "token" ? "stored-value" : undefined));

function contextValue(runsPreRequestScript: boolean | undefined, url = "https://api.test/u") {
	return {
		request: {
			...createDefaultRequestState(),
			id: "req_1",
			url,
			params: [],
		},
		runsPreRequestScript,
		updateField: () => {},
		resolveString: resolve,
		resolveField: fieldResolverOf(resolve),
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

function renderPanel(runsPreRequestScript: boolean | undefined, url?: string) {
	return render(panel(contextValue(runsPreRequestScript, url)));
}

describe("the Sends line and a pre-request script", () => {
	it("says a script can change the URL when the request runs one", () => {
		renderPanel(true);
		expect(screen.getByText(HINT)).toBeTruthy();
		// The resolved URL is still drawn: the hint qualifies it, not replaces it.
		expect(screen.getByText("https://api.test/u")).toBeTruthy();
	});

	it.each([[false], [undefined]])("says nothing when the flag is %s", (flag) => {
		renderPanel(flag);
		expect(screen.queryByText(HINT)).toBeNull();
		expect(screen.getByText("https://api.test/u")).toBeTruthy();
	});

	it("leaves the line itself the same with and without the hint", () => {
		const lineOf = (flag: boolean) => {
			const { container, unmount } = renderPanel(flag);
			const label = [...container.querySelectorAll("span")].find(
				(el) => el.textContent === "Sends"
			);
			const html = label?.parentElement?.outerHTML;
			unmount();
			return html;
		};
		expect(lineOf(true)).toBeDefined();
		expect(lineOf(true)).toBe(lineOf(false));
	});
});

describe("the Sends line for a request a script runs before", () => {
	const TOKEN_URL = "https://api.test/{{token}}/{{$randomInt}}";
	/** Matches the line drawn: @p prefix, then the digits `{{$randomInt}}` generated. */
	const lineOf = (prefix: string) => (text: string) =>
		text.startsWith(prefix) && /^\d+$/.test(text.slice(prefix.length));

	it("keeps a scope's {{name}} written, not the stored value, and still generates $dynamic", () => {
		renderPanel(true, TOKEN_URL);
		expect(screen.getByText(lineOf("https://api.test/{{token}}/"))).toBeTruthy();
		expect(screen.queryByText(/stored-value/)).toBeNull();
	});

	it.each([[false], [undefined]])("resolves the stored value when the flag is %s", (flag) => {
		renderPanel(flag, TOKEN_URL);
		expect(screen.getByText(lineOf("https://api.test/stored-value/"))).toBeTruthy();
	});

	it("follows the flag when it changes under the same resolver, not the cached line", () => {
		const { rerender } = renderPanel(false, "https://api.test/{{token}}");
		expect(screen.getByText("https://api.test/stored-value")).toBeTruthy();
		rerender(panel(contextValue(true, "https://api.test/{{token}}")));
		expect(screen.getByText("https://api.test/{{token}}")).toBeTruthy();
		rerender(panel(contextValue(false, "https://api.test/{{token}}")));
		expect(screen.getByText("https://api.test/stored-value")).toBeTruthy();
	});
});
