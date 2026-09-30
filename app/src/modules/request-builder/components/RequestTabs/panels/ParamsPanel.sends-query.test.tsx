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
 * The "Sends" line writes a `{{var}}` that lands in the query as Postman
 * writes substituted URL text (issue #1773), as the engine's compose does, through the
 * component rather than the helper: the helper is pinned to the engine by the
 * conformance fixture, and this pins that the line actually goes through it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import ParamsPanel from "./ParamsPanel";

afterEach(cleanup);

const resolve = (s: string) => s.replace(/{{term}}/g, "a b#c").replace(/{{base}}/g, "https://x");

function sendsLine(url: string, disableUrlEncoding: boolean): string {
	const value = {
		request: {
			...createDefaultRequestState(),
			id: `req_${url}_${disableUrlEncoding}`,
			url,
			params: [],
			disableUrlEncoding,
		},
		updateField: () => {},
		resolveString: resolve,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	const { container } = render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<ParamsPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
	const label = [...container.querySelectorAll("span")].find((el) => el.textContent === "Sends");
	return label?.nextElementSibling?.textContent ?? "";
}

describe("the Sends line's query", () => {
	it("encodes a value a variable brings into the query, its # opening the fragment", () => {
		expect(sendsLine("{{base}}/s?q={{term}}", false)).toBe("https://x/s?q=a%20b#c");
	});

	it("shows the value as it stands under disableUrlEncoding", () => {
		expect(sendsLine("{{base}}/s?q={{term}}", true)).toBe("https://x/s?q=a b#c");
	});
});
