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
 * The Params table writes the query with Postman's rule (issue #1771), through
 * the component rather than the helper: the issue's `q=a|b` and `r=c d` land in
 * the URL as `q=a|b&r=c%20d`, the URL a Postman import of the same rows stores.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import type { KeyValueItem } from "@/types";
import ParamsPanel from "./ParamsPanel";

afterEach(cleanup);

function renderPanel(url: string, params: KeyValueItem[]) {
	const updateField = vi.fn();
	const value = {
		request: { ...createDefaultRequestState(), id: "req_1", url, params },
		updateField,
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<ParamsPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
	return (field: string) => {
		const writes = updateField.mock.calls.filter(([f]) => f === field);
		return writes[writes.length - 1]?.[1];
	};
}

const fieldWithValue = (value: string) =>
	[...document.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')].find(
		(el) => el.value === value
	)!;

describe("the Params table's query encoding", () => {
	it("writes the issue's rows as q=a|b&r=c%20d", () => {
		// Mutation check: adding `|` to the encode set writes `q=a%7Cb` here.
		const lastWrite = renderPanel("https://x/", [
			{ id: "1", key: "q", value: "a|b", enabled: true },
			{ id: "2", key: "r", value: "c", enabled: true },
		]);
		fireEvent.change(fieldWithValue("c"), { target: { value: "c d" } });
		expect(lastWrite("url")).toBe("https://x/?q=a|b&r=c%20d");
	});

	it("leaves the URL's own bytes for a pair the edit does not touch", () => {
		const lastWrite = renderPanel("https://x/?q=a%7Cb&r=c", [
			{ id: "1", key: "q", value: "a%7Cb", enabled: true },
			{ id: "2", key: "r", value: "c", enabled: true },
		]);
		fireEvent.change(fieldWithValue("c"), { target: { value: "c d" } });
		expect(lastWrite("url")).toBe("https://x/?q=a%7Cb&r=c%20d");
	});

	it("writes a row edited to the decoded spelling as typed", () => {
		// Mutation check: not passing the previous rows to `buildUrlWithParams`
		// lets the edited `+` claim `%2B` by its decoded spelling, and the URL
		// stays `?t=%2B`.
		const lastWrite = renderPanel("https://x/?t=%2B", [
			{ id: "1", key: "t", value: "%2B", enabled: true },
		]);
		fireEvent.change(fieldWithValue("%2B"), { target: { value: "+" } });
		expect(lastWrite("url")).toBe("https://x/?t=+");
	});
});
