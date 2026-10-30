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
 * A value the kind's schema refuses is told to the user on the field that holds
 * it (#3048), through the real chain: `ElementRow` runs `validateElementConfig`
 * and hands the result to the generic form or the mode form, whichever the kind
 * routes to. The form tests cover each form given a message; this holds the row
 * to actually giving it one, for the values the issue names.
 *
 * The schemas are trimmed transcriptions of the live catalogue's (that it still
 * declares these constraints is `element-kinds.conformance.test.tsx`'s job).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ElementConfigSchema, ElementDef, ElementKindSchema } from "@/types";
import { elementNeeds, notRunReason } from "@/lib/elements";
import { ElementList } from "./index";
import { expectShowsError, expectShowsNoError } from "./field-error.testkit";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

function kind(name: string, configSchema: ElementConfigSchema): ElementKindSchema {
	return {
		kind: name,
		version: 1,
		label: name,
		description: `${name} description`,
		category: "test",
		hotPathClass: "declarative",
		collectionOnly: false,
		configSchema,
		phases: [],
	};
}

const JSON_PATH_MESSAGE = "Start with $, then use .name, ['name'], [n] or [*]";

const KINDS: ElementKindSchema[] = [
	kind("extract.json", {
		type: "object",
		properties: {
			path: { type: "string", title: "JSONPath" },
			variable: { type: "string", title: "Variable name", minLength: 1 },
		},
		required: ["variable"],
	}),
	kind("assert.jsonpath", {
		type: "object",
		properties: {
			path: { type: "string", title: "JSONPath" },
			exists: { type: "boolean", title: "Must exist" },
		},
		required: ["path"],
	}),
	kind("metric.record", {
		type: "object",
		properties: {
			name: { type: "string", title: "Metric name", minLength: 1 },
			source: {
				type: "object",
				title: "Source",
				properties: {
					jsonpath: { type: "string", title: "JSONPath" },
					condition: {
						type: "object",
						title: "Condition",
						properties: {
							field: {
								type: "string",
								title: "Field",
								enum: ["status", "jsonpath"],
							},
							jsonpath: { type: "string", title: "JSONPath" },
						},
					},
				},
			},
		},
		required: ["name", "source"],
	}),
	kind("timer.pacing", {
		type: "object",
		properties: { everyMs: { type: "integer", title: "Cadence", minimum: 1 } },
		required: ["everyMs"],
	}),
	kind("control.loop", {
		type: "object",
		properties: { count: { type: "integer", title: "Repeat count", minimum: 1 } },
		required: ["count"],
	}),
	kind("timer.throughput", {
		type: "object",
		properties: {
			targetPerMinute: { type: "number", title: "Target rate", exclusiveMinimum: 0 },
		},
		required: ["targetPerMinute"],
	}),
	kind("control.if", {
		type: "object",
		properties: {
			condition: {
				type: "string",
				title: "Condition",
				pattern: "^\\s*\\{\\{[^}]+\\}\\}\\s*(==|!=|matches)\\s*\\S.*$",
			},
		},
		required: ["condition"],
	}),
	kind("control.throughput", {
		type: "object",
		properties: {
			percent: { type: "number", title: "Percent", minimum: 0, maximum: 100 },
			everyN: { type: "integer", title: "Every Nth", minimum: 1 },
		},
	}),
	kind("assert.status", {
		type: "object",
		properties: {
			in: { type: "array", items: { type: "integer" }, title: "Accepted codes" },
			range: {
				type: "object",
				title: "Accepted range",
				properties: {
					min: { type: "integer", title: "Minimum" },
					max: { type: "integer", title: "Maximum" },
				},
				required: ["min", "max"],
			},
		},
	}),
];

function renderRow(elementKind: string, config: Record<string, unknown>, open: boolean) {
	const element: ElementDef = { id: "e1", kind: elementKind, enabled: true, config };
	render(
		<ElementList
			elements={[element]}
			onChange={vi.fn()}
			kinds={KINDS}
			openIds={new Set(open ? [element.id] : [])}
		/>
	);
	return element;
}

const renderOpen = (elementKind: string, config: Record<string, unknown>) =>
	renderRow(elementKind, config, true);

interface Case {
	name: string;
	kind: string;
	/** The accessible role and name of the field that holds the bad value. */
	field: { role: "textbox" | "spinbutton"; name: string };
	invalid: Record<string, unknown>;
	message: string;
	valid: Record<string, unknown>;
}

const CASES: Case[] = [
	{
		name: "a cleared required text field",
		kind: "extract.json",
		field: { role: "textbox", name: "Variable name" },
		invalid: { variable: "" },
		message: "Can't be empty",
		valid: { variable: "token" },
	},
	{
		name: "a Cadence of 0",
		kind: "timer.pacing",
		field: { role: "spinbutton", name: "Cadence" },
		invalid: { everyMs: 0 },
		message: "Must be at least 1",
		valid: { everyMs: 1000 },
	},
	{
		name: "a Repeat count of 0",
		kind: "control.loop",
		field: { role: "spinbutton", name: "Repeat count" },
		invalid: { count: 0 },
		message: "Must be at least 1",
		valid: { count: 3 },
	},
	{
		name: "a Target rate of 0",
		kind: "timer.throughput",
		field: { role: "spinbutton", name: "Target rate" },
		invalid: { targetPerMinute: 0 },
		message: "Must be greater than 0",
		valid: { targetPerMinute: 60 },
	},
	{
		name: "a malformed If condition",
		kind: "control.if",
		field: { role: "textbox", name: "Condition" },
		invalid: { condition: "status == 200" },
		message: "Use {{var}} == value",
		valid: { condition: "{{env}} == prod" },
	},
	{
		name: "a Percent of 150",
		kind: "control.throughput",
		field: { role: "spinbutton", name: "Percent" },
		invalid: { percent: 150 },
		message: "Must be at most 100",
		valid: { percent: 50 },
	},
	{
		name: "a status range with only a minimum",
		kind: "assert.status",
		field: { role: "spinbutton", name: "Maximum" },
		invalid: { range: { min: 200 } },
		message: "Can't be empty",
		valid: { range: { min: 200, max: 299 } },
	},
	{
		name: "a malformed extractor JSONPath",
		kind: "extract.json",
		field: { role: "textbox", name: "JSONPath" },
		invalid: { variable: "token", path: "data.id" },
		message: JSON_PATH_MESSAGE,
		valid: { variable: "token", path: "$.data.id" },
	},
	{
		name: "a malformed assertion JSONPath",
		kind: "assert.jsonpath",
		field: { role: "textbox", name: "JSONPath" },
		invalid: { path: "$.items[?(@.a==1)]", exists: true },
		message: JSON_PATH_MESSAGE,
		valid: { path: "$.items[*].id", exists: true },
	},
	{
		name: "a malformed metric source JSONPath",
		kind: "metric.record",
		field: { role: "textbox", name: "JSONPath" },
		invalid: { name: "m", source: { jsonpath: "$." } },
		message: JSON_PATH_MESSAGE,
		valid: { name: "m", source: { jsonpath: "$.total" } },
	},
	{
		name: "a malformed metric condition JSONPath",
		kind: "metric.record",
		field: { role: "textbox", name: "JSONPath" },
		invalid: { name: "m", source: { condition: { field: "jsonpath", jsonpath: "total" } } },
		message: JSON_PATH_MESSAGE,
		valid: { name: "m", source: { condition: { field: "jsonpath", jsonpath: "$.total" } } },
	},
];

describe("ElementList - a refused value is told on its field (#3048)", () => {
	it.each(CASES)("$name shows its message on the field", (c) => {
		renderOpen(c.kind, c.invalid);

		expectShowsError(screen.getByRole(c.field.role, { name: c.field.name }), c.message);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
	});

	it.each(CASES)("$name, once valid, shows no message", (c) => {
		renderOpen(c.kind, c.valid);

		expectShowsNoError(screen.getByRole(c.field.role, { name: c.field.name }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("says nothing on a fresh element, whose absent fields the Needs chip covers", () => {
		renderOpen("timer.pacing", {});

		expectShowsNoError(screen.getByRole("spinbutton", { name: "Cadence" }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.getByText("Needs Cadence")).toBeInTheDocument();
	});

	// Mutation check: stop passing `errors={fieldErrors}` to the generic form in
	// `ElementRow` and every case above except the mode kinds (Percent, the
	// range) reds; stop passing it to the bespoke form and those two red.
});

describe("ElementList - the row marks what Send leaves out (#3066)", () => {
	const markOf = () => document.querySelector("[data-element-incomplete]");

	it("marks a collapsed row whose value is refused, with the field and its message", () => {
		renderRow("control.loop", { count: 0 }, false);

		expect(markOf()).toHaveTextContent("count: Must be at least 1");
	});

	it("marks an open row the same way", () => {
		renderRow("control.loop", { count: 0 }, true);

		expect(markOf()).toHaveTextContent("count: Must be at least 1");
	});

	it("keeps the Needs label for a missing key", () => {
		renderRow("timer.pacing", {}, false);

		expect(markOf()).toHaveTextContent(/^Needs Cadence$/);
	});

	it("shows no mark, and the summary, for an element that passes", () => {
		renderRow("control.loop", { count: 3 }, false);

		expect(markOf()).toBeNull();
		expect(screen.getByText("count: 3")).toBeInTheDocument();
	});

	it.each([
		["a missing key", "timer.pacing", {}],
		["a refused value", "control.loop", { count: 0 }],
		["both", "extract.json", { variable: "" }],
	])("says what the response's Not run line says for %s", (_name, elementKind, config) => {
		const element = renderRow(elementKind, config, false);
		const needs = elementNeeds(element, KINDS);

		expect(needs).not.toBeNull();
		const reason = notRunReason(needs!);
		const mark = markOf()?.textContent ?? "";
		expect(reason.startsWith("Not run - ")).toBe(true);
		expect(mark.toLowerCase()).toBe(reason.slice("Not run - ".length).toLowerCase());
	});
});
