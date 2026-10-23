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
 * the line must not stand as the final URL.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import ParamsPanel from "./ParamsPanel";
import { fieldResolverOf } from "@/test/variable-support";

afterEach(cleanup);

const HINT = "A pre-request script can change this URL before it is sent.";

function renderPanel(runsPreRequestScript: boolean | undefined) {
	const resolve = (s: string) => s;
	const value = {
		request: {
			...createDefaultRequestState(),
			id: "req_1",
			url: "https://api.test/u",
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
	return render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<ParamsPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
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
