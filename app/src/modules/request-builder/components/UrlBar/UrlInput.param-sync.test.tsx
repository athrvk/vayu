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
 * Typing in the URL bar must merge the URL's query into `params`, never
 * replace the list outright - a disabled row is invisible in the URL by
 * design, so a wholesale replace deletes it on every keystroke, and clearing
 * the query left orphan rows behind (issue #1482).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { emptyDrafts } from "../../utils/body-drafts";
import type { KeyValueItem } from "@/types";
import UrlInput from "./UrlInput";

function renderUrlInput(url: string, params: KeyValueItem[], disableUrlEncoding = false) {
	const updateField = vi.fn();
	const context = {
		request: { ...createDefaultRequestState(), url, params, disableUrlEncoding },
		setRequest: vi.fn(),
		updateField,
		getBodyDrafts: () => emptyDrafts(null),
		setBodyDrafts: vi.fn(),
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: vi.fn(),
		writableScopes: [],
	} as unknown as RequestBuilderContextValue;

	render(
		<TooltipProvider>
			<RequestBuilderContext.Provider value={context}>
				<UrlInput />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);

	return { updateField };
}

afterEach(cleanup);

describe("UrlInput param sync", () => {
	it("keeps a disabled row when typing appends a new query param", () => {
		const params: KeyValueItem[] = [
			{ id: "1", key: "a", value: "1", enabled: true },
			{ id: "2", key: "b", value: "2", enabled: false },
		];
		const { updateField } = renderUrlInput("https://x/y?a=1", params);

		fireEvent.change(screen.getByLabelText("Request URL"), {
			target: { value: "https://x/y?a=1&c=3" },
		});

		const paramsCall = updateField.mock.calls.find(([field]) => field === "params");
		expect(paramsCall).toBeTruthy();
		const merged = paramsCall![1] as KeyValueItem[];
		expect(merged.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
			{ key: "a", value: "1", enabled: true },
			{ key: "b", value: "2", enabled: false },
			{ key: "c", value: "3", enabled: true },
		]);
	});

	it("clearing the query string drops enabled rows and keeps disabled ones", () => {
		// Mutation check: restoring the `newParams.length > 0` guard skips the
		// params update entirely here, leaving the stale enabled row in place.
		const params: KeyValueItem[] = [
			{ id: "1", key: "a", value: "1", enabled: true },
			{ id: "2", key: "b", value: "2", enabled: false },
		];
		const { updateField } = renderUrlInput("https://x/y?a=1", params);

		fireEvent.change(screen.getByLabelText("Request URL"), {
			target: { value: "https://x/y" },
		});

		const paramsCall = updateField.mock.calls.find(([field]) => field === "params");
		expect(paramsCall).toBeTruthy();
		const merged = paramsCall![1] as KeyValueItem[];
		expect(merged.map(({ key, enabled }) => ({ key, enabled }))).toEqual([
			{ key: "b", enabled: false },
		]);
	});

	it("adds, renames and removes path rows as `:name` segments are typed (#1764)", () => {
		const query: KeyValueItem = { id: "q", key: "page", value: "1", enabled: true };
		const idRow: KeyValueItem = { id: "p", key: "id", value: "42", enabled: true, in: "path" };
		const paramsAfter = (url: string, params: KeyValueItem[]) => {
			// A start unlike every target, so each change below is a real edit.
			const { updateField } = renderUrlInput("https://x/users/:id?page=1&before", params);
			fireEvent.change(screen.getByLabelText("Request URL"), { target: { value: url } });
			cleanup();
			const call = updateField.mock.calls.find(([field]) => field === "params");
			return (call![1] as KeyValueItem[]).map(({ key, value, in: at }) => ({
				key,
				value,
				in: at,
			}));
		};

		// Added, in segment order, with no value yet.
		expect(paramsAfter("https://x/users/:id/posts/:postId?page=1", [query])).toEqual([
			{ key: "page", value: "1", in: undefined },
			{ key: "id", value: "", in: "path" },
			{ key: "postId", value: "", in: "path" },
		]);
		// Renamed, keeping its value.
		expect(paramsAfter("https://x/users/:userId?page=1", [query, idRow])).toEqual([
			{ key: "page", value: "1", in: undefined },
			{ key: "userId", value: "42", in: "path" },
		]);
		// Removed with its segment; the query row is untouched.
		expect(paramsAfter("https://x/users?page=1", [query, idRow])).toEqual([
			{ key: "page", value: "1", in: undefined },
		]);
	});

	it("keeps the query as written for a request sent without encoding (#1765)", () => {
		// Mutation check: passing `decode: true` (or nothing) here stores
		// `a b`, which the Params table then joins raw into a malformed URL.
		const { updateField } = renderUrlInput("https://x/y", [], true);

		fireEvent.change(screen.getByLabelText("Request URL"), {
			target: { value: "https://x/y?q=a%20b&r=x%26y" },
		});

		const paramsCall = updateField.mock.calls.find(([field]) => field === "params");
		const merged = paramsCall![1] as KeyValueItem[];
		expect(merged.map(({ key, value }) => [key, value])).toEqual([
			["q", "a%20b"],
			["r", "x%26y"],
		]);
	});
});
