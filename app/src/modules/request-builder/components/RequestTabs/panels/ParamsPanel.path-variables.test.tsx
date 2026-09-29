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
 * The Params tab's "Path variables" table (issue #1764).
 *
 * Both tables edit one `params` array, so the defects this pins are the ones a
 * split makes easy: a query-table edit that writes back only the query rows
 * (dropping every path value), a path edit that rewrites the URL, and a path
 * row leaking into the query table or its bulk text.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import type { KeyValueItem } from "@/types";
import ParamsPanel from "./ParamsPanel";

afterEach(cleanup);

const QUERY: KeyValueItem = { id: "q", key: "page", value: "1", enabled: true };
const PATH: KeyValueItem = { id: "p", key: "id", value: "42", enabled: true, in: "path" };

function renderPanel(
	url: string,
	params: KeyValueItem[],
	resolveString: (s: string) => string = (s) => s
) {
	const updateField = vi.fn();
	const value = {
		request: { ...createDefaultRequestState(), id: `req_${url}`, url, params },
		updateField,
		resolveString,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	const view = render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<ParamsPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
	const lastWrite = (field: string) => {
		const writes = updateField.mock.calls.filter(([f]) => f === field);
		return writes[writes.length - 1]?.[1];
	};
	return { ...view, updateField, lastWrite };
}

const pathSection = () => screen.queryByRole("region", { name: "Path variables" });

/** The key and value fields under `root`, in order (checkboxes excluded). */
const fields = (root: ParentNode) => [
	...root.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])'),
];

function sendsLine(container: HTMLElement): string {
	const label = [...container.querySelectorAll("span")].find((el) => el.textContent === "Sends");
	return label?.nextElementSibling?.textContent ?? "";
}

describe("the Path variables table", () => {
	it("is absent while the URL has no path variable", () => {
		renderPanel("https://x/users?page=1", [QUERY]);
		expect(pathSection()).toBeNull();
	});

	it("lists the path rows, and the query table does not", () => {
		renderPanel("https://x/users/:id?page=1", [QUERY, PATH]);
		const section = pathSection();
		expect(section).not.toBeNull();
		const values = fields(section!).map((el) => el.value);
		expect(values).toEqual(["id", "42"]);

		// Every textbox outside the section is the query table's.
		const outside = fields(document)
			.filter((el) => !section!.contains(el))
			.map((el) => el.value);
		expect(outside).not.toContain("id");
		expect(outside).toContain("page");
	});

	it("locks the key and offers no remove, but leaves the value editable", () => {
		renderPanel("https://x/users/:id", [PATH]);
		const [key, value] = fields(pathSection()!);
		expect(key).toBeDisabled();
		expect(value).not.toBeDisabled();
		expect(within(pathSection()!).queryByRole("button", { name: "Remove row" })).toBeNull();
		// The row is still the user's to switch off.
		expect(within(pathSection()!).getByRole("checkbox", { name: "Enable id" })).toBeEnabled();
	});

	it("writes a value edit back beside the query rows, without touching the URL", () => {
		const { lastWrite } = renderPanel("https://x/users/:id?page=1", [QUERY, PATH]);
		const [, value] = fields(pathSection()!);
		fireEvent.change(value, { target: { value: "7" } });

		const params = lastWrite("params") as KeyValueItem[];
		expect(params.map(({ key, value: v, in: at }) => ({ key, value: v, in: at }))).toEqual([
			{ key: "page", value: "1", in: undefined },
			{ key: "id", value: "7", in: "path" },
		]);
		expect(lastWrite("url")).toBeUndefined();
	});

	it("survives an edit to the query table", () => {
		const { lastWrite } = renderPanel("https://x/users/:id?page=1", [QUERY, PATH]);
		const section = pathSection()!;
		const pageValue = fields(document).find((el) => !section.contains(el) && el.value === "1")!;
		fireEvent.change(pageValue, { target: { value: "2" } });

		const params = lastWrite("params") as KeyValueItem[];
		expect(params.filter((p) => p.in === "path")).toEqual([PATH]);
		expect(lastWrite("url")).toBe("https://x/users/:id?page=2");
	});

	it("keeps members it does not know when a value or the enable box is edited", () => {
		// What a Postman import carries on a path row, for the export round trip.
		const imported = {
			...PATH,
			type: "any",
			description: "user id",
			note: 1,
		} as unknown as KeyValueItem;
		const { lastWrite } = renderPanel("https://x/users/:id", [imported]);
		fireEvent.change(fields(pathSection()!)[1], { target: { value: "7" } });
		expect((lastWrite("params") as KeyValueItem[]).filter((p) => p.in === "path")).toEqual([
			{ ...imported, value: "7" },
		]);

		cleanup();
		const again = renderPanel("https://x/users/:id", [imported]);
		fireEvent.click(within(pathSection()!).getByRole("checkbox", { name: "Enable id" }));
		expect(
			(again.lastWrite("params") as KeyValueItem[]).filter((p) => p.in === "path")
		).toEqual([{ ...imported, enabled: false }]);
	});

	it("resolves a value before encoding it on the Sends line, as compose does", () => {
		const resolve = (s: string) => s.replace(/{{user}}/g, "a b");
		const { container } = renderPanel(
			"https://x/users/:id.json",
			[{ ...PATH, value: "{{user}}" }],
			resolve
		);
		expect(sendsLine(container)).toBe("https://x/users/a%20b.json");
	});

	it("shows the substituted URL on the Sends line", () => {
		const { container } = renderPanel("https://x/users/:id?page=1", [QUERY, PATH]);
		expect(sendsLine(container)).toBe("https://x/users/42?page=1");
	});
});
