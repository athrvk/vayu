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
 * `GenericElementForm` (issue #1608): the schema-driven form's labels,
 * hints, unit suffix, required-first ordering and Advanced disclosure - all
 * read from the property's own JSON Schema annotations (`title`,
 * `description`, `x-vayu-group`, `x-vayu-unit`), not the raw property key.
 *
 * `ElementList.test.tsx` already covers the fallback (a property with no
 * `title` still renders, keyed by its raw name) and the type-dispatch
 * branches (`ElementList.test.tsx`, the "generic form" describe block); this
 * file is the annotation-reading half issue #1607 added the schema for.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ElementConfigSchema } from "@/types";
import { GenericElementForm } from "./GenericElementForm";

function schema(
	properties: ElementConfigSchema["properties"],
	required?: string[]
): ElementConfigSchema {
	return { type: "object", properties, required };
}

describe("GenericElementForm - labels and hints", () => {
	it("labels a field from its schema title, with the description as a hint", () => {
		render(
			<GenericElementForm
				schema={schema({
					everyN: {
						type: "integer",
						title: "Every Nth",
						description: "Runs only every Nth occurrence.",
					},
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText("Every Nth")).toBeInTheDocument();
		expect(screen.getByText("Runs only every Nth occurrence.")).toBeInTheDocument();
	});

	it("falls back to the raw property key when the schema carries no title", () => {
		render(
			<GenericElementForm
				schema={schema({ path: { type: "string" } })}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText("path")).toBeInTheDocument();
	});
});

describe("GenericElementForm - x-vayu-unit", () => {
	it("renders the unit as the numeric field's suffix", () => {
		render(
			<GenericElementForm
				schema={schema({
					ms: { type: "integer", title: "Wait", "x-vayu-unit": "ms" },
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText("ms")).toBeInTheDocument();
	});
});

describe("GenericElementForm - required-first ordering", () => {
	it("renders a required property before an optional one, regardless of schema order", () => {
		render(
			<GenericElementForm
				schema={schema(
					{
						optionalFirst: { type: "string", title: "Optional first" },
						requiredSecond: { type: "string", title: "Required second" },
					},
					["requiredSecond"]
				)}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		const labels = screen
			.getAllByText(/^(Optional first|Required second)$/)
			.map((el) => el.textContent);
		expect(labels).toEqual(["Required second", "Optional first"]);
	});
});

describe("GenericElementForm - the Advanced disclosure", () => {
	function advancedSchema(): ElementConfigSchema {
		return schema({
			percent: { type: "number", title: "Percent" },
			perUser: { type: "boolean", title: "Per user", "x-vayu-group": "advanced" },
		});
	}

	it("keeps an x-vayu-group: advanced property out of the main list, under its own disclosure", () => {
		render(<GenericElementForm schema={advancedSchema()} config={{}} onChange={vi.fn()} />);

		expect(screen.getByText("Percent")).toBeInTheDocument();
		expect(screen.getByText("Advanced")).toBeInTheDocument();
	});

	it("starts closed for a fresh element with no value for the advanced property", () => {
		render(<GenericElementForm schema={advancedSchema()} config={{}} onChange={vi.fn()} />);

		expect(screen.queryByText("Per user")).not.toBeInTheDocument();
		fireEvent.click(screen.getByText("Advanced"));
		expect(screen.getByText("Per user")).toBeInTheDocument();
	});

	it("starts open when the element already carries a value for the advanced property", () => {
		render(
			<GenericElementForm
				schema={advancedSchema()}
				config={{ perUser: true }}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText("Per user")).toBeInTheDocument();
	});

	// Mutation check: replace `defaultOpen={advancedIsSet}` with `defaultOpen={false}`
	// in GenericElementForm.tsx - the case above reds, since "Per user" would
	// stay hidden behind the still-closed disclosure.
});

describe("GenericElementForm - two short fields share a line", () => {
	/**
	 * The row's own box, by the `data-setting-row` the settings primitives
	 * write from the same string they label the control with. Read rather than
	 * scanned: the grid class is on the element the form puts *around* two
	 * rows, which no source scan of a className string can see.
	 */
	function rowBox(label: string): HTMLElement {
		const box = document.querySelector<HTMLElement>(`[data-setting-row="${label}"]`);
		if (!box) throw new Error(`no row box named ${label}`);
		return box;
	}

	function lineOf(label: string): HTMLElement {
		const line = rowBox(label).parentElement;
		if (!line) throw new Error(`${label}'s row box has no parent`);
		return line;
	}

	it("pairs two adjacent numeric fields into one grid line", () => {
		render(
			<GenericElementForm
				schema={schema({
					min: { type: "integer", title: "Minimum" },
					max: { type: "integer", title: "Maximum" },
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(lineOf("Minimum").className).toContain("grid-cols-2");
		expect(lineOf("Maximum")).toBe(lineOf("Minimum"));
	});

	it("pairs two adjacent enum dropdowns too, not only numbers", () => {
		render(
			<GenericElementForm
				schema={schema({
					field: { type: "string", enum: ["body", "headers"], title: "Field" },
					scope: { type: "string", enum: ["env", "globals"], title: "Store in" },
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(lineOf("Field").className).toContain("grid-cols-2");
		expect(lineOf("Store in")).toBe(lineOf("Field"));
	});

	it("pairs a nested object's two children inside its fieldset", () => {
		// `assert.status`'s `range`, the shape the pairing was written for: one
		// idea ("200 to 299") that cost three stacked blocks to state.
		render(
			<GenericElementForm
				schema={schema({
					range: {
						type: "object",
						title: "Accepted range",
						properties: {
							min: { type: "integer", title: "Minimum" },
							max: { type: "integer", title: "Maximum" },
						},
					},
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(lineOf("Minimum").className).toContain("grid-cols-2");
		expect(lineOf("Minimum").closest("fieldset")).not.toBeNull();
	});

	it("leaves a number beside a free-text field stacked", () => {
		// A JSONPath has no length bound, so half a line for it is a worse
		// trade than the line it would save.
		render(
			<GenericElementForm
				schema={schema({
					path: { type: "string", title: "JSONPath" },
					matchNo: { type: "integer", title: "Which match" },
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(lineOf("Which match").className).not.toContain("grid-cols-2");
	});

	it("leaves a run of three short fields stacked rather than pairing by position", () => {
		// `timer.think`'s shape: a fixed wait beside the two bounds of a random
		// one. Pairing the first two would claim a relationship the schema
		// never declared - see `groupRows`.
		render(
			<GenericElementForm
				schema={schema({
					ms: { type: "integer", title: "Wait" },
					minMs: { type: "integer", title: "Minimum wait" },
					maxMs: { type: "integer", title: "Maximum wait" },
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		for (const label of ["Wait", "Minimum wait", "Maximum wait"]) {
			expect(lineOf(label).className).not.toContain("grid-cols-2");
		}
	});

	it("edits either half of a pair without dropping the other", () => {
		const onChange = vi.fn();
		render(
			<GenericElementForm
				schema={schema({
					min: { type: "integer", title: "Minimum" },
					max: { type: "integer", title: "Maximum" },
				})}
				config={{ min: 200 }}
				onChange={onChange}
			/>
		);

		fireEvent.change(screen.getByLabelText("Maximum"), { target: { value: "299" } });

		expect(onChange).toHaveBeenCalledWith({ min: 200, max: 299 });
	});

	it("renders the paired controls at the card's density, not the settings screen's", () => {
		// The pair only pays off if each half fills its column: the settings
		// screen's `max-w-[12rem]` input would leave one half of the line empty.
		render(
			<GenericElementForm
				schema={schema({
					min: { type: "integer", title: "Minimum" },
					max: { type: "integer", title: "Maximum" },
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		const input = screen.getByLabelText("Minimum");
		expect(input.className).toContain("h-8");
		expect(input.className).not.toContain("max-w-[12rem]");
	});

	// Mutation check: make `groupRows` return `names.map((name) => [name])` -
	// the three pairing cases red on the missing `grid-cols-2`, while the two
	// deliberately-stacked cases stay green, which is what tells the two rules
	// apart. Dropping `compact` from `PropertyRow`'s `NumberSettingRow` reds
	// the density case alone.
});
