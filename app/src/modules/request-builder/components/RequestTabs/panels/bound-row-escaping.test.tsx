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
 * A picked row previews as the send's bind writes it (issue #2639).
 *
 * The bind escapes a cell for the field it lands in - inside a JSON string, in
 * XML - and refuses a row it cannot write safely: a cell in an XML comment, a
 * line break bound into a header. The preview substituted every cell raw, so a
 * JSON body showed `{"m":"say "hi""}`, a document the send never produces, and
 * a header row that the send refuses looked sendable.
 *
 * It is a wiring defect - each panel has to say what kind of field it is
 * previewing - so the panels are rendered with the real `useVariableResolver`
 * holding a row, and the context comes from the panel, not from the test.
 *
 * Mutation checks: pass `"plain"` for the body's context in `BodyPanel`, and the
 * JSON, XML and comment cases redden; drop `fieldContext="header"` from
 * `HeadersPanel`, and the header case does.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import type { DataFileRow } from "@/services/data-files";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { emptyDrafts } from "../../../utils/body-drafts";

const environments = [
	{
		id: "env",
		name: "Staging",
		variables: { greeting: { value: 'say "hi"', enabled: true } },
	},
];
const session = { activeEnvironmentId: "env" };

// Monaco does not run in jsdom and the GraphQL pane is not what this guards.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));
vi.mock("./body/GraphQLBody", () => ({ default: () => <div data-testid="graphql-body" /> }));
vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useCollectionsQuery: () => ({ data: [] }),
	useEnvironmentsQuery: () => ({ data: environments }),
	useRequestDefaultsQuery: () => ({ data: undefined }),
}));
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useSessionStore: (selector: (s: typeof session) => unknown) => selector(session),
}));

const { default: HeadersPanel } = await import("./HeadersPanel");
const { default: BodyPanel } = await import("./BodyPanel");

afterEach(cleanup);
beforeEach(() => {
	session.activeEnvironmentId = "env";
});

/** The builder's context, with the resolver holding @p row as the provider's does. */
function WithRow({
	request,
	row,
	children,
}: {
	request: RequestState;
	row: DataFileRow;
	children: ReactNode;
}) {
	const resolver = useVariableResolver({ boundRow: row });
	const value = {
		request,
		updateField: () => {},
		setDisabledDefaultHeaders: () => {},
		getBodyDrafts: () => emptyDrafts(request.id),
		setBodyDrafts: () => {},
		getVariablesDraft: () => null,
		setVariablesDraft: () => {},
		resolveString: resolver.resolveString,
		resolveField: resolver.resolveField,
		getAllVariables: resolver.getAllVariables,
		getVariableOrigins: resolver.getVariableOrigins,
		updateVariable: () => {},
		writableScopes: [],
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	return (
		<RequestBuilderContext.Provider value={value}>{children}</RequestBuilderContext.Provider>
	);
}

function mount(panel: ReactElement, request: Partial<RequestState>, row: DataFileRow) {
	return render(
		// `delayDuration={0}`: the header case opens the peek to read it.
		<TooltipProvider delayDuration={0}>
			<WithRow request={{ ...createDefaultRequestState(), ...request }} row={row}>
				{panel}
			</WithRow>
		</TooltipProvider>
	);
}

/** The body's Resolved view, as drawn. */
function resolvedBody(): string {
	fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
	return document.querySelector("pre")?.textContent ?? "";
}

function renderBody(bodyMode: RequestState["bodyMode"], body: string, cell: string) {
	return mount(<BodyPanel />, { id: `req_${bodyMode}`, bodyMode, body }, { v: cell });
}

describe("the body's Resolved view with a picked row", () => {
	it("escapes a cell inside a JSON string, and leaves a value the environment answers raw", () => {
		renderBody("json", '{"m":"{{data.v}}","e":"{{greeting}}"}', 'say "hi"');
		// The environment's value is composition's, which writes it as typed -
		// the bind only escapes what the row supplies.
		expect(resolvedBody()).toBe('{"m":"say \\"hi\\"","e":"say "hi""}');
	});

	it("escapes a cell for the XML position it lands in", () => {
		renderBody("xml", '<a t="{{data.v}}">{{data.v}}</a>', 'Ben & "J" <x>');
		expect(resolvedBody()).toBe(
			'<a t="Ben &amp; &quot;J&quot; &lt;x&gt;">Ben &amp; "J" &lt;x&gt;</a>'
		);
	});

	it("writes the cell as typed in a text body, because the mode decides", () => {
		renderBody("text", '{"m":"{{data.v}}"}', 'say "hi"');
		expect(resolvedBody()).toBe('{"m":"say "hi""}');
		expect(screen.queryByText("Sending with this row is refused")).toBeNull();
	});

	it("says once why the send refuses a cell in an XML comment, and leaves the tokens", () => {
		renderBody("xml", "<a><!-- {{data.v}} {{data.v}} --></a>", "x");
		expect(resolvedBody()).toBe("<a><!-- {{data.v}} {{data.v}} --></a>");
		const notice = screen.getByText("Sending with this row is refused").parentElement;
		const reason = "{{data.v}} sits inside an XML comment";
		expect(notice?.textContent).toContain(reason);
		expect(notice?.textContent?.split(reason)).toHaveLength(2);
	});
});

describe("a header row with a picked row", () => {
	it("says why the send refuses a cell with a line break, naming the picked row", async () => {
		mount(
			<HeadersPanel />,
			{
				id: "req_header",
				headers: [{ id: "h1", key: "X-Note", value: "{{data.v}}", enabled: true }],
			},
			{ v: "ok\r\nX-Admin: true" }
		);
		fireEvent.pointerMove(screen.getByRole("button", { name: "Resolved value of X-Note" }), {
			pointerType: "mouse",
		});
		const tooltip = await screen.findByRole("tooltip");
		expect(tooltip.textContent).toContain("X-Note: {{data.v}}");
		expect(tooltip.textContent).toContain(
			"{{data.v}} is bound into a header, and the picked row has a line break in that column"
		);
		expect(tooltip.textContent).not.toContain("X-Admin");
	});
});
