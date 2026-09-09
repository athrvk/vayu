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
