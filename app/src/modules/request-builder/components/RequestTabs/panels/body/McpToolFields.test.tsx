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

/** The fields over a stored tool the way the panel holds one, with every write recorded. */
function Harness({
	initial,
	writes,
	requestId = "req_1",
}: {
	initial?: McpTool;
	writes: Array<McpTool | undefined>;
	requestId?: string;
}) {
	const [tool, setTool] = useState<McpTool | undefined>(initial);
	return (
		<McpToolFields
			tool={tool}
			requestId={requestId}
			onToolChange={(next) => {
				writes.push(next);
				setTool(next);
			}}
		/>
	);
}

const SCHEMA = '{"type":"object","properties":{"region":{"x-mcp-header":"Region"}}}';

function setName(value: string) {
	fireEvent.change(screen.getByLabelText("MCP tool"), { target: { value } });
}
function setSchema(value: string) {
	fireEvent.change(screen.getByLabelText("MCP tool input schema"), { target: { value } });
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
