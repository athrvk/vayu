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
 * The Body panel's Resolved view hides a secret variable's value (#1813).
 *
 * The view prints `resolveString(request.body)`, so `{"token":"{{secretVar}}"}`
 * sat on screen as plain text beside a variable the user marked secret - the
 * same leak the Params "Sends" line (#1806) and the table peeks (#1810) closed.
 * It is a wiring defect, so the panel is rendered with the real
 * `useVariableSupport` rather than a stub scope.
 *
 * Mutation check: drop the `maskSecrets` call that builds `shownResolvedBody` in
 * `BodyPanel`, and every masking case here redden.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { SECRET_UI_MASK } from "@/services/codegen";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { emptyDrafts } from "../../../utils/body-drafts";

// Monaco does not run in jsdom and the GraphQL pane is not what this guards.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));
vi.mock("./body/GraphQLBody", () => ({ default: () => <div data-testid="graphql-body" /> }));

const { default: BodyPanel } = await import("./BodyPanel");

afterEach(cleanup);

const SECRET = "s3cr3t-value-9f2";
const VALUES: Record<string, string> = { secretVar: SECRET, region: "eu-west-1" };
const resolveString = (s: string) =>
	s.replace(VARIABLE_PATTERN, (_m, name: string) => VALUES[name] ?? "");

// Module-level, as the real provider's `useCallback`s are.
const getAllVariables = () => ({
	secretVar: { value: SECRET, scope: "environment", secret: true },
	region: { value: "eu-west-1", scope: "environment" },
});
const getVariableOrigins = () => [];
const updateVariable = () => {};
const writableScopes: never[] = [];

function mount(request: Partial<RequestState>) {
	const value = {
		request: { ...createDefaultRequestState(), ...request },
		updateField: () => {},
		setRequest: () => {},
		getBodyDrafts: () => emptyDrafts("req_secret_body"),
		setBodyDrafts: () => {},
		getVariablesDraft: () => null,
		setVariablesDraft: () => {},
		resolveString,
		getAllVariables,
		getVariableOrigins,
		updateVariable,
		writableScopes,
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	return render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<BodyPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

/** The Resolved view's text, after opening it. */
function openResolved(): string {
	fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
	return document.querySelector("pre")?.textContent ?? "";
}

const BODIES = [
	{
		mode: "json",
		secret: '{"token":"{{secretVar}}","region":"{{region}}"}',
		plain: '{"region":"{{region}}"}',
		masked: `{"token":"${SECRET_UI_MASK}","region":"eu-west-1"}`,
	},
	{
		mode: "jsonrpc",
		secret: '{"method":"m","params":["{{secretVar}}","{{region}}"]}',
		plain: '{"method":"m","params":["{{region}}"]}',
		masked: `{"method":"m","params":["${SECRET_UI_MASK}","eu-west-1"]}`,
	},
	{
		mode: "xml",
		secret: "<a><t>{{secretVar}}</t><r>{{region}}</r></a>",
		plain: "<a><r>{{region}}</r></a>",
		masked: `<a><t>${SECRET_UI_MASK}</t><r>eu-west-1</r></a>`,
	},
	{
		mode: "text",
		secret: "token={{secretVar}} region={{region}}",
		plain: "region={{region}}",
		masked: `token=${SECRET_UI_MASK} region=eu-west-1`,
	},
] as const;

describe.each(BODIES)("the $mode body's Resolved view", ({ mode, secret, plain, masked }) => {
	it("masks a secret variable's value and keeps a plain one readable", () => {
		mount({ bodyMode: mode, body: secret });

		expect(openResolved()).toBe(masked);
		expect(document.body.textContent).not.toContain(SECRET);
	});

	it("shows a body with no secret variable in full", () => {
		mount({ bodyMode: mode, body: plain });

		expect(openResolved()).toBe(resolveString(plain));
	});
});

describe("the Resolved view's masking", () => {
	it("leaves literal text alone: only a secret variable's value is masked", () => {
		mount({ bodyMode: "text", body: "{{region}} secretVar hunter2" });

		expect(openResolved()).toBe("eu-west-1 secretVar hunter2");
	});

	it("masks every occurrence of the secret, not the first", () => {
		mount({ bodyMode: "text", body: "{{secretVar}}-{{secretVar}}" });

		expect(openResolved()).toBe(`${SECRET_UI_MASK}-${SECRET_UI_MASK}`);
	});
});
