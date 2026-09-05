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
 * #1437: a background refetch used to reseed this tab's draft unconditionally,
 * so an MCP agent editing the same collection while a script was mid-edit
 * silently threw the in-progress text away. This pins the fix's whole-value
 * side (a script is one buffer, unlike InfoTab's per-key `{name, description}`):
 * the draft survives, a conflict names it, and "Take theirs" is what adopts
 * the agent's version.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Collection } from "@/types";

const mutation = {
	mutateAsync: vi.fn(() => Promise.resolve()),
	mutate: vi.fn(),
	reset: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
}));

vi.mock("@/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks")>()),
	useDataContract: () => undefined,
	useVariableResolver: () => ({ getAllVariables: () => ({}) }),
}));

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
		<textarea
			data-testid="code-editor"
			aria-label="Script"
			value={value}
			onChange={(e) => onChange?.(e.target.value)}
		/>
	),
}));

const { default: ScriptTab } = await import("./ScriptTab");

function makeCollection(script: string): Collection {
	return {
		id: "c1",
		name: "Acme API",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: script,
		postRequestScript: script,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const editor = () => screen.getByTestId("code-editor") as HTMLTextAreaElement;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ScriptTab - a background script change while the draft is dirty (#1437)", () => {
	it("keeps the typed script and shows a conflict instead of overwriting it", () => {
		const { rerender } = render(
			<ScriptTab collection={makeCollection("original")} kind="pre" />
		);

		fireEvent.change(editor(), { target: { value: "typed by the user" } });

		rerender(<ScriptTab collection={makeCollection("written by an agent")} kind="pre" />);

		expect(editor().value).toBe("typed by the user");
		expect(screen.getByText("Changed elsewhere: the script")).toBeInTheDocument();
	});

	it("Take theirs adopts the agent's script and clears the conflict", () => {
		const { rerender } = render(
			<ScriptTab collection={makeCollection("original")} kind="pre" />
		);

		fireEvent.change(editor(), { target: { value: "typed by the user" } });
		rerender(<ScriptTab collection={makeCollection("written by an agent")} kind="pre" />);

		fireEvent.click(screen.getByRole("button", { name: /take theirs/i }));

		expect(editor().value).toBe("written by an agent");
		expect(screen.queryByText(/Changed elsewhere/)).not.toBeInTheDocument();
	});

	it("a clean tab still adopts a background change immediately, as before", () => {
		const { rerender } = render(
			<ScriptTab collection={makeCollection("original")} kind="pre" />
		);

		rerender(<ScriptTab collection={makeCollection("written by an agent")} kind="pre" />);

		expect(editor().value).toBe("written by an agent");
	});
});
