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
 * `JsonSchemaElementForm` (#3806): `assert.jsonschema`'s `path` exists only for
 * `source: jsonpath`, and the engine refuses one beside any other source, so a
 * switch back to the body must leave none in `config`; its `schema` is a
 * document, held in a multi-line field that round-trips what is typed.
 *
 * The schema here is a trimmed transcription of the engine's. That the live
 * catalogue still declares these properties is
 * `element-kinds.conformance.test.tsx`'s job.
 */

import { useState } from "react";
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ElementConfigSchema } from "@/types";
import { JsonSchemaElementForm } from "./JsonSchemaElementForm";

const SCHEMA: ElementConfigSchema = {
	type: "object",
	required: ["schema"],
	properties: {
		source: {
			type: "string",
			enum: ["body", "jsonpath"],
			default: "body",
			title: "Check",
			description: "What the schema judges.",
		},
		path: { type: "string", title: "JSONPath", description: "Locates the value." },
		schema: { title: "JSON Schema", description: "The schema the value must conform to." },
	},
};

const OUTPUT_SCHEMA = {
	type: "object",
	properties: { rows: { type: "array", items: { type: "integer" } } },
	required: ["rows"],
};

/** The form over a stored config the way the list holds one, every write recorded. */
function Harness({
	initial,
	writes,
	errors,
}: {
	initial: Record<string, unknown>;
	writes: Array<Record<string, unknown>>;
	errors?: Record<string, string>;
}) {
	const [config, setConfig] = useState(initial);
	return (
		<JsonSchemaElementForm
			id="el_1"
			kind="assert.jsonschema"
			description=""
			schema={SCHEMA}
			config={config}
			errors={errors}
			onChange={(next) => {
				writes.push(next);
				setConfig(next);
			}}
		/>
	);
}

function chooseSource(label: "body" | "jsonpath") {
	fireEvent.click(screen.getByRole("combobox", { name: "Check" }));
	fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("JsonSchemaElementForm", () => {
	it.each([
		["the default source", { schema: {} }],
		["the body source", { source: "body", schema: {} }],
	])("shows no path field for %s", (_name, initial) => {
		render(<Harness initial={initial} writes={[]} />);
		expect(screen.queryByLabelText("JSONPath")).not.toBeInTheDocument();
	});

	it("shows the path field for a JSONPath source, and writes the path typed there", () => {
		const writes: Array<Record<string, unknown>> = [];
		render(<Harness initial={{ source: "jsonpath", schema: {} }} writes={writes} />);

		fireEvent.change(screen.getByLabelText("JSONPath"), {
			target: { value: "$.result.structuredContent" },
		});

		expect(writes).toEqual([
			{ source: "jsonpath", schema: {}, path: "$.result.structuredContent" },
		]);
	});

	it("reveals the path field on choosing a JSONPath source", () => {
		const writes: Array<Record<string, unknown>> = [];
		render(<Harness initial={{ schema: {} }} writes={writes} />);

		chooseSource("jsonpath");

		expect(writes).toEqual([{ schema: {}, source: "jsonpath" }]);
		expect(screen.getByLabelText("JSONPath")).toBeInTheDocument();
	});

	it("takes the path out of config when the source goes back to the body", () => {
		const writes: Array<Record<string, unknown>> = [];
		render(
			<Harness
				initial={{ source: "jsonpath", path: "$.result", schema: { type: "object" } }}
				writes={writes}
			/>
		);

		chooseSource("body");

		expect(writes).toEqual([{ source: "body", schema: { type: "object" } }]);
		expect(writes[0]).not.toHaveProperty("path");
		expect(screen.queryByLabelText("JSONPath")).not.toBeInTheDocument();
	});

	it("shows the field's message under the path", () => {
		render(
			<Harness
				initial={{ source: "jsonpath", path: "foo", schema: {} }}
				writes={[]}
				errors={{ path: "Start with $" }}
			/>
		);
		expect(screen.getByLabelText("JSONPath")).toHaveAccessibleDescription(/Start with \$/);
	});

	describe("the schema field", () => {
		it("is a multi-line field, labelled and described from the catalogue", () => {
			render(<Harness initial={{ schema: OUTPUT_SCHEMA }} writes={[]} />);
			const field = screen.getByLabelText("JSON Schema");
			expect(field.tagName).toBe("TEXTAREA");
			expect(screen.getByText("The schema the value must conform to.")).toBeInTheDocument();
		});

		it("lays a stored schema out over lines, so a large one can be read", () => {
			render(<Harness initial={{ schema: OUTPUT_SCHEMA }} writes={[]} />);
			const text = (screen.getByLabelText("JSON Schema") as HTMLTextAreaElement).value;
			expect(text).toBe(JSON.stringify(OUTPUT_SCHEMA, null, 2));
			expect(text.split("\n").length).toBeGreaterThan(5);
		});

		it("stores the object a typed document spells, and keeps the typed layout", () => {
			const writes: Array<Record<string, unknown>> = [];
			render(<Harness initial={{ source: "body" }} writes={writes} />);
			const typed = '{\n  "type": "object",\n  "required": ["id"]\n}';

			fireEvent.change(screen.getByLabelText("JSON Schema"), { target: { value: typed } });

			expect(writes).toEqual([
				{ source: "body", schema: { type: "object", required: ["id"] } },
			]);
			expect(screen.getByLabelText("JSON Schema")).toHaveValue(typed);
		});

		it("stores true and false as booleans, which the engine takes as a schema", () => {
			const writes: Array<Record<string, unknown>> = [];
			render(<Harness initial={{}} writes={writes} />);

			fireEvent.change(screen.getByLabelText("JSON Schema"), { target: { value: "true" } });

			expect(writes).toEqual([{ schema: true }]);
		});

		it("keeps half-typed JSON as typed, stored as text until it reads", () => {
			const writes: Array<Record<string, unknown>> = [];
			render(<Harness initial={{ schema: {} }} writes={writes} />);

			fireEvent.change(screen.getByLabelText("JSON Schema"), {
				target: { value: '{"type":' },
			});

			expect(screen.getByLabelText("JSON Schema")).toHaveValue('{"type":');
			expect(writes).toEqual([{ schema: '{"type":' }]);
		});

		it("shows the message the list passes for it", () => {
			render(
				<Harness
					initial={{ schema: "{" }}
					writes={[]}
					errors={{ schema: "Can't be empty" }}
				/>
			);
			expect(screen.getByLabelText("JSON Schema")).toBeInvalid();
			expect(screen.getByLabelText("JSON Schema")).toHaveAccessibleDescription(
				/Can't be empty/
			);
		});
	});
});
