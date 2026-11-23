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
 * The fields the engine resolves `{{name}}` / `{{data.column}}` in at run time
 * (#3779) are variable-aware inputs: `assert.contains`'s `text` outside
 * `matches` mode, and `assert.jsonpath`'s `expected`. The overlay the primitive
 * paints over a field that holds a token (`[data-variable-overlay]`) is the
 * witness: it is there for a resolved field and absent for a pattern field, a
 * kind the table does not name and a host with no variable scope.
 *
 * `variable-fields.ts` is the table; `GenericElementForm` consults it by `kind`,
 * `ModeElementForm` hands it down, `ElementList` passes the host's scope in.
 */

import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { variableSupportStub } from "@/test/variable-support";
import type { ElementConfigSchema, ElementDef, ElementKindSchema } from "@/types";
import { ElementList } from "./index";
import { GenericElementForm } from "./GenericElementForm";
import { ModeElementForm } from "./ModeElementForm";
import { resolvesVariables } from "./variable-fields";

const scope = variableSupportStub({ host: { value: "example.test", scope: "global" } });

const CONTAINS_SCHEMA: ElementConfigSchema = {
	type: "object",
	properties: {
		field: { type: "string", enum: ["body", "headers"], title: "Field" },
		mode: { type: "string", enum: ["contains", "equals", "matches"], title: "Mode" },
		text: {
			type: "string",
			title: "Text",
			description: "The text to look for, per the selected mode.",
		},
	},
	required: ["text"],
};

const JSONPATH_SCHEMA: ElementConfigSchema = {
	type: "object",
	properties: {
		path: { type: "string", title: "JSONPath" },
		expected: { title: "Expected value", description: "The exact value the match must equal." },
		regex: { type: "string", title: "Pattern" },
		exists: { type: "boolean", title: "Must exist" },
		negate: { type: "boolean", title: "Negate" },
	},
	required: ["path"],
};

const overlay = () => document.querySelector("[data-variable-overlay]");

describe("resolvesVariables - the table", () => {
	it.each([
		{ kind: "assert.contains", config: {}, name: "text", expected: true },
		{ kind: "assert.contains", config: { mode: "contains" }, name: "text", expected: true },
		{ kind: "assert.contains", config: { mode: "equals" }, name: "text", expected: true },
		{ kind: "assert.contains", config: { mode: "matches" }, name: "text", expected: false },
		{ kind: "assert.contains", config: {}, name: "field", expected: false },
		{ kind: "assert.jsonpath", config: {}, name: "expected", expected: true },
		{ kind: "assert.jsonpath", config: {}, name: "regex", expected: false },
		{ kind: "assert.jsonpath", config: {}, name: "path", expected: false },
		{ kind: "extract.json", config: {}, name: "text", expected: false },
	])("$kind $name with $config is $expected", ({ kind, config, name, expected }) => {
		expect(resolvesVariables(kind, name, config)).toBe(expected);
	});
});

describe("GenericElementForm - assert.contains text", () => {
	function renderContains(config: Record<string, unknown>, variables = scope) {
		return render(
			<GenericElementForm
				schema={CONTAINS_SCHEMA}
				kind="assert.contains"
				variables={variables}
				config={config}
				onChange={vi.fn()}
			/>
		);
	}

	it.each([
		{ title: "no mode (the schema default, contains)", config: {} },
		{ title: "contains", config: { mode: "contains" } },
		{ title: "equals", config: { mode: "equals" } },
	])("paints a token in $title mode", ({ config }) => {
		renderContains({ ...config, text: "{{host}} and {{data.email}}" });

		expect(overlay()?.textContent).toContain("{{data.email}}");
		expect(screen.getByRole("combobox", { name: "Text" })).toHaveValue(
			"{{host}} and {{data.email}}"
		);
	});

	it("is a plain field in matches mode, where the text is a pattern and never resolved", () => {
		renderContains({ mode: "matches", text: "^{{2}}$ {{data.email}}" });

		expect(overlay()).toBeNull();
		const field = screen.getByRole("textbox", { name: "Text" });
		expect(field).toHaveValue("^{{2}}$ {{data.email}}");
		expect(field).not.toHaveAttribute("role", "combobox");
	});

	it("follows the mode: the same field is variable-aware again when the mode leaves matches", () => {
		function Harness() {
			const [config, setConfig] = useState<Record<string, unknown>>({
				mode: "matches",
				text: "{{host}}",
			});
			return (
				<GenericElementForm
					schema={CONTAINS_SCHEMA}
					kind="assert.contains"
					variables={scope}
					config={config}
					onChange={setConfig}
				/>
			);
		}
		render(<Harness />);
		expect(overlay()).toBeNull();

		fireEvent.click(screen.getByRole("combobox", { name: "Mode" }));
		fireEvent.click(screen.getByRole("option", { name: "equals" }));

		expect(overlay()?.textContent).toContain("{{host}}");
	});

	it("writes what is typed as a string, as the plain field did", () => {
		const onChange = vi.fn();
		render(
			<GenericElementForm
				schema={CONTAINS_SCHEMA}
				kind="assert.contains"
				variables={scope}
				config={{}}
				onChange={onChange}
			/>
		);

		fireEvent.change(screen.getByRole("combobox", { name: "Text" }), {
			target: { value: "7 {{data.n}}" },
		});

		expect(onChange).toHaveBeenCalledWith({ text: "7 {{data.n}}" });
	});

	it("still shows the description under the label", () => {
		renderContains({ text: "x" });

		expect(
			screen.getByText("The text to look for, per the selected mode.")
		).toBeInTheDocument();
	});

	it("names the input by its label, not the primitive's placeholder", () => {
		renderContains({ text: "x" });

		expect(screen.getByLabelText("Text")).toBeInTheDocument();
		expect(screen.queryByLabelText("Value")).not.toBeInTheDocument();
	});

	it("is a plain field when the host has no variable scope", () => {
		render(
			<GenericElementForm
				schema={CONTAINS_SCHEMA}
				kind="assert.contains"
				config={{ text: "{{host}}" }}
				onChange={vi.fn()}
			/>
		);

		expect(overlay()).toBeNull();
		expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("{{host}}");
	});

	it("is a plain field for a kind the table does not name, with the same property name", () => {
		render(
			<GenericElementForm
				schema={CONTAINS_SCHEMA}
				kind="extract.json"
				variables={scope}
				config={{ text: "{{host}}" }}
				onChange={vi.fn()}
			/>
		);

		expect(overlay()).toBeNull();
	});

	it("shows an engine refusal on the field, tied to the real input", () => {
		render(
			<GenericElementForm
				schema={CONTAINS_SCHEMA}
				kind="assert.contains"
				variables={scope}
				config={{ text: "x" }}
				errors={{ text: "Can't be empty" }}
				onChange={vi.fn()}
			/>
		);

		const input = screen.getByRole("combobox", { name: "Text" });
		expect(input).toHaveAttribute("aria-invalid", "true");
		const alert = document.getElementById(input.getAttribute("aria-describedby") ?? "");
		expect(alert).toHaveAttribute("role", "alert");
		expect(alert?.textContent).toBe("Can't be empty");
		expect(input.parentElement?.className).toContain("border-destructive");
	});
});

describe("GenericElementForm - assert.jsonpath expected", () => {
	/** A card: it echoes each change back as the next `config`. */
	function Harness({ onStore, initial }: { onStore: (v: unknown) => void; initial?: unknown }) {
		const [config, setConfig] = useState<Record<string, unknown>>(
			initial === undefined ? {} : { expected: initial }
		);
		return (
			<GenericElementForm
				schema={JSONPATH_SCHEMA}
				kind="assert.jsonpath"
				variables={scope}
				config={config}
				onChange={(next) => {
					onStore(next.expected);
					setConfig(next);
				}}
			/>
		);
	}

	const lastStored = (fn: ReturnType<typeof vi.fn>) =>
		fn.mock.calls[fn.mock.calls.length - 1]?.[0];

	it("paints a token in a stored string and keeps the hint", () => {
		render(<Harness onStore={vi.fn()} initial="{{data.email}}" />);

		expect(overlay()?.textContent).toContain("{{data.email}}");
		expect(screen.getByLabelText("Expected value")).toHaveValue("{{data.email}}");
		expect(screen.getByText("The exact value the match must equal.")).toBeInTheDocument();
	});

	it.each([
		{ typed: "7", stored: 7, kind: "number" },
		{ typed: "true", stored: true, kind: "boolean" },
		{ typed: "null", stored: null, kind: "null" },
		{ typed: '"7"', stored: "7", kind: "text" },
		{ typed: "abc", stored: "abc", kind: "text" },
		{ typed: "{{data.n}}", stored: "{{data.n}}", kind: "text" },
		{ typed: '"{{data.n}}"', stored: "{{data.n}}", kind: "text" },
		{ typed: '{"id":"{{data.id}}"}', stored: { id: "{{data.id}}" }, kind: "object" },
		{ typed: '["{{host}}",2]', stored: ["{{host}}", 2], kind: "list" },
		{ typed: '{"a":"{{', stored: '{"a":"{{', kind: "text" },
	])("parses $typed as JSON: stored $kind", ({ typed, stored, kind }) => {
		const onStore = vi.fn();
		render(<Harness onStore={onStore} />);

		fireEvent.change(screen.getByLabelText("Expected value"), { target: { value: typed } });

		expect(lastStored(onStore)).toStrictEqual(stored);
		expect(screen.getByLabelText("Expected value")).toHaveValue(typed);
		expect(screen.getByText(`Stored as ${kind}`)).toBeInTheDocument();
	});

	it("shows a stored object as JSON text with its tokens painted", () => {
		render(<Harness onStore={vi.fn()} initial={{ id: "{{data.id}}" }} />);

		expect(screen.getByLabelText("Expected value")).toHaveValue('{"id":"{{data.id}}"}');
		expect(overlay()?.textContent).toContain("{{data.id}}");
	});

	it("leaves the regex field a plain input, since a pattern is never resolved", () => {
		render(
			<GenericElementForm
				schema={JSONPATH_SCHEMA}
				kind="assert.jsonpath"
				variables={scope}
				config={{ regex: "^{{data.id}}$" }}
				onChange={vi.fn()}
			/>
		);

		expect(overlay()).toBeNull();
		expect(screen.getByRole("textbox", { name: "Pattern" })).toHaveValue("^{{data.id}}$");
	});

	it("is the plain JSON field when the host has no variable scope", () => {
		render(
			<GenericElementForm
				schema={JSONPATH_SCHEMA}
				kind="assert.jsonpath"
				config={{ expected: "{{data.id}}" }}
				onChange={vi.fn()}
			/>
		);

		expect(overlay()).toBeNull();
		expect(screen.getByRole("textbox", { name: "Expected value" })).toHaveValue("{{data.id}}");
	});

	it("shows an engine refusal on the field, tied to the real input", () => {
		render(
			<GenericElementForm
				schema={JSONPATH_SCHEMA}
				kind="assert.jsonpath"
				variables={scope}
				config={{ expected: "x" }}
				errors={{ expected: "Refused" }}
				onChange={vi.fn()}
			/>
		);

		const input = screen.getByRole("combobox", { name: "Expected value" });
		expect(input).toHaveAttribute("aria-invalid", "true");
		const described = (input.getAttribute("aria-describedby") ?? "").split(" ");
		expect(described.map((id) => document.getElementById(id)?.textContent)).toContain(
			"Refused"
		);
		expect(input.parentElement?.className).toContain("border-destructive");
	});
});

describe("ModeElementForm - assert.jsonpath", () => {
	function renderMode(config: Record<string, unknown>, variables = scope) {
		return render(
			<ModeElementForm
				kind="assert.jsonpath"
				schema={JSONPATH_SCHEMA}
				config={config}
				variables={variables}
				onChange={vi.fn()}
			/>
		);
	}

	it("paints a token in the Equals mode's expected value", () => {
		renderMode({ path: "$.id", expected: "{{data.id}}" });

		expect(overlay()?.textContent).toContain("{{data.id}}");
		expect(screen.getByRole("combobox", { name: "Expected value" })).toBeInTheDocument();
	});

	it("keeps the Matches regex mode's pattern plain", () => {
		renderMode({ path: "$.id", regex: "^{{data.id}}$" });

		expect(overlay()).toBeNull();
		expect(screen.getByRole("textbox", { name: "Pattern" })).toHaveValue("^{{data.id}}$");
	});

	it("keeps the JSONPath lead field plain: only `expected` is resolved", () => {
		renderMode({ path: "$.{{data.key}}", regex: "x" });

		expect(overlay()).toBeNull();
	});

	it("is plain without a variable scope", () => {
		render(
			<ModeElementForm
				kind="assert.jsonpath"
				schema={JSONPATH_SCHEMA}
				config={{ path: "$.id", expected: "{{data.id}}" }}
				onChange={vi.fn()}
			/>
		);

		expect(overlay()).toBeNull();
	});
});

describe("ElementList passes the host's variable scope to the forms", () => {
	const kind = (name: string, configSchema: ElementConfigSchema): ElementKindSchema => ({
		kind: name,
		version: 1,
		label: name,
		description: `${name} description`,
		category: "assert",
		hotPathClass: "declarative",
		collectionOnly: false,
		configSchema,
		phases: [],
	});
	const kinds = [
		kind("assert.contains", CONTAINS_SCHEMA),
		kind("assert.jsonpath", JSONPATH_SCHEMA),
	];
	const elements: ElementDef[] = [
		{ id: "a", kind: "assert.contains", enabled: true, config: { text: "{{data.a}}" } },
		{
			id: "b",
			kind: "assert.jsonpath",
			enabled: true,
			config: { path: "$.id", expected: "{{data.b}}" },
		},
	];

	function renderList(variables?: typeof scope) {
		return render(
			<ElementList
				elements={elements}
				onChange={vi.fn()}
				kinds={kinds}
				variables={variables}
				openIds={new Set(["a", "b"])}
			/>
		);
	}

	it("makes the generic form's and the mode form's resolved fields variable-aware", () => {
		renderList(scope);

		const overlays = document.querySelectorAll("[data-variable-overlay]");
		expect([...overlays].map((o) => o.textContent)).toEqual(["{{data.a}}", "{{data.b}}"]);
	});

	it("leaves them plain without a scope", () => {
		renderList();

		expect(overlay()).toBeNull();
		expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("{{data.a}}");
	});
});
