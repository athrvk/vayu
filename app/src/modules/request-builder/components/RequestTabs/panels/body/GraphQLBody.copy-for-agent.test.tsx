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
 * "Copy operation for agent" beside the Query pane's operation picker.
 *
 * An icon button: a landed copy swaps the glyph and raises no toast. The line
 * is the formatter the host hands in, so it names the operation and the request
 * and nothing the document holds - the query text and the variables draft carry
 * a sentinel that must stay off the clipboard. The operation is read from the
 * envelope's `operationName` rather than picked through the Select, because
 * Radix Select does not commit a value in jsdom (see
 * `GraphQLBody.operation-picker.test.tsx`); what is guarded is which operation
 * the button names and when the button exists.
 *
 * Mutation check: copy `parts.query` instead of the formatter's line and the
 * sentinel assertion reddens; drop the `operationReference &&` guard and the
 * unsaved-request case reddens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { graphqlOperationReference } from "@/lib/agent-reference";
import type { SchemaTarget } from "@/lib/graphql/schema-cache";
import { useToastStore } from "@/stores";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const { GraphQLBody } = await import("./GraphQLBody");

const SENTINEL = "s3cr3t-sentinel";
const TARGET = { url: "" } as unknown as SchemaTarget;
const REQUEST = { id: "req_1", name: "Create order" };

const operationReference = (name: string) => graphqlOperationReference({ name }, REQUEST);

function body(operationName?: string): string {
	return JSON.stringify({
		query: `query CreateOrder { order(token: "${SENTINEL}") { id } } query ListOrders { orders { id } }`,
		variables: { token: SENTINEL },
		...(operationName ? { operationName } : {}),
	});
}

function renderBody(
	text: string,
	props: { operationReference?: typeof operationReference } = { operationReference }
) {
	const element = (next: string, nextProps = props) => (
		<TooltipProvider>
			<GraphQLBody
				body={next}
				onBodyChange={() => {}}
				requestId="req_1"
				schemaTarget={TARGET}
				method="POST"
				variablesDraft={JSON.stringify({ token: SENTINEL })}
				onVariablesDraftChange={() => {}}
				{...nextProps}
			/>
		</TooltipProvider>
	);
	const view = render(element(text));
	return { rerenderWith: (next: string) => view.rerender(element(next)) };
}

const copyButton = () => screen.queryByRole("button", { name: "Copy operation for agent" });

/** The glyph a button shows now; `IconSwap` keeps the other one invisible beside it. */
function liveGlyph(button: HTMLElement): string {
	return button.querySelector(".enter-fade svg")?.getAttribute("class") ?? "";
}

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});
afterEach(cleanup);

describe("Copy operation for agent", () => {
	it("copies the chosen operation and its request, nothing the document holds", async () => {
		renderBody(body("CreateOrder"));
		fireEvent.click(copyButton()!);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(
			'Vayu graphql operation "CreateOrder" in request "Create order" (req_1)'
		);
		expect(writeText.mock.calls[0][0]).not.toContain(SENTINEL);
	});

	it("names whichever operation the envelope sends", async () => {
		const view = renderBody(body("CreateOrder"));
		view.rerenderWith(body("ListOrders"));
		fireEvent.click(copyButton()!);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).toContain('graphql operation "ListOrders"');
	});

	it("swaps the glyph to a check and raises no toast", async () => {
		renderBody(body("CreateOrder"));
		const button = copyButton()!;
		expect(liveGlyph(button)).toContain("lucide-copy");

		fireEvent.click(button);

		await waitFor(() => expect(liveGlyph(button)).toContain("lucide-check"));
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("is absent for an unsaved request, which has no formatter", () => {
		renderBody(body("CreateOrder"), { operationReference: undefined });
		expect(screen.getByLabelText("Operation")).toBeTruthy();
		expect(copyButton()).toBeNull();
	});

	it("is absent while no operation is set, though the picker shows", () => {
		renderBody(body());
		expect(screen.getByLabelText("Operation")).toBeTruthy();
		expect(copyButton()).toBeNull();
	});

	it("is absent when the envelope names an operation the document does not define", () => {
		renderBody(body("Gone"));
		expect(screen.getByLabelText("Operation")).toBeTruthy();
		expect(copyButton()).toBeNull();
	});

	it("is absent with the picker when the document defines one operation", () => {
		renderBody(
			JSON.stringify({
				query: "query CreateOrder { order { id } }",
				operationName: "CreateOrder",
			})
		);
		expect(screen.queryByLabelText("Operation")).toBeNull();
		expect(copyButton()).toBeNull();
	});
});
