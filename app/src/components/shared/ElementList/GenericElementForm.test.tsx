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

import { useState } from "react";
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
		expect(input.className).toContain("h-control-sm");
		expect(input.className).not.toContain("max-w-[12rem]");
	});

	// Mutation check: make `groupRows` return `names.map((name) => [name])` -
	// the three pairing cases red on the missing `grid-cols-2`, while the two
	// deliberately-stacked cases stay green, which is what tells the two rules
	// apart. Dropping `compact` from `PropertyRow`'s `NumberSettingRow` reds
	// the density case alone.
});

describe("GenericElementForm - a comma-separated list field (#3042)", () => {
	const integerList = schema({
		codes: { type: "array", title: "Codes", items: { type: "integer" } },
	});
	const stringList = schema({
		names: { type: "array", title: "Names", items: { type: "string" } },
	});

	/** The parent a real card is: it echoes each change back as the next `config`. */
	function Harness({
		formSchema,
		onChange,
	}: {
		formSchema: ElementConfigSchema;
		onChange: (config: Record<string, unknown>) => void;
	}) {
		const [config, setConfig] = useState<Record<string, unknown>>({});
		return (
			<GenericElementForm
				schema={formSchema}
				config={config}
				onChange={(next) => {
					onChange(next);
					setConfig(next);
				}}
			/>
		);
	}

	/**
	 * Types one character at a time, each appended to what the field shows
	 * right now - `user-event` is not a dependency, and the defect is in what
	 * a keystroke finds in the field, so the field's own value is the base.
	 * Returns the field's text after each keystroke.
	 */
	function typeCharByChar(field: HTMLElement, text: string): string[] {
		const input = field as HTMLInputElement;
		const shown: string[] = [];
		for (const char of text) {
			fireEvent.change(input, { target: { value: input.value + char } });
			shown.push(input.value);
		}
		return shown;
	}

	function lastConfig(onChange: ReturnType<typeof vi.fn>): unknown {
		return onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
	}

	it("never rewrites the typed text, and saves the parsed integers", () => {
		const onChange = vi.fn();
		render(<Harness formSchema={integerList} onChange={onChange} />);

		const shown = typeCharByChar(screen.getByLabelText("Codes"), "200, 201");

		// "200," must stay "200," - joining the saved [200] would show "200" and
		// fuse the next digit into "2002".
		expect(shown).toEqual(["2", "20", "200", "200,", "200, ", "200, 2", "200, 20", "200, 201"]);
		expect(lastConfig(onChange)).toEqual({ codes: [200, 201] });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it.each(["200.5", "abc"])("shows a hint for %s and does not save it", (typed) => {
		const onChange = vi.fn();
		render(<Harness formSchema={integerList} onChange={onChange} />);

		// One change event: typed char by char, "200" of "200.5" is a valid list
		// and rightly saved on the way.
		fireEvent.change(screen.getByLabelText("Codes"), { target: { value: typed } });

		expect(screen.getByRole("alert")).toHaveTextContent(`"${typed}" is not a whole number`);
		expect(screen.getByLabelText("Codes")).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByLabelText("Codes")).toHaveValue(typed);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps the last valid list saved while a later entry is invalid, and clears the hint once fixed", () => {
		const onChange = vi.fn();
		render(<Harness formSchema={integerList} onChange={onChange} />);
		const field = screen.getByLabelText("Codes");

		typeCharByChar(field, "200, abc");
		expect(lastConfig(onChange)).toEqual({ codes: [200] });
		expect(screen.getByRole("alert")).toHaveTextContent('"abc" is not a whole number');

		fireEvent.change(field, { target: { value: "200, 404" } });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(lastConfig(onChange)).toEqual({ codes: [200, 404] });
	});

	it("replaces the text when the stored value changes from outside, even over an invalid draft", () => {
		const view = render(
			<GenericElementForm schema={integerList} config={{ codes: [200] }} onChange={vi.fn()} />
		);
		fireEvent.change(screen.getByLabelText("Codes"), { target: { value: "200, abc" } });

		view.rerender(
			<GenericElementForm
				schema={integerList}
				config={{ codes: [301, 302] }}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByLabelText("Codes")).toHaveValue("301, 302");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("leaves the text alone when the value that comes back is what it already parses to", () => {
		const view = render(
			<GenericElementForm schema={integerList} config={{ codes: [200] }} onChange={vi.fn()} />
		);
		fireEvent.change(screen.getByLabelText("Codes"), { target: { value: "200,201" } });

		view.rerender(
			<GenericElementForm
				schema={integerList}
				config={{ codes: [200, 201] }}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByLabelText("Codes")).toHaveValue("200,201");
	});

	it("keeps a string list as trimmed strings, with no whole-number hint", () => {
		const onChange = vi.fn();
		render(<Harness formSchema={stringList} onChange={onChange} />);

		const shown = typeCharByChar(screen.getByLabelText("Names"), "a1, b.5");

		expect(shown[shown.length - 1]).toBe("a1, b.5");
		expect(lastConfig(onChange)).toEqual({ names: ["a1", "b.5"] });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// Mutation check: restore the old round trip - `value={stored.join(", ")}`
	// on the Input with `onChange` parsing every keystroke and dropping what
	// does not parse - and the first case reds on "200," showing "200", the
	// hint cases on the missing alert.
});

describe("GenericElementForm - an untyped property holds any JSON value (#3046)", () => {
	const untyped = schema({
		expected: { title: "Expected value", description: "The value the match must equal." },
		plain: { type: "string", title: "Plain" },
	});

	/** The parent a real card is: it echoes each change back as the next `config`. */
	function Harness({ initial, onChange }: { initial?: unknown; onChange: (v: unknown) => void }) {
		const [config, setConfig] = useState<Record<string, unknown>>(
			initial === undefined ? {} : { expected: initial }
		);
		return (
			<GenericElementForm
				schema={untyped}
				config={config}
				onChange={(next) => {
					onChange(next.expected);
					setConfig(next);
				}}
			/>
		);
	}

	function lastStored(onChange: ReturnType<typeof vi.fn>): unknown {
		return onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
	}

	it.each([
		{ typed: "7", stored: 7, kind: "number" },
		{ typed: "-1.5", stored: -1.5, kind: "number" },
		{ typed: "true", stored: true, kind: "boolean" },
		{ typed: "null", stored: null, kind: "null" },
		{ typed: "abc", stored: "abc", kind: "text" },
		{ typed: '"7"', stored: "7", kind: "text" },
		{ typed: '{"a":1}', stored: { a: 1 }, kind: "object" },
		{ typed: "[1,2]", stored: [1, 2], kind: "list" },
		{ typed: '{"a', stored: '{"a', kind: "text" },
		{ typed: "1e400", stored: "1e400", kind: "text" },
	])("stores $typed as $kind and says so", ({ typed, stored, kind }) => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);

		fireEvent.change(screen.getByLabelText("Expected value"), { target: { value: typed } });

		expect(lastStored(onChange)).toStrictEqual(stored);
		expect(screen.getByLabelText("Expected value")).toHaveValue(typed);
		expect(screen.getByText(`Stored as ${kind}`)).toBeInTheDocument();
	});

	it("stores an emptied field as the empty string, with no hint", () => {
		const onChange = vi.fn();
		render(<Harness initial={7} onChange={onChange} />);

		fireEvent.change(screen.getByLabelText("Expected value"), { target: { value: "" } });

		expect(lastStored(onChange)).toBe("");
		expect(screen.queryByText(/^Stored as/)).not.toBeInTheDocument();
	});

	it("keeps unfinished JSON as typed while it is saved as text on the way", () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		const input = screen.getByLabelText("Expected value") as HTMLInputElement;

		const shown: string[] = [];
		for (const char of '{"a":1}') {
			fireEvent.change(input, { target: { value: input.value + char } });
			shown.push(input.value);
		}

		expect(shown[shown.length - 1]).toBe('{"a":1}');
		expect(shown).toEqual(["{", '{"', '{"a', '{"a"', '{"a":', '{"a":1', '{"a":1}']);
		expect(lastStored(onChange)).toStrictEqual({ a: 1 });
	});

	it.each([
		{ title: "a number", loaded: 7, shown: "7" },
		{ title: "an object", loaded: { a: 1 }, shown: '{"a":1}' },
		{ title: "a list", loaded: [1, 2], shown: "[1,2]" },
		{ title: "null", loaded: null, shown: "null" },
		{ title: "a string that reads as a number, quoted", loaded: "7", shown: '"7"' },
		{
			title: "a string with quotes of its own, quoted again",
			loaded: '"a"',
			shown: '"\\"a\\""',
		},
		{ title: "plain text, as it is", loaded: "abc", shown: "abc" },
	])("shows $title as $shown, and an unrelated rerender writes nothing", ({ loaded, shown }) => {
		const onChange = vi.fn();
		const view = render(
			<GenericElementForm
				schema={untyped}
				config={{ expected: loaded }}
				onChange={onChange}
			/>
		);
		expect(screen.getByLabelText("Expected value")).toHaveValue(shown);

		view.rerender(
			<GenericElementForm
				schema={untyped}
				config={{ expected: loaded, other: 1 }}
				onChange={onChange}
			/>
		);

		expect(screen.getByLabelText("Expected value")).toHaveValue(shown);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("replaces the text when the value changes from outside, but not for its own write coming back", () => {
		const view = render(
			<GenericElementForm schema={untyped} config={{ expected: 7 }} onChange={vi.fn()} />
		);
		fireEvent.change(screen.getByLabelText("Expected value"), { target: { value: "7.0" } });

		view.rerender(
			<GenericElementForm schema={untyped} config={{ expected: 7 }} onChange={vi.fn()} />
		);
		expect(screen.getByLabelText("Expected value")).toHaveValue("7.0");

		view.rerender(
			<GenericElementForm schema={untyped} config={{ expected: "x" }} onChange={vi.fn()} />
		);
		expect(screen.getByLabelText("Expected value")).toHaveValue("x");
	});

	it("leaves a property that declares string as a plain text field", () => {
		const onChange = vi.fn();
		render(<GenericElementForm schema={untyped} config={{}} onChange={onChange} />);

		fireEvent.change(screen.getByLabelText("Plain"), { target: { value: "7" } });

		expect(onChange).toHaveBeenCalledWith({ plain: "7" });
		expect(screen.queryByText(/^Stored as/)).not.toBeInTheDocument();
	});

	// Mutation check: restore the string input for an untyped property
	// (`value={asString(value)}` and `onChange(e.target.value)`) and the "7"
	// case reds on the stored "7", the object and list cases on the empty field.
});
