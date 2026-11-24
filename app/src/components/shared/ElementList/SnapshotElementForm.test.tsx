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
 * `SnapshotElementForm` (#3807): `baseline` is an array of objects the generic
 * array field cannot hold, so it is a multi-line JSON field that stores what
 * parses (and typed text that does not, as a string, for `OPERAND_RULES` to
 * hold back). `method` stays the catalogue's select.
 *
 * The schema is a trimmed transcription of the engine's; that the live
 * catalogue still declares these properties is
 * `element-kinds.conformance.test.tsx`'s job.
 */

import { useState } from "react";
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ElementConfigSchema } from "@/types";
import { SnapshotElementForm } from "./SnapshotElementForm";

const SCHEMA: ElementConfigSchema = {
	type: "object",
	required: ["baseline"],
	properties: {
		method: {
			type: "string",
			enum: ["tools/list", "resources/list", "prompts/list"],
			default: "tools/list",
			title: "List",
		},
		baseline: { type: "array", title: "Baseline", description: "The recorded items." },
	},
};

const TOOLS = [{ name: "search", inputSchema: { type: "object" } }];

function Harness({
	initial,
	writes,
}: {
	initial: Record<string, unknown>;
	writes: Array<Record<string, unknown>>;
}) {
	const [config, setConfig] = useState(initial);
	return (
		<>
			<SnapshotElementForm
				id="el_1"
				kind="assert.snapshot"
				description=""
				schema={SCHEMA}
				config={config}
				onChange={(next) => {
					writes.push(next);
					setConfig(next);
				}}
			/>
			<button onClick={() => setConfig({ ...config, baseline: [{ name: "external" }] })}>
				replace from outside
			</button>
		</>
	);
}

describe("SnapshotElementForm", () => {
	it("shows a stored baseline as indented JSON under its catalogue title", () => {
		render(<Harness initial={{ baseline: TOOLS }} writes={[]} />);

		const field = screen.getByRole("textbox", { name: "Baseline" }) as HTMLTextAreaElement;
		expect(JSON.parse(field.value)).toEqual(TOOLS);
		expect(field.value).toContain("\n");
	});

	// Mutation check: write `value` as the text instead of the parsed value in
	// the form's `onChange` and the stored baseline is a string, not the array.
	it("stores typed JSON as the array it spells", () => {
		const writes: Array<Record<string, unknown>> = [];
		render(<Harness initial={{ method: "tools/list" }} writes={writes} />);

		fireEvent.change(screen.getByRole("textbox", { name: "Baseline" }), {
			target: { value: JSON.stringify(TOOLS) },
		});

		expect(writes[writes.length - 1]).toEqual({ method: "tools/list", baseline: TOOLS });
	});

	it("stores unfinished text as a string, which is what the save gate refuses", () => {
		const writes: Array<Record<string, unknown>> = [];
		render(<Harness initial={{}} writes={writes} />);

		fireEvent.change(screen.getByRole("textbox", { name: "Baseline" }), {
			target: { value: '[{"name":' },
		});

		expect(writes[writes.length - 1]).toEqual({ baseline: '[{"name":' });
	});

	it("follows a baseline written from outside, as the recording action does", () => {
		render(<Harness initial={{ baseline: TOOLS }} writes={[]} />);

		fireEvent.click(screen.getByRole("button", { name: "replace from outside" }));

		const field = screen.getByRole("textbox", { name: "Baseline" }) as HTMLTextAreaElement;
		expect(JSON.parse(field.value)).toEqual([{ name: "external" }]);
	});

	it("keeps the baseline when the method changes", () => {
		const writes: Array<Record<string, unknown>> = [];
		render(<Harness initial={{ baseline: TOOLS }} writes={writes} />);

		fireEvent.click(screen.getByRole("combobox", { name: "List" }));
		fireEvent.click(screen.getByRole("option", { name: "prompts/list" }));

		expect(writes[writes.length - 1]).toEqual({ method: "prompts/list", baseline: TOOLS });
	});
});
