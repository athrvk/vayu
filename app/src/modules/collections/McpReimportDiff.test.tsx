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
 * The re-import report's per-row selection (#3994): added and changed rows start ticked, removed
 * rows never do, and a tick is reported as a new selection, not applied in place. The writes the
 * ticks lead to are the dialog's (`ImportModal.mcp.test.tsx`).
 */

import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { McpReimportDiff } from "./McpReimportDiff";
import { buildMcpSelect, defaultMcpSelection, type McpSelection } from "./mcp-reimport-selection";
import type { ImportMcpDiffMatch } from "@/types";

const MATCH: ImportMcpDiffMatch = {
	collectionId: "col_1",
	name: "Acme tools",
	identical: false,
	added: [{ kind: "tool", key: "export", name: "export" }],
	removed: [{ kind: "resource", key: "file:///a.txt", name: "a.txt", requestId: "req_9" }],
	changed: [
		{
			kind: "tool",
			key: "find",
			name: "search",
			requestId: "req_1",
			fields: [],
			renamedFrom: "search",
		},
		{
			kind: "prompt",
			key: "greet",
			name: "greet",
			requestId: "req_2",
			fields: ["description"],
		},
	],
};

const SECOND: ImportMcpDiffMatch = {
	...MATCH,
	collectionId: "col_2",
	name: "Acme tools copy",
	added: [{ kind: "prompt", key: "hello", name: "hello" }],
	changed: [],
	removed: [],
};

/** Holds the ticks the way the dialog does, and reports each change it is given. */
function Harness({
	matches,
	onChange,
	onUpdate,
	disabled,
}: {
	matches: ImportMcpDiffMatch[];
	onChange?: (collectionId: string, next: McpSelection) => void;
	onUpdate?: (collectionId: string) => void;
	disabled?: boolean;
}) {
	const [selections, setSelections] = useState<Record<string, McpSelection>>({});
	return (
		<McpReimportDiff
			matches={matches}
			selectionFor={(match) => selections[match.collectionId] ?? defaultMcpSelection(match)}
			onSelectionChange={(id, next) => {
				setSelections((current) => ({ ...current, [id]: next }));
				onChange?.(id, next);
			}}
			{...(disabled ? { disabled } : {})}
			{...(onUpdate ? { onUpdate } : {})}
		/>
	);
}

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("McpReimportDiff selection", () => {
	it("starts with every added and changed row ticked, and the removed one not", () => {
		render(<Harness matches={[MATCH]} />);

		expect(box("export (tool)").checked).toBe(true);
		expect(box("search → find (tool)").checked).toBe(true);
		expect(box("greet (prompt)").checked).toBe(true);
		expect(box("a.txt (resource)").checked).toBe(false);
	});

	it("says what a tick does in each group, and that a removal is opt-in", () => {
		render(<Harness matches={[MATCH]} />);

		expect(screen.getByText(/Ticked ones become requests/)).toBeInTheDocument();
		expect(screen.getByText(/Ticked ones are updated in place/)).toBeInTheDocument();
		expect(
			screen.getByText(
				"Unticked by default - deleting a request takes everything saved on it."
			)
		).toBeInTheDocument();
	});

	it("gives each box the size of a hit target", () => {
		render(<Harness matches={[MATCH]} />);

		for (const checkbox of screen.getAllByRole("checkbox")) {
			expect(checkbox.className.split(/\s+/)).toContain("size-target");
		}
	});

	it("reports a toggle as a new selection that carries every other tick over", () => {
		const onChange = vi.fn();
		render(<Harness matches={[MATCH]} onChange={onChange} />);

		fireEvent.click(box("export (tool)"));
		fireEvent.click(box("a.txt (resource)"));

		expect(box("export (tool)").checked).toBe(false);
		expect(box("a.txt (resource)").checked).toBe(true);
		const last = onChange.mock.calls[onChange.mock.calls.length - 1] as [string, McpSelection];
		expect(last[0]).toBe("col_1");
		expect(buildMcpSelect(MATCH, last[1])).toEqual({
			added: [],
			changed: ["req_1", "req_2"],
			removed: ["req_9"],
		});
	});

	it("moves one match's ticks and leaves the other's", () => {
		render(<Harness matches={[MATCH, SECOND]} />);

		const first = within(screen.getByRole("group", { name: "Acme tools" }));
		fireEvent.click(first.getByRole("checkbox", { name: "export (tool)" }));

		const second = within(screen.getByRole("group", { name: "Acme tools copy" }));
		expect(
			(first.getByRole("checkbox", { name: "export (tool)" }) as HTMLInputElement).checked
		).toBe(false);
		expect(
			(second.getByRole("checkbox", { name: "hello (prompt)" }) as HTMLInputElement).checked
		).toBe(true);
	});

	it("leaves every box untouchable while an update is being written", () => {
		render(<Harness matches={[MATCH]} disabled />);

		for (const checkbox of screen.getAllByRole("checkbox")) {
			expect((checkbox as HTMLInputElement).disabled).toBe(true);
		}
	});

	it("draws no box for a match that does not differ", () => {
		render(
			<Harness
				matches={[{ ...MATCH, identical: true, added: [], changed: [], removed: [] }]}
			/>
		);

		expect(screen.queryAllByRole("checkbox")).toEqual([]);
	});
});

describe("McpReimportDiff's own action", () => {
	it("is absent unless the dialog asks for one, which its footer's button does otherwise", () => {
		render(<Harness matches={[MATCH]} />);

		expect(screen.queryByRole("button", { name: "Update existing" })).toBeNull();
	});

	it("updates the collection it sits under", () => {
		const onUpdate = vi.fn();
		render(<Harness matches={[MATCH, SECOND]} onUpdate={onUpdate} />);

		const second = within(screen.getByRole("group", { name: "Acme tools copy" }));
		fireEvent.click(second.getByRole("button", { name: "Update existing" }));

		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(onUpdate).toHaveBeenCalledWith("col_2");
	});

	it("is off once nothing is ticked, and while an update is being written", () => {
		const { rerender } = render(<Harness matches={[SECOND]} onUpdate={vi.fn()} />);
		const button = () =>
			screen.getByRole("button", { name: "Update existing" }) as HTMLButtonElement;
		expect(button().disabled).toBe(false);

		fireEvent.click(box("hello (prompt)"));
		expect(button().disabled).toBe(true);

		fireEvent.click(box("hello (prompt)"));
		expect(button().disabled).toBe(false);
		rerender(<Harness matches={[SECOND]} onUpdate={vi.fn()} disabled />);
		expect(button().disabled).toBe(true);
	});
});
