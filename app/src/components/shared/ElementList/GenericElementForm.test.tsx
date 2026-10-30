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
import type { ElementConfigProperty, ElementConfigSchema } from "@/types";
import { GenericElementForm } from "./GenericElementForm";
import { expectShowsError, expectShowsNoError } from "./field-error.testkit";

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

describe("GenericElementForm - an object with no declared properties is a key/value editor (#3047)", () => {
	const switchSchema = schema(
		{
			variable: { type: "string", title: "Variable" },
			cases: {
				type: "object",
				title: "Cases",
				description: "Maps a value to the step to route to.",
			},
			default: { type: "string", title: "Default case" },
		},
		["variable", "cases"]
	);

	/** The parent a real card is: it echoes each change back as the next `config`. */
	function Harness({
		initial = {},
		onChange,
	}: {
		initial?: Record<string, unknown>;
		onChange: (config: Record<string, unknown>) => void;
	}) {
		const [config, setConfig] = useState<Record<string, unknown>>(initial);
		return (
			<GenericElementForm
				schema={switchSchema}
				config={config}
				onChange={(next) => {
					onChange(next);
					setConfig(next);
				}}
			/>
		);
	}

	function lastConfig(onChange: ReturnType<typeof vi.fn>): unknown {
		return onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
	}

	function type(label: string, text: string) {
		fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
	}

	function addEntry() {
		fireEvent.click(screen.getByRole("button", { name: "Add entry" }));
	}

	function keys(): string[] {
		return screen.getAllByLabelText(/^Key \d+$/).map((el) => (el as HTMLInputElement).value);
	}

	it("renders a labelled group with the description, and no text box for the object", () => {
		render(<Harness onChange={vi.fn()} />);

		expect(screen.getByRole("group", { name: "Cases" })).toBeInTheDocument();
		expect(screen.getByText("Maps a value to the step to route to.")).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Cases" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add entry" })).toBeInTheDocument();
	});

	it("writes the object a user builds by adding, renaming and removing entries", () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);

		addEntry();
		type("Key 1", "a");
		type("Value 1", "x");
		expect(lastConfig(onChange)).toEqual({ cases: { a: "x" } });

		type("Key 1", "b");
		expect(lastConfig(onChange)).toEqual({ cases: { b: "x" } });

		addEntry();
		type("Key 2", "c");
		type("Value 2", "y");
		expect(lastConfig(onChange)).toEqual({ cases: { b: "x", c: "y" } });

		fireEvent.click(screen.getByRole("button", { name: "Remove entry 1" }));
		expect(lastConfig(onChange)).toEqual({ cases: { c: "y" } });
		expect(keys()).toEqual(["c"]);
	});

	it("saves two cases and a default as the shape the engine validates", () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);

		type("Variable", "region");
		addEntry();
		type("Key 1", "a");
		type("Value 1", "x");
		addEntry();
		type("Key 2", "b");
		type("Value 2", "y");
		type("Default case", "z");

		expect(lastConfig(onChange)).toEqual({
			variable: "region",
			cases: { a: "x", b: "y" },
			default: "z",
		});
	});

	it("renders the rows of an object that is already stored", () => {
		render(<Harness initial={{ cases: { a: "x", b: "y" } }} onChange={vi.fn()} />);

		expect(keys()).toEqual(["a", "b"]);
		expect(screen.getByLabelText("Value 1")).toHaveValue("x");
		expect(screen.getByLabelText("Value 2")).toHaveValue("y");
	});

	it("shows no rows for a stored value that is not an object", () => {
		// The string the text box used to save (#3047) is not a map.
		render(<Harness initial={{ cases: "a=x" }} onChange={vi.fn()} />);

		expect(screen.queryByLabelText(/^Key \d+$/)).not.toBeInTheDocument();
	});

	it("keeps a blank or in-progress row on screen without writing it", () => {
		const onChange = vi.fn();
		render(<Harness initial={{ cases: { a: "x" } }} onChange={onChange} />);

		addEntry();
		type("Value 2", "orphan");

		expect(keys()).toEqual(["a", ""]);
		expect(screen.getByLabelText("Value 2")).toHaveValue("orphan");
		expect(onChange).not.toHaveBeenCalled();

		type("Key 2", "b");
		expect(lastConfig(onChange)).toEqual({ cases: { a: "x", b: "orphan" } });
	});

	it("drops an entry from the object when its key is cleared, keeping the row", () => {
		const onChange = vi.fn();
		render(<Harness initial={{ cases: { a: "x", b: "y" } }} onChange={onChange} />);

		type("Key 1", "");

		expect(lastConfig(onChange)).toEqual({ cases: { b: "y" } });
		expect(keys()).toEqual(["", "b"]);
	});

	it("lets the later row win when two rows share a key, and keeps both on screen", () => {
		const onChange = vi.fn();
		render(<Harness initial={{ cases: { a: "x", b: "y" } }} onChange={onChange} />);

		type("Key 2", "a");

		expect(lastConfig(onChange)).toEqual({ cases: { a: "y" } });
		expect(keys()).toEqual(["a", "a"]);
	});

	it("keeps a renamed row where it was, rather than moving it to the end", () => {
		render(<Harness initial={{ cases: { a: "x", b: "y" } }} onChange={vi.fn()} />);

		type("Key 1", "z");

		expect(keys()).toEqual(["z", "b"]);
		expect(screen.getByLabelText("Value 1")).toHaveValue("x");
	});

	it("replaces the rows when the stored object changes from outside", () => {
		const view = render(
			<GenericElementForm
				schema={switchSchema}
				config={{ cases: { a: "x" } }}
				onChange={vi.fn()}
			/>
		);
		addEntry();

		view.rerender(
			<GenericElementForm
				schema={switchSchema}
				config={{ cases: { p: "1", q: "2" } }}
				onChange={vi.fn()}
			/>
		);

		expect(keys()).toEqual(["p", "q"]);
	});

	it("never pairs the editor with a short neighbour on a grid line", () => {
		render(
			<GenericElementForm
				schema={schema({
					min: { type: "integer", title: "Minimum" },
					cases: { type: "object", title: "Cases" },
					max: { type: "integer", title: "Maximum" },
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		const group = screen.getByRole("group", { name: "Cases" });
		expect(group.parentElement?.className ?? "").not.toContain("grid-cols-2");
		expect(
			document.querySelector('[data-setting-row="Minimum"]')?.parentElement?.className
		).not.toContain("grid-cols-2");
	});

	// Mutation checks: delete the `property.type === "object"` branch in
	// `PropertyRow` and every case but the non-object one reds (the object falls
	// through to a text box). Reverse the rows in `recordFromRows` and the
	// duplicate-key case reds; write on every edit instead of only when the
	// record changes and the blank-row case reds; replace the rows on every
	// outside change and the key-cleared and duplicate cases red.
});

describe("GenericElementForm - a message under the field it is about (#3048)", () => {
	const CATALOGUE = schema({
		variable: { type: "string", title: "Variable name", description: "Where the value goes." },
		count: { type: "integer", title: "Repeat count" },
		scope: { type: "string", enum: ["env", "globals"], title: "Store in" },
		expected: { title: "Expected value" },
		range: {
			type: "object",
			title: "Accepted range",
			properties: {
				min: { type: "integer", title: "Minimum" },
				max: { type: "integer", title: "Maximum" },
			},
		},
	});

	function renderWith(errors: Record<string, string> | undefined) {
		render(
			<GenericElementForm schema={CATALOGUE} config={{}} errors={errors} onChange={vi.fn()} />
		);
	}

	it("shows a text field's message, links it to the field and marks the field invalid", () => {
		renderWith({ variable: "Can't be empty" });

		expectShowsError(screen.getByRole("textbox", { name: "Variable name" }), "Can't be empty");
	});

	it("keeps the text field's hint beside its message", () => {
		renderWith({ variable: "Can't be empty" });

		expect(screen.getByText("Where the value goes.")).toBeInTheDocument();
	});

	it("shows a number field's message", () => {
		renderWith({ count: "Must be at least 1" });

		expectShowsError(
			screen.getByRole("spinbutton", { name: "Repeat count" }),
			"Must be at least 1"
		);
	});

	it("shows a dropdown's message", () => {
		renderWith({ scope: "Can't be empty" });

		expectShowsError(screen.getByRole("combobox", { name: "Store in" }), "Can't be empty");
	});

	it("shows an untyped field's message", () => {
		renderWith({ expected: "Can't be empty" });

		expectShowsError(screen.getByRole("textbox", { name: "Expected value" }), "Can't be empty");
	});

	it("shows a nested field's message on that sub-field alone", () => {
		renderWith({ "range.max": "Can't be empty" });

		expectShowsError(screen.getByRole("spinbutton", { name: "Maximum" }), "Can't be empty");
		expectShowsNoError(screen.getByRole("spinbutton", { name: "Minimum" }));
		expect(screen.getAllByRole("alert")).toHaveLength(1);
	});

	it("shows nothing for fields without a message", () => {
		renderWith({});

		for (const control of screen.getAllByRole("textbox")) expectShowsNoError(control);
		for (const control of screen.getAllByRole("spinbutton")) expectShowsNoError(control);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows nothing without an errors prop", () => {
		renderWith(undefined);

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("clears the message when the errors no longer carry it", () => {
		const { rerender } = render(
			<GenericElementForm
				schema={CATALOGUE}
				config={{ variable: "" }}
				errors={{ variable: "Can't be empty" }}
				onChange={vi.fn()}
			/>
		);
		expect(screen.getByRole("alert")).toHaveTextContent("Can't be empty");

		rerender(
			<GenericElementForm
				schema={CATALOGUE}
				config={{ variable: "x" }}
				errors={{}}
				onChange={vi.fn()}
			/>
		);

		expectShowsNoError(screen.getByRole("textbox", { name: "Variable name" }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("names the message and the hint both for a number field that carries both", () => {
		render(
			<GenericElementForm
				schema={schema({
					count: {
						type: "integer",
						title: "Repeat count",
						description: "How many times.",
					},
				})}
				config={{}}
				errors={{ count: "Must be at least 1" }}
				onChange={vi.fn()}
			/>
		);

		const ids = (screen.getByRole("spinbutton").getAttribute("aria-describedby") ?? "").split(
			" "
		);
		expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
			"Must be at least 1",
			"How many times.",
		]);
	});

	// Mutation checks: stop passing `errors` into `PropertyRows` and every case
	// above but the no-message ones reds; drop `aria-invalid` from the text input
	// and its case reds on the attribute alone; slice the nested level with the
	// wrong key (`errorsWithin(errors, "min")`) and the nested case reds.
});

describe("GenericElementForm - an untouched field shows the catalogue default (#3045)", () => {
	const PACING = schema({
		everyMs: { type: "integer", title: "Cadence" },
		perUser: { type: "boolean", title: "Per user", default: true, "x-vayu-group": "advanced" },
	});

	function openAdvanced() {
		fireEvent.click(screen.getByText("Advanced"));
	}

	it("shows a comparison select the engine would run as its default, not the first option", () => {
		render(
			<GenericElementForm
				schema={schema({
					op: {
						type: "string",
						enum: ["lt", "lte", "gt", "gte", "eq"],
						default: "lte",
						title: "Comparison",
					},
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByRole("combobox", { name: "Comparison" })).toHaveTextContent("lte");
	});

	it("shows the stored value over the default, and the first option when there is no default", () => {
		const op: ElementConfigProperty = {
			type: "string",
			enum: ["lt", "lte"],
			title: "Comparison",
		};
		const { rerender } = render(
			<GenericElementForm
				schema={schema({ op: { ...op, default: "lte" } })}
				config={{ op: "lt" }}
				onChange={vi.fn()}
			/>
		);
		expect(screen.getByRole("combobox", { name: "Comparison" })).toHaveTextContent("lt");

		rerender(<GenericElementForm schema={schema({ op })} config={{}} onChange={vi.fn()} />);
		expect(screen.getByRole("combobox", { name: "Comparison" })).toHaveTextContent("lt");
	});

	it("treats an empty stored string as absent for a select, as before", () => {
		render(
			<GenericElementForm
				schema={schema({
					op: {
						type: "string",
						enum: ["lt", "lte"],
						default: "lte",
						title: "Comparison",
					},
				})}
				config={{ op: "" }}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByRole("combobox", { name: "Comparison" })).toHaveTextContent("lte");
	});

	it("shows a default-true toggle on for an absent key, and writes nothing on render", () => {
		const onChange = vi.fn();
		render(<GenericElementForm schema={PACING} config={{}} onChange={onChange} />);
		openAdvanced();

		expect(screen.getByRole("switch", { name: "Per user" })).toBeChecked();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("stores false on the first click of a default-true toggle", () => {
		const onChange = vi.fn();
		render(<GenericElementForm schema={PACING} config={{}} onChange={onChange} />);
		openAdvanced();

		fireEvent.click(screen.getByRole("switch", { name: "Per user" }));

		expect(onChange).toHaveBeenCalledWith({ perUser: false });
	});

	it("keeps a stored false unchecked although the default is true", () => {
		render(
			<GenericElementForm schema={PACING} config={{ perUser: false }} onChange={vi.fn()} />
		);

		expect(screen.getByRole("switch", { name: "Per user" })).not.toBeChecked();
	});

	it("shows a default-false toggle off for an absent key", () => {
		render(
			<GenericElementForm
				schema={schema({
					perUser: { type: "boolean", title: "Per user", default: false },
				})}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByRole("switch", { name: "Per user" })).not.toBeChecked();
	});

	// Mutation check: revert the toggle to `checked={value === true}` and the
	// default-true case reds; drop `asString(property.default)` from the select
	// and the comparison case reds (it falls back to `lt`).
});
