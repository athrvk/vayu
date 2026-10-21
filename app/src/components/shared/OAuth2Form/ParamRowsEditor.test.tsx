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
 * The extra parameter lists (#2536) are stored as `OAuth2ParamRow[]` and edited
 * as the key/value table's rows. What the table cannot show - a row's `sendAs`,
 * the difference between an empty list and an absent one - has to survive the
 * round trip, and an edit has to come back from the parent without the table
 * rebuilding its row ids under the cursor.
 */

import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { OAuth2ParamRow } from "@/types";
import ParamRowsEditor from "./ParamRowsEditor";

const IMPORTED: OAuth2ParamRow[] = [
	{ key: "audience", value: "api", enabled: true, sendAs: "url" },
	{ key: "acr_values", value: "2", enabled: true, sendAs: "header" },
];

function Harness({
	initial,
	spy,
	sendAs = true,
}: {
	initial: OAuth2ParamRow[] | undefined;
	spy: (rows: OAuth2ParamRow[] | undefined) => void;
	sendAs?: boolean;
}) {
	const [rows, setRows] = useState(initial);
	return (
		<TooltipProvider>
			<ParamRowsEditor
				label="Token request parameters"
				hint="hint"
				rows={rows}
				onChange={(next) => {
					spy(next);
					setRows(next);
				}}
				sendAs={sendAs}
			/>
		</TooltipProvider>
	);
}

const keyInputs = () => screen.getAllByPlaceholderText("Parameter") as HTMLInputElement[];
const valueInputs = () => screen.getAllByPlaceholderText("Value") as HTMLInputElement[];
const sendInSelect = (key: string) => screen.getByRole("combobox", { name: `Send ${key} in` });

function chooseSendIn(key: string, option: string) {
	fireEvent.click(sendInSelect(key));
	fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("ParamRowsEditor", () => {
	it("names its table for assistive technology", () => {
		render(<Harness initial={undefined} spy={vi.fn()} />);
		expect(screen.getByRole("group", { name: "Token request parameters" })).toBeTruthy();
	});

	it("writes a typed row as a body row, with no sendAs", () => {
		const spy = vi.fn();
		render(<Harness initial={undefined} spy={spy} />);

		fireEvent.change(keyInputs()[0], { target: { value: "audience" } });

		expect(spy).toHaveBeenLastCalledWith([{ key: "audience", value: "", enabled: true }]);
	});

	it("keeps an imported row's sendAs when its value is edited", () => {
		const spy = vi.fn();
		render(<Harness initial={IMPORTED} spy={spy} />);

		fireEvent.change(valueInputs()[0], { target: { value: "api-2" } });

		expect(spy).toHaveBeenLastCalledWith([
			{ key: "audience", value: "api-2", enabled: true, sendAs: "url" },
			{ key: "acr_values", value: "2", enabled: true, sendAs: "header" },
		]);
	});

	it("writes an unticked row as disabled, not as removed", () => {
		const spy = vi.fn();
		render(<Harness initial={IMPORTED} spy={spy} />);

		fireEvent.click(screen.getByRole("checkbox", { name: "Enable audience" }));

		expect(spy.mock.lastCall?.[0]?.[0]).toEqual({
			key: "audience",
			value: "api",
			enabled: false,
			sendAs: "url",
		});
	});

	it("writes undefined once the last row is removed", () => {
		const spy = vi.fn();
		render(<Harness initial={[IMPORTED[0]]} spy={spy} />);

		fireEvent.click(screen.getAllByRole("button", { name: "Remove row" })[0]);

		expect(spy).toHaveBeenLastCalledWith(undefined);
	});

	it("does not rebuild the table when the parent hands back what was written", () => {
		render(<Harness initial={IMPORTED} spy={vi.fn()} />);
		const before = keyInputs()[0];

		fireEvent.change(valueInputs()[0], { target: { value: "api-2" } });

		expect(keyInputs()[0]).toBe(before);
		expect(valueInputs()[0].value).toBe("api-2");
	});

	it("rebuilds the table when the list changes from outside", () => {
		const view = render(
			<TooltipProvider>
				<ParamRowsEditor label="L" hint="h" rows={IMPORTED} onChange={vi.fn()} />
			</TooltipProvider>
		);
		expect(keyInputs()[0].value).toBe("audience");

		view.rerender(
			<TooltipProvider>
				<ParamRowsEditor
					label="L"
					hint="h"
					rows={[{ key: "tenant", value: "t1" }]}
					onChange={vi.fn()}
				/>
			</TooltipProvider>
		);

		expect(keyInputs()[0].value).toBe("tenant");
		expect(valueInputs()[0].value).toBe("t1");
	});

	it("reads a malformed stored list as empty rather than throwing", () => {
		const malformed = "audience=api" as unknown as OAuth2ParamRow[];
		render(<Harness initial={malformed} spy={vi.fn()} />);
		expect(keyInputs()).toHaveLength(1);
		expect(keyInputs()[0].value).toBe("");
	});

	describe("the Send in select", () => {
		it("shows every row's place, an imported one included", () => {
			render(
				<Harness initial={[...IMPORTED, { key: "tenant", value: "t1" }]} spy={vi.fn()} />
			);

			expect(sendInSelect("audience")).toHaveTextContent("URL");
			expect(sendInSelect("acr_values")).toHaveTextContent("Header");
			expect(sendInSelect("tenant")).toHaveTextContent("Body");
		});

		it("falls back to a generic name for a row with no key", () => {
			render(<Harness initial={[{ key: "", value: "v", sendAs: "url" }]} spy={vi.fn()} />);
			expect(screen.getByRole("combobox", { name: "Send this parameter in" })).toBeTruthy();
		});

		it("writes the target a typed row is sent in", () => {
			const spy = vi.fn();
			render(<Harness initial={[{ key: "audience", value: "api" }]} spy={spy} />);

			chooseSendIn("audience", "URL");

			expect(spy).toHaveBeenLastCalledWith([
				{ key: "audience", value: "api", enabled: true, sendAs: "url" },
			]);
			expect(sendInSelect("audience")).toHaveTextContent("URL");
		});

		it("removes sendAs when Body is chosen, so the config is as if never set", () => {
			const spy = vi.fn();
			render(<Harness initial={IMPORTED} spy={spy} />);

			chooseSendIn("audience", "Body");

			const written = spy.mock.lastCall?.[0] as OAuth2ParamRow[];
			expect(written[0]).toEqual({ key: "audience", value: "api", enabled: true });
			expect("sendAs" in written[0]).toBe(false);
			expect(written[1].sendAs).toBe("header");
		});

		it("moves an imported row between URL and Header without touching its value", () => {
			const spy = vi.fn();
			render(<Harness initial={IMPORTED} spy={spy} />);

			chooseSendIn("audience", "Header");

			expect(spy.mock.lastCall?.[0]?.[0]).toEqual({
				key: "audience",
				value: "api",
				enabled: true,
				sendAs: "header",
			});
		});

		it("keeps the other rows' places when one row's place changes", () => {
			const spy = vi.fn();
			render(<Harness initial={IMPORTED} spy={spy} />);

			chooseSendIn("acr_values", "Body");

			expect(spy.mock.lastCall?.[0]?.[0].sendAs).toBe("url");
		});

		it("has none on the trailing spare row", () => {
			render(<Harness initial={IMPORTED} spy={vi.fn()} />);
			expect(screen.getAllByRole("combobox")).toHaveLength(IMPORTED.length);
			expect(keyInputs()).toHaveLength(IMPORTED.length + 1);
		});

		it("offers the select on the first typed row once it has a key", () => {
			render(<Harness initial={undefined} spy={vi.fn()} />);
			expect(screen.queryAllByRole("combobox")).toHaveLength(0);

			fireEvent.change(keyInputs()[0], { target: { value: "audience" } });

			expect(sendInSelect("audience")).toBeTruthy();
		});

		it("is off on an unticked row, as its fields are", () => {
			render(<Harness initial={[{ ...IMPORTED[0], enabled: false }]} spy={vi.fn()} />);
			expect(sendInSelect("audience")).toBeDisabled();
		});

		it("lists Body, URL and Header", () => {
			render(<Harness initial={IMPORTED} spy={vi.fn()} />);
			fireEvent.click(sendInSelect("audience"));
			const options = within(screen.getByRole("listbox")).getAllByRole("option");
			expect(options.map((o) => o.textContent)).toEqual(["Body", "URL", "Header"]);
		});

		it("is not offered unless the mount asks for it", () => {
			render(<Harness initial={IMPORTED} spy={vi.fn()} sendAs={false} />);
			expect(screen.queryAllByRole("combobox")).toHaveLength(0);
			expect(screen.queryByText("Send in")).toBeNull();
		});
	});
});
