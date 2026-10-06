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
 * The key/value tables' Σ peek hides a secret variable's value (#1810).
 *
 * The peek prints the row's resolved text, so `token={{secretVar}}` sat on
 * screen as plain text beside a variable the user marked secret - the leak the
 * "Sends" line closed for the URL (#1806). It is a wiring defect, so each
 * table is rendered through its real panel and the real `useVariableSupport`:
 * a row that masks when handed a stub scope proves nothing about the scope the
 * builder actually passes.
 *
 * Mutation check: drop `mask={variables?.maskSecrets}` in `KeyValueRow`, or
 * `maskSecrets` from `useVariableSupport`, and the masking cases here redden.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { SECRET_UI_MASK } from "@/services/codegen";
import type { KeyValueItem } from "@/types";
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
vi.mock("@/queries", () => ({ useRequestDefaultsQuery: () => ({ data: undefined }) }));

const { default: ParamsPanel } = await import("./ParamsPanel");
const { default: HeadersPanel } = await import("./HeadersPanel");
const { default: BodyPanel } = await import("./BodyPanel");

afterEach(cleanup);

const SECRET = "s3cr3t-value-9f2";
const VALUES: Record<string, string> = { secretVar: SECRET, region: "eu-west-1" };
const resolveString = (s: string) =>
	s.replace(VARIABLE_PATTERN, (_m, name: string) => VALUES[name] ?? "");

// Module-level, as the real provider's `useCallback`s are: a fresh identity per
// render would only add re-renders to what is under test.
const getAllVariables = () => ({
	secretVar: { value: SECRET, scope: "environment", secret: true },
	region: { value: "eu-west-1", scope: "environment" },
});
const getVariableOrigins = () => [];
const updateVariable = () => {};
const writableScopes: never[] = [];

/** The two rows every table gets: one secret, one plain. */
function rows(prefix: string): KeyValueItem[] {
	return [
		{ id: `${prefix}_secret`, key: "x-token", value: "{{secretVar}}", enabled: true },
		{ id: `${prefix}_plain`, key: "x-region", value: "{{region}}", enabled: true },
	];
}

function mount(panel: ReactElement, request: Partial<RequestState>) {
	const value = {
		request: { ...createDefaultRequestState(), ...request },
		updateField: () => {},
		setDisabledDefaultHeaders: () => {},
		getBodyDrafts: () => emptyDrafts("req_secret_peek"),
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
		// `delayDuration={0}`: the peek is opened below to read it.
		<TooltipProvider delayDuration={0}>
			<RequestBuilderContext.Provider value={value}>{panel}</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

/** Open the peek named after the row's key and read what it says. */
async function peek(key: string): Promise<string> {
	const trigger = screen.getByRole("button", { name: `Resolved value of ${key}` });
	fireEvent.pointerMove(trigger, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");
	return tooltip.textContent ?? "";
}

/** No peek trigger's name, and none of the page's text, carries the secret. */
function expectNoSecretOnScreen() {
	for (const button of screen.getAllByRole("button")) {
		expect(button.getAttribute("aria-label") ?? "").not.toContain(SECRET);
	}
	expect(document.body.textContent).not.toContain(SECRET);
}

const TABLES: { name: string; panel: ReactElement; request: Partial<RequestState> }[] = [
	{
		name: "Params",
		panel: <ParamsPanel />,
		request: { id: "req_params", params: rows("params") },
	},
	{
		name: "Headers",
		panel: <HeadersPanel />,
		request: { id: "req_headers", headers: rows("headers") },
	},
	{
		name: "Body form-data",
		panel: <BodyPanel />,
		request: { id: "req_form", bodyMode: "form-data", formData: rows("form") },
	},
	{
		name: "Body urlencoded",
		panel: <BodyPanel />,
		request: {
			id: "req_urlencoded",
			bodyMode: "x-www-form-urlencoded",
			urlEncoded: rows("urlencoded"),
		},
	},
];

describe.each(TABLES)("the $name table's resolved peek", ({ panel, request }) => {
	it("masks a secret variable's value in the tooltip and the trigger's name", async () => {
		mount(panel, request);

		expect(await peek("x-token")).toBe(`x-token: ${SECRET_UI_MASK}`);
		expectNoSecretOnScreen();
	});

	it("keeps a plain variable's value readable", async () => {
		mount(panel, request);

		expect(await peek("x-region")).toBe("x-region: eu-west-1");
	});
});
