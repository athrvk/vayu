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
 * The MCP tool fields write the stored tool and read it back (#3762). Monaco
 * does not run in jsdom, so the schema editor is a textarea here.
 */

import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { McpTool } from "@/types";
import McpToolFields from "./McpToolFields";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({
		value,
		onChange,
		ariaLabel,
	}: {
		value: string;
		onChange: (v: string) => void;
		ariaLabel: string;
	}) => (
		<textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
	),
}));

/**
 * The fields over a stored tool the way the panel holds one, with every write
 * recorded; `store` is what the round trip makes of a write before it is read
 * back.
 */
function Harness({
	initial,
	writes,
	requestId = "req_1",
	store = (next) => next,
}: {
	initial?: McpTool;
	writes: Array<McpTool | undefined>;
	requestId?: string;
	store?: (next: McpTool | undefined) => McpTool | undefined;
}) {
	const [tool, setTool] = useState<McpTool | undefined>(initial);
	return (
		<McpToolFields
			tool={tool}
			requestId={requestId}
			onToolChange={(next) => {
				writes.push(next);
				setTool(store(next));
			}}
		/>
	);
}

/** The same JSON value with every object's members in reverse order. */
function reversed(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reversed);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.reverse()
			.map(([key, member]) => [key, reversed(member)])
	);
}

function reversedMembers(tool: McpTool | undefined): McpTool | undefined {
	return tool && (reversed(tool) as McpTool);
}

const SCHEMA = '{"type":"object","properties":{"region":{"x-mcp-header":"Region"}}}';
const OUTPUT = '{"type":"object","properties":{"rows":{"type":"array"}}}';

function setName(value: string) {
	fireEvent.change(screen.getByLabelText("MCP tool"), { target: { value } });
}
function setSchema(value: string) {
	fireEvent.change(screen.getByLabelText("MCP tool input schema"), { target: { value } });
}
function setOutputSchema(value: string) {
	fireEvent.change(screen.getByLabelText("MCP tool output schema"), { target: { value } });
}

describe("McpToolFields", () => {
	it("stores a tool once it is named, then adds the schema to it", () => {
		const writes: Array<McpTool | undefined> = [];
		render(<Harness writes={writes} />);

		setName("execute_sql");
		setSchema(SCHEMA);

		expect(writes).toEqual([
			{ name: "execute_sql" },
			{ name: "execute_sql", inputSchema: JSON.parse(SCHEMA) },
		]);
	});

	it("shows a stored tool and keeps what was typed rather than re-indenting it", () => {
		const writes: Array<McpTool | undefined> = [];
		render(
			<Harness writes={writes} initial={{ name: "t", inputSchema: { type: "object" } }} />
		);

		expect(screen.getByLabelText("MCP tool")).toHaveValue("t");
		expect(
			JSON.parse(
				(screen.getByLabelText("MCP tool input schema") as HTMLTextAreaElement).value
			)
		).toEqual({ type: "object" });

		setSchema('{"type":"object","a":1}');
		expect(screen.getByLabelText("MCP tool input schema")).toHaveValue(
			'{"type":"object","a":1}'
		);
	});

	it("clears the stored tool when both fields are emptied", () => {
		const writes: Array<McpTool | undefined> = [];
		render(<Harness writes={writes} initial={{ name: "t" }} />);

		setName("");

		expect(writes).toEqual([undefined]);
	});

	it("keeps the stored tool while the schema is not valid JSON, and says so", () => {
		const writes: Array<McpTool | undefined> = [];
		render(<Harness writes={writes} initial={{ name: "t" }} />);

		setSchema('{"type":');

		expect(writes).toEqual([]);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"The input schema must be a JSON object."
		);
		expect(screen.getByLabelText("MCP tool input schema")).toHaveValue('{"type":');
	});

	it("stores no tool for a schema with no name, and says why", () => {
		const writes: Array<McpTool | undefined> = [];
		render(<Harness writes={writes} />);

		setSchema("{}");

		expect(writes).toEqual([]);
		expect(screen.getByRole("alert")).toHaveTextContent("Name the tool");
	});

	it("keeps what was typed when the stored schema comes back with its members reordered", () => {
		const writes: Array<McpTool | undefined> = [];
		render(<Harness writes={writes} store={reversedMembers} />);

		setName("execute_sql");
		setSchema(SCHEMA);
		const edited = '{"type":"object","properties":{"region":{"x-mcp-header":"Zone"}}}';
		setSchema(edited);

		expect(screen.getByLabelText("MCP tool input schema")).toHaveValue(edited);
		expect(writes).toEqual([
			{ name: "execute_sql" },
			{ name: "execute_sql", inputSchema: JSON.parse(SCHEMA) },
			{ name: "execute_sql", inputSchema: JSON.parse(edited) },
		]);
	});

	it("names the schema editor's group and describes it by the schema's error", () => {
		render(<Harness writes={[]} initial={{ name: "t" }} />);
		const group = screen.getByRole("group", { name: "Input schema" });
		expect(group).not.toHaveAttribute("aria-describedby");

		setSchema("[]");

		expect(group).toHaveAccessibleDescription("The input schema must be a JSON object.");
	});

	it("stores the output schema, and keeps it through an edit of the name or the input schema", () => {
		const writes: Array<McpTool | undefined> = [];
		render(<Harness writes={writes} initial={{ name: "t" }} />);

		setOutputSchema(OUTPUT);
		setName("t2");
		setSchema(SCHEMA);

		const output = JSON.parse(OUTPUT);
		expect(writes).toEqual([
			{ name: "t", outputSchema: output },
			{ name: "t2", outputSchema: output },
			{ name: "t2", inputSchema: JSON.parse(SCHEMA), outputSchema: output },
		]);
	});

	it("shows a stored output schema, and clears it when it is emptied", () => {
		const writes: Array<McpTool | undefined> = [];
		render(
			<Harness writes={writes} initial={{ name: "t", outputSchema: JSON.parse(OUTPUT) }} />
		);

		expect(
			JSON.parse(
				(screen.getByLabelText("MCP tool output schema") as HTMLTextAreaElement).value
			)
		).toEqual(JSON.parse(OUTPUT));

		setOutputSchema("");
		expect(writes).toEqual([{ name: "t" }]);
	});

	it("says what is wrong with an output schema that is not an object, on its own group", () => {
		const writes: Array<McpTool | undefined> = [];
		render(<Harness writes={writes} initial={{ name: "t" }} />);
		const group = screen.getByRole("group", { name: "Output schema" });

		setOutputSchema("[]");

		expect(writes).toEqual([]);
		expect(group).toHaveAccessibleDescription("The output schema must be a JSON object.");
		expect(screen.getByRole("group", { name: "Input schema" })).not.toHaveAttribute(
			"aria-describedby"
		);
	});

	it("takes a tool another writer stored", () => {
		const writes: Array<McpTool | undefined> = [];
		const { rerender } = render(
			<McpToolFields
				tool={undefined}
				requestId="req_1"
				onToolChange={(t) => writes.push(t)}
			/>
		);

		rerender(
			<McpToolFields
				tool={{ name: "from_agent" }}
				requestId="req_1"
				onToolChange={(t) => writes.push(t)}
			/>
		);

		expect(screen.getByLabelText("MCP tool")).toHaveValue("from_agent");
		expect(writes).toEqual([]);
	});
});
