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
 * `ModeElementForm`: the five kinds whose schema declares mutually exclusive
 * strategies as independent optional siblings. Three properties per kind
 * matter, and each case below asserts one of them:
 *
 *   - the mode on screen is the one the **engine** would resolve, including
 *     when a config carries two strategies at once (the priority cases);
 *   - switching modes leaves nothing of the other strategies in `config`
 *     (each schema declares `additionalProperties: false`, and the engine
 *     resolves by key presence, so a leftover is both unsavable and able to
 *     win over what the user can see);
 *   - the fields rendered are the active mode's own, with the schema's
 *     `title` / `description` / `x-vayu-unit` on them.
 *
 * The schemas here are trimmed transcriptions of the engine's, enough to
 * exercise the branch. That the *live* catalogue still declares these
 * properties - and that the table's detection order stays a permutation of
 * its modes - is `element-kinds.conformance.test.tsx`'s job, against the
 * generated fixture.
 */

import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ElementConfigSchema } from "@/types";
import { ModeElementForm } from "./ModeElementForm";
import { expectShowsError, expectShowsNoError } from "./field-error.testkit";
import { ELEMENT_MODES, detectMode, switchMode } from "./element-modes";

const ASSERT_STATUS: ElementConfigSchema = {
	type: "object",
	properties: {
		in: {
			type: "array",
			items: { type: "integer" },
			title: "Accepted codes",
			description: "A set of status codes the response must match one of.",
		},
		range: {
			type: "object",
			title: "Accepted range",
			description: "The response status must fall within this inclusive range.",
			properties: {
				min: { type: "integer", title: "Minimum" },
				max: { type: "integer", title: "Maximum" },
			},
			required: ["min", "max"],
		},
	},
};

const TIMER_THINK: ElementConfigSchema = {
	type: "object",
	properties: {
		ms: {
			type: "integer",
			title: "Wait",
			"x-vayu-unit": "ms",
			description: "A fixed wait, in milliseconds, before the next step.",
		},
		minMs: { type: "integer", title: "Minimum wait", "x-vayu-unit": "ms" },
		maxMs: { type: "integer", title: "Maximum wait", "x-vayu-unit": "ms" },
		gaussian: {
			type: "object",
			title: "Gaussian wait",
			description: "A randomly drawn wait following a normal distribution.",
			properties: {
				meanMs: { type: "number", title: "Mean", "x-vayu-unit": "ms" },
				deviationMs: { type: "number", title: "Standard deviation", "x-vayu-unit": "ms" },
			},
			required: ["meanMs", "deviationMs"],
		},
	},
};

const ASSERT_JSONPATH: ElementConfigSchema = {
	type: "object",
	properties: {
		path: { type: "string", title: "JSONPath" },
		expected: { title: "Expected value", description: "The exact value the match must equal." },
		regex: { type: "string", title: "Pattern" },
		exists: {
			type: "boolean",
			title: "Must exist",
			description:
				"true passes when at least one match is found, false when none is. Use it alone: it cannot be combined with 'expected' or 'regex'.",
		},
		negate: { type: "boolean", title: "Negate" },
	},
	required: ["path"],
};

const CONTROL_THROUGHPUT: ElementConfigSchema = {
	type: "object",
	properties: {
		percent: { type: "number", title: "Percent", "x-vayu-unit": "%" },
		everyN: { type: "integer", title: "Every Nth" },
		perUser: { type: "boolean", title: "Per user", default: true, "x-vayu-group": "advanced" },
	},
};

const METRIC_RECORD: ElementConfigSchema = {
	type: "object",
	properties: {
		name: { type: "string", title: "Metric name" },
		type: { type: "string", enum: ["trend", "counter", "rate"], title: "Type" },
		source: {
			type: "object",
			title: "Source",
			properties: {
				jsonpath: { type: "string", title: "JSONPath" },
				header: { type: "string", title: "Header name" },
				latency: {
					type: "boolean",
					title: "Latency",
					description: "Records the response's latency.",
				},
				status: { type: "boolean", title: "Status code" },
				size: { type: "boolean", title: "Body size" },
				condition: {
					type: "object",
					title: "Condition",
					properties: {
						field: { type: "string", enum: ["status", "header"], title: "Field" },
						operator: { type: "string", enum: ["eq", "ne"], title: "Operator" },
						value: { title: "Value" },
					},
					required: ["field", "operator", "value"],
				},
			},
		},
	},
	required: ["name", "type", "source"],
};

/**
 * The picker's chosen segment, by its `aria-checked` radio.
 *
 * `ToggleGroupItem` reserves its active-state width by rendering the label
 * twice, once visibly and once `aria-hidden` at the bold weight the active
 * state uses (`toggle-group.tsx`'s width-reservation comment) - `aria-hidden`
 * removes a node from the accessible name (and from what a sighted user
 * reads) but not from `textContent`, which walks every descendant text node
 * regardless. Reading `chosen.textContent` directly doubles the label; this
 * strips the hidden twin first; so it reads the one copy a user actually sees.
 */
function activeSegment(): string {
	const chosen = screen
		.getAllByRole("radio")
		.find((el) => el.getAttribute("aria-checked") === "true");
	if (!chosen) return "";
	const clone = chosen.cloneNode(true) as HTMLElement;
	clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
	return clone.textContent ?? "";
}

/**
 * The form under its own state, for the cases that assert what the *next*
 * render shows - a mode switch is only visible once the cleared config comes
 * back in.
 */
function Harness({
	kind,
	schema,
	initial,
}: {
	kind: string;
	schema: ElementConfigSchema;
	initial: Record<string, unknown>;
}) {
	const [config, setConfig] = useState(initial);
	return <ModeElementForm kind={kind} schema={schema} config={config} onChange={setConfig} />;
}

describe("ModeElementForm - the mode on screen is the one the engine resolves", () => {
	it("reads assert.status's mode from the key the config carries", () => {
		render(
			<ModeElementForm
				kind="assert.status"
				schema={ASSERT_STATUS}
				config={{ range: { min: 200, max: 299 } }}
				onChange={vi.fn()}
			/>
		);

		expect(activeSegment()).toBe("Range");
		expect(screen.getByLabelText("Minimum")).toBeInTheDocument();
		expect(screen.queryByText("Accepted codes")).not.toBeInTheDocument();
	});

	it("reads timer.think's uniform range from either bound alone", () => {
		// `config_.contains("minMs") || config_.contains("maxMs")` - one bound
		// is enough, the other defaults engine-side.
		render(
			<ModeElementForm
				kind="timer.think"
				schema={TIMER_THINK}
				config={{ maxMs: 400 }}
				onChange={vi.fn()}
			/>
		);

		expect(activeSegment()).toBe("Random range");
		expect(screen.getByLabelText("Minimum wait")).toBeInTheDocument();
	});

	/*
	 * The priority cases: a config carrying two strategies at once, where the
	 * engine's own detection order picks one. Each title names the engine code
	 * whose order the card has to agree with.
	 */
	const PRIORITY_CASES: {
		title: string;
		kind: string;
		schema: ElementConfigSchema;
		config: Record<string, unknown>;
		/** The mode the card shows, as its segment (or, for `select`, its dropdown) reads. */
		mode: string;
		picker?: "select";
		present: string[];
		/** Gone as a labelled field. */
		absentLabels?: string[];
		/** Gone as text anywhere in the card. */
		absentTexts?: string[];
	}[] = [
		{
			// The engine's `if (in) ... else if (range)` runs `in`, so the card
			// must not claim the range is what will happen.
			title: "prefers `in` over `range` when a config carries both, as AssertStatusElement::apply does",
			kind: "assert.status",
			schema: ASSERT_STATUS,
			config: { in: [200], range: { min: 500, max: 599 } },
			mode: "Set of codes",
			present: [],
			absentLabels: ["Minimum"],
		},
		{
			title: "prefers gaussian over a uniform range and a fixed wait, as resolve_own_wait_ms does",
			kind: "timer.think",
			schema: TIMER_THINK,
			config: { ms: 100, minMs: 10, maxMs: 20, gaussian: { meanMs: 50, deviationMs: 5 } },
			mode: "Gaussian",
			present: ["Mean"],
			absentLabels: ["Wait"],
		},
		{
			title: "prefers exists over expected and regex, as AssertJsonPathElement::apply does for a row stored before the engine refused the mix",
			kind: "assert.jsonpath",
			schema: ASSERT_JSONPATH,
			config: { path: "$.id", exists: true, expected: "7", regex: "\\d" },
			mode: "Exists",
			present: [],
			absentTexts: ["Expected value", "Pattern"],
		},
		{
			title: "prefers everyN over percent, as both ControlThroughputElement paths do",
			kind: "control.throughput",
			schema: CONTROL_THROUGHPUT,
			config: { everyN: 3, percent: 25 },
			mode: "Every nth",
			present: [],
			absentLabels: ["Percent"],
		},
		{
			// `header` comes before `latency` in the engine's fixed loop, so a
			// source carrying both records the header, not the latency.
			title: "prefers the earlier source key, as metric.record's source_kind loop does",
			kind: "metric.record",
			schema: METRIC_RECORD,
			config: { name: "tok", type: "trend", source: { header: "X-Cost", latency: true } },
			mode: "Header",
			picker: "select",
			present: ["Header name"],
		},
	];

	// A loop rather than `it.each`: `it.each`'s `$title` quotes and truncates
	// a long string, and the engine citation is at the end of each title.
	for (const c of PRIORITY_CASES) {
		it(c.title, () => {
			render(
				<ModeElementForm
					kind={c.kind}
					schema={c.schema}
					config={c.config}
					onChange={vi.fn()}
				/>
			);

			if (c.picker === "select") {
				expect(screen.getByRole("combobox", { name: "Source" })).toHaveTextContent(c.mode);
			} else {
				expect(activeSegment()).toBe(c.mode);
			}
			for (const label of c.present) expect(screen.getByLabelText(label)).toBeInTheDocument();
			for (const label of c.absentLabels ?? [])
				expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
			for (const text of c.absentTexts ?? [])
				expect(screen.queryByText(text)).not.toBeInTheDocument();
		});
	}

	// Mutation check: reverse any kind's `detectionOrder` in `element-modes.ts`
	// and its priority case above reds naming the mode the engine would not run.

	it("starts a blank element on the kind's default mode", () => {
		const { unmount } = render(
			<ModeElementForm
				kind="assert.status"
				schema={ASSERT_STATUS}
				config={{}}
				onChange={vi.fn()}
			/>
		);
		expect(activeSegment()).toBe("Set of codes");
		unmount();

		render(
			<ModeElementForm
				kind="timer.think"
				schema={TIMER_THINK}
				config={{}}
				onChange={vi.fn()}
			/>
		);
		// `ms` is the engine's *fallback*, not its first check - a blank
		// element still starts there, which is why the default is stated apart
		// from the detection order.
		expect(activeSegment()).toBe("Fixed");
	});
});

describe("ModeElementForm - switching modes clears the other strategies", () => {
	it("drops the abandoned mode's key rather than leaving it hidden in the config", () => {
		const onChange = vi.fn();
		render(
			<ModeElementForm
				kind="assert.status"
				schema={ASSERT_STATUS}
				config={{ in: [200, 201] }}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole("radio", { name: "Range" }));

		expect(onChange).toHaveBeenCalledWith({});
	});

	it("keeps the picker on a just-chosen mode that has no value yet", () => {
		render(<Harness kind="assert.status" schema={ASSERT_STATUS} initial={{ in: [200] }} />);

		fireEvent.click(screen.getByRole("radio", { name: "Range" }));

		expect(activeSegment()).toBe("Range");
		expect(screen.getByLabelText("Minimum")).toBeInTheDocument();
		expect(screen.queryByText("Accepted codes")).not.toBeInTheDocument();
	});

	it("starts the abandoned mode fresh when it is chosen again", () => {
		render(
			<Harness kind="assert.status" schema={ASSERT_STATUS} initial={{ in: [200, 201] }} />
		);

		fireEvent.click(screen.getByRole("radio", { name: "Range" }));
		fireEvent.click(screen.getByRole("radio", { name: "Set of codes" }));

		expect((screen.getByLabelText("Accepted codes") as HTMLInputElement).value).toBe("");
	});

	it("clears every other wait strategy at once, including a nested one", () => {
		const onChange = vi.fn();
		render(
			<ModeElementForm
				kind="timer.think"
				schema={TIMER_THINK}
				config={{ minMs: 10, maxMs: 20, gaussian: { meanMs: 5, deviationMs: 1 } }}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole("radio", { name: "Fixed" }));

		// Both bounds go with the mode they belong to, not just `minMs`.
		expect(onChange).toHaveBeenCalledWith({});
	});

	it("writes a marker mode's key, since the engine reads its presence and not its value", () => {
		const onChange = vi.fn();
		render(
			<ModeElementForm
				kind="assert.jsonpath"
				schema={ASSERT_JSONPATH}
				config={{ path: "$.id", expected: "7" }}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole("radio", { name: "Exists" }));

		expect(onChange).toHaveBeenCalledWith({ path: "$.id", exists: true });
	});

	it("clears only inside `source`, leaving the metric's own name and type alone", () => {
		const onChange = vi.fn();
		render(
			<ModeElementForm
				kind="metric.record"
				schema={METRIC_RECORD}
				config={{ name: "tok", type: "trend", source: { jsonpath: "$.n" } }}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole("combobox", { name: "Source" }));
		fireEvent.click(screen.getByRole("option", { name: "Latency" }));

		expect(onChange).toHaveBeenCalledWith({
			name: "tok",
			type: "trend",
			source: { latency: true },
		});
	});

	// Mutation check: make `switchMode` return `{ ...config }` unchanged - the
	// four clearing cases red, each naming the key left behind, while the
	// marker case still passes on its own write.
});

describe("ModeElementForm - the fields are the schema's own", () => {
	it("labels the active mode's field from its schema title, hint and unit", () => {
		render(
			<ModeElementForm
				kind="timer.think"
				schema={TIMER_THINK}
				config={{ ms: 500 }}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText("Wait")).toBeInTheDocument();
		expect(
			screen.getByText("A fixed wait, in milliseconds, before the next step.")
		).toBeInTheDocument();
		expect(screen.getByText("ms")).toBeInTheDocument();
	});

	it("pairs a nested mode's two fields on one line, at the card's density", () => {
		render(
			<ModeElementForm
				kind="timer.think"
				schema={TIMER_THINK}
				config={{ gaussian: { meanMs: 50, deviationMs: 5 } }}
				onChange={vi.fn()}
			/>
		);

		const line = document.querySelector('[data-setting-row="Mean"]')?.parentElement;
		expect(line?.className).toContain("grid-cols-2");
		expect(
			document.querySelector('[data-setting-row="Standard deviation"]')?.parentElement
		).toBe(line);
		expect(screen.getByLabelText("Mean").className).toContain("h-control-sm");
	});

	it("explains a marker mode from its schema description, having no field to carry it", () => {
		render(
			<ModeElementForm
				kind="assert.jsonpath"
				schema={ASSERT_JSONPATH}
				config={{ path: "$.id", exists: true }}
				onChange={vi.fn()}
			/>
		);

		expect(
			screen.getByText(
				"true passes when at least one match is found, false when none is. Use it alone: it cannot be combined with 'expected' or 'regex'."
			)
		).toBeInTheDocument();
		// No toggle: `negate` is the off switch for "must exist" (the engine
		// reads `exists: false` as "must be absent", which is that same
		// verdict), so a second control would say the same thing twice.
		expect(screen.queryByLabelText("Must exist")).not.toBeInTheDocument();
	});

	it("renders the mode's subject and its verdict flip whichever mode is active", () => {
		// `path` and `negate` belong to all three checks, so they are not modes
		// and do not come and go with one.
		render(
			<ModeElementForm
				kind="assert.jsonpath"
				schema={ASSERT_JSONPATH}
				config={{ path: "$.id", regex: "\\d+" }}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByLabelText("JSONPath")).toBeInTheDocument();
		expect(screen.getByText("Negate")).toBeInTheDocument();
		expect(screen.getByLabelText("Pattern")).toBeInTheDocument();
	});

	it("keeps a mode-independent advanced property under its own disclosure", () => {
		render(
			<ModeElementForm
				kind="control.throughput"
				schema={CONTROL_THROUGHPUT}
				config={{ percent: 25 }}
				onChange={vi.fn()}
			/>
		);

		expect(screen.queryByText("Per user")).not.toBeInTheDocument();
		fireEvent.click(screen.getByText("Advanced"));
		expect(screen.getByText("Per user")).toBeInTheDocument();
	});

	it("shows the trailing perUser toggle on by default, and a first click stores false", () => {
		// The catalogue's `default` rides the schema through `subsetSchema` into
		// the trailing generic form (#3045).
		const onChange = vi.fn();
		render(
			<ModeElementForm
				kind="control.throughput"
				schema={CONTROL_THROUGHPUT}
				config={{ percent: 25 }}
				onChange={onChange}
			/>
		);
		fireEvent.click(screen.getByText("Advanced"));

		const toggle = screen.getByRole("switch", { name: "Per user" });
		expect(toggle).toBeChecked();
		fireEvent.click(toggle);

		expect(onChange).toHaveBeenCalledWith({ percent: 25, perUser: false });
	});

	it("keeps a stored perUser false unchecked", () => {
		render(
			<ModeElementForm
				kind="control.throughput"
				schema={CONTROL_THROUGHPUT}
				config={{ percent: 25, perUser: false }}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByRole("switch", { name: "Per user" })).not.toBeChecked();
	});

	it("edits the active mode's field without disturbing the rest of the config", () => {
		const onChange = vi.fn();
		render(
			<ModeElementForm
				kind="assert.jsonpath"
				schema={ASSERT_JSONPATH}
				config={{ path: "$.id", negate: true, regex: "a" }}
				onChange={onChange}
			/>
		);

		fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: "ab" } });

		expect(onChange).toHaveBeenCalledWith({ path: "$.id", negate: true, regex: "ab" });
	});

	it("falls back to the generic form for a kind that is not in the table", () => {
		// The table is what routes a kind here, so this is a wiring mistake
		// rather than a user-facing state - it still has to be editable.
		render(
			<ModeElementForm
				kind="extract.json"
				schema={{ type: "object", properties: { path: { type: "string", title: "Path" } } }}
				config={{}}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByLabelText("Path")).toBeInTheDocument();
	});
});

describe("ModeElementForm - a message under the field it is about (#3048)", () => {
	// `errors` is the whole element's, by dot path from the top of `config`.
	it("shows a flat mode field's message", () => {
		render(
			<ModeElementForm
				kind="control.throughput"
				schema={CONTROL_THROUGHPUT}
				config={{ percent: 150 }}
				errors={{ percent: "Must be at most 100" }}
				onChange={vi.fn()}
			/>
		);

		expectShowsError(
			screen.getByRole("spinbutton", { name: "Percent" }),
			"Must be at most 100"
		);
	});

	it("shows a nested mode's message on its sub-field, not the sibling", () => {
		render(
			<ModeElementForm
				kind="assert.status"
				schema={ASSERT_STATUS}
				config={{ range: { min: 200 } }}
				errors={{ "range.max": "Can't be empty" }}
				onChange={vi.fn()}
			/>
		);

		expectShowsError(screen.getByRole("spinbutton", { name: "Maximum" }), "Can't be empty");
		expectShowsNoError(screen.getByRole("spinbutton", { name: "Minimum" }));
	});

	it("shows a message on a lead field above the picker", () => {
		render(
			<ModeElementForm
				kind="metric.record"
				schema={METRIC_RECORD}
				config={{ name: "", type: "trend", source: { jsonpath: "$.a" } }}
				errors={{ name: "Can't be empty" }}
				onChange={vi.fn()}
			/>
		);

		expectShowsError(screen.getByRole("textbox", { name: "Metric name" }), "Can't be empty");
	});

	it("shows a message on a field under the kind's source level", () => {
		render(
			<ModeElementForm
				kind="metric.record"
				schema={METRIC_RECORD}
				config={{ name: "m", type: "rate", source: { condition: { field: "status" } } }}
				errors={{ "source.condition.operator": "Can't be empty" }}
				onChange={vi.fn()}
			/>
		);

		expectShowsError(screen.getByRole("combobox", { name: "Operator" }), "Can't be empty");
		expectShowsNoError(screen.getByRole("combobox", { name: "Field" }));
		expect(screen.getAllByRole("alert")).toHaveLength(1);
	});

	it("shows a message on a lead field of a kind whose modes are top-level keys", () => {
		render(
			<ModeElementForm
				kind="assert.jsonpath"
				schema={ASSERT_JSONPATH}
				config={{ path: "", expected: 1 }}
				errors={{ path: "Can't be empty" }}
				onChange={vi.fn()}
			/>
		);

		expectShowsError(screen.getByRole("textbox", { name: "JSONPath" }), "Can't be empty");
	});

	it("shows nothing when the element has no message", () => {
		render(
			<ModeElementForm
				kind="control.throughput"
				schema={CONTROL_THROUGHPUT}
				config={{ percent: 50 }}
				errors={{}}
				onChange={vi.fn()}
			/>
		);

		expectShowsNoError(screen.getByRole("spinbutton", { name: "Percent" }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// Mutation checks: stop passing `errors` into `ModeFields` and the flat and
	// nested cases red; pass `errors` unsliced where the `source` level is read
	// and the condition case reds (`source.condition.operator` is never found
	// at the top of the level); drop the lead `errors` and those two red.
});

describe("element-modes - the table itself", () => {
	it("names a default mode that exists and is never a marker", () => {
		// A marker mode only becomes real when the picker is *used*, so a kind
		// defaulting to one would leave a fresh element showing a strategy its
		// config does not carry - and, for `metric.record`, unsavable.
		for (const [kind, spec] of Object.entries(ELEMENT_MODES)) {
			const mode = spec.modes.find((m) => m.id === spec.defaultMode);
			expect(mode, `${kind} defaults to a mode it does not declare`).toBeTruthy();
			expect(mode?.render, `${kind} defaults to a marker mode`).not.toBe("marker");
		}
	});

	it("detects nothing from a config with none of the strategies set", () => {
		expect(detectMode(ELEMENT_MODES["assert.status"], {})).toBeNull();
		expect(detectMode(ELEMENT_MODES["timer.think"], { unrelated: 1 })).toBeNull();
	});

	it("keeps the chosen mode's own value when it is switched to", () => {
		// Nothing is dropped that the switch makes *visible*: the range was
		// already there, ignored by the engine because `in` outranked it.
		expect(
			switchMode(
				ELEMENT_MODES["assert.status"],
				{ in: [200], range: { min: 1, max: 2 } },
				"range"
			)
		).toEqual({ range: { min: 1, max: 2 } });
	});
});
