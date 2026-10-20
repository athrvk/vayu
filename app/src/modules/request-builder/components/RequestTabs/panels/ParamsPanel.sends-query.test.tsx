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
 * The "Sends" line writes a `{{var}}` by the part of the URL it lands in, and
 * the literal text around it with nothing a request target cannot carry raw
 * (issues #1773, #2465), as the engine's compose does, through the component
 * rather than the helper: the helper is pinned to the engine by the
 * conformance fixture, and this pins that the line actually goes through it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { KeyValueItem } from "@/types";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import ParamsPanel from "./ParamsPanel";

afterEach(cleanup);

const resolve = (s: string) =>
	s
		.replace(/{{term}}/g, "a b#c")
		.replace(/{{base}}/g, "https://x")
		.replace(/{{name}}/g, "John Doe");

function sendsLine(url: string, disableUrlEncoding: boolean, params: KeyValueItem[] = []): string {
	const value = {
		request: {
			...createDefaultRequestState(),
			id: `req_${url}_${disableUrlEncoding}_${JSON.stringify(params)}`,
			url,
			params,
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

	it("encodes a value a variable brings into the path", () => {
		expect(sendsLine("{{base}}/users/{{name}}", false)).toBe("https://x/users/John%20Doe");
	});

	it("encodes the literal text around a token that a request target cannot carry raw", () => {
		expect(sendsLine("{{base}}/a b/é?q=x y", false)).toBe("https://x/a%20b/%C3%A9?q=x%20y");
		expect(sendsLine("{{base}}/a b/é?q=x y", true)).toBe("https://x/a b/é?q=x y");
	});

	it("does not encode a path variable's value a second time", () => {
		// Mutation check: encoding `%` in the literal pass writes `%2520`.
		const row: KeyValueItem = {
			id: "p",
			key: "id",
			value: "{{name}}",
			enabled: true,
			in: "path",
		};
		expect(sendsLine("{{base}}/users/:id/a b", false, [row])).toBe(
			"https://x/users/John%20Doe/a%20b"
		);
	});
});
