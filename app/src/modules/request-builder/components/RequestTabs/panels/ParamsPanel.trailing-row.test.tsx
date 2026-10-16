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
 * The Params tab always ends in one blank row to type into (issue #2155).
 *
 * `request.params` does not carry that row: `mergeParamsFromUrl` drops it on
 * every URL edit, so the panel derives it where it renders the rows, as the
 * Headers tab does. These drive the real URL bar and the real panel off one
 * stateful request, so the check is on what a user sees after typing in the bar.
 */

import { describe, it, expect, afterEach } from "vitest";
import { useCallback, useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import type { KeyValueItem } from "@/types";
import UrlInput from "../../UrlBar/UrlInput";
import ParamsPanel from "./ParamsPanel";

afterEach(cleanup);

const QUERY: KeyValueItem = { id: "q", key: "page", value: "1", enabled: true };
const PATH: KeyValueItem = { id: "p", key: "id", value: "42", enabled: true, in: "path" };
const BLANK: KeyValueItem = { id: "blank", key: "", value: "", enabled: true };

// Module-level: the real provider keeps these stable.
const resolveString = (s: string) => s;
const getAllVariables = () => ({});
const getVariableOrigins = () => [];
const updateVariable = () => {};
const writableScopes: never[] = [];

/** A provider whose `updateField` writes back, as the real one does. */
// `renderKey` is unused: a new prop value is how a test makes React re-render the
// panel without changing the request.
function Harness({ url, params }: { url: string; params: KeyValueItem[]; renderKey?: number }) {
	const [request, setRequest] = useState<RequestState>(() => ({
		...createDefaultRequestState(),
		id: "req_trailing_row",
		url,
		params,
	}));
	const updateField = useCallback(
		(field: keyof RequestState, value: unknown) =>
			setRequest((prev) => ({ ...prev, [field]: value })),
		[]
	);
	const value = {
		request,
		setRequest,
		updateField,
		resolveString,
		getAllVariables,
		getVariableOrigins,
		updateVariable,
		writableScopes,
		dataColumns: undefined,
	} as unknown as RequestBuilderContextValue;
	return (
		<TooltipProvider>
			<RequestBuilderContext.Provider value={value}>
				<UrlInput />
				<ParamsPanel />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

/** The query table's key fields: every parameter box outside the path section. */
const keyFields = () => screen.getAllByPlaceholderText("Parameter") as HTMLInputElement[];

describe("the Params tab's trailing blank row", () => {
	it("is still there, once, in the same render as a URL edit", () => {
		render(<Harness url="https://x/users/:id?page=1" params={[QUERY, BLANK, PATH]} />);
		expect(keyFields().map((el) => el.value)).toEqual(["page", ""]);

		fireEvent.change(screen.getByLabelText("Request URL"), {
			target: { value: "https://x/users/:id?page=1&limit=5" },
		});

		// No timers and no waiting: the row is derived, not restored by an effect.
		expect(keyFields().map((el) => el.value)).toEqual(["page", "limit", ""]);
	});

	it("is added on first render when the stored params end in a filled row", () => {
		render(<Harness url="https://x/users/:id?page=1" params={[QUERY, PATH]} />);

		expect(keyFields().map((el) => el.value)).toEqual(["page", ""]);
	});

	it("keeps one blank row, and the focus in it, across renders and keystrokes", () => {
		const view = render(<Harness url="https://x/y?page=1" params={[QUERY]} renderKey={0} />);
		const blankKey = keyFields()[1];
		blankKey.focus();

		// A render that changes no params: the derived row must come back with
		// the same id, or the row remounts and the focus is gone.
		view.rerender(<Harness url="https://x/y?page=1" params={[QUERY]} renderKey={1} />);
		expect(keyFields()[1]).toBe(blankKey);
		expect(document.activeElement).toBe(blankKey);

		fireEvent.change(blankKey, { target: { value: "s" } });
		fireEvent.change(keyFields()[1], { target: { value: "so" } });

		expect(keyFields()[1]).toBe(blankKey);
		expect(document.activeElement).toBe(blankKey);
		expect(blankKey.value).toBe("so");
		expect(keyFields()).toHaveLength(3);
	});
});
