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
 * Choosing GraphQL edits the Headers tab. This is the rule that decides when,
 * when it puts the edit back, and the notice that admits both.
 *
 * The old version did it inside `handleModeChange`: appended
 * `Content-Type: application/json` with no feedback of any kind - the Headers
 * tab's count badge simply went up - and **nothing ever removed it**, so one
 * visit to GraphQL left the header on the request permanently, including after
 * switching back to None. The notice fixed the first half; `switchContentType`
 * fixes the second.
 *
 * The rule is tested here rather than through the panel because the panel only
 * runs it when a Radix Select commits a value, and a Select does not commit in
 * jsdom - it raises no pointer events. A first attempt drove the trigger by
 * keyboard, found the option and clicked it, and changed nothing: three tests
 * that looked like they exercised the side effect and exercised none of it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
	contentTypeToAdd,
	requiredContentType,
	switchContentType,
	withoutContentType,
	contentTypeRow,
	CONTENT_TYPE,
} from "./content-type";
import { ContentTypeNotice } from "./ContentTypeNotice";
import type { AutoContentType } from "../../../../types";
import type { KeyValueItem } from "@/types";

const header = (key: string, value: string, enabled = true): KeyValueItem => ({
	id: `${key}-${value}`,
	key,
	value,
	enabled,
});

const REQUEST = "req_a";

describe("when a mode needs a Content-Type", () => {
	it("asks for one on GraphQL, which is sent as a JSON envelope", () => {
		expect(contentTypeToAdd("graphql", [])).toBe("application/json");
	});

	it.each(["none", "json", "text", "form-data", "x-www-form-urlencoded"] as const)(
		"asks for nothing on %s",
		(mode) => {
			// Only GraphQL writes a header the user did not type. The other modes
			// declare a content type, but the engine sets it from the mode.
			expect(contentTypeToAdd(mode, [])).toBeNull();
		}
	);

	it("leaves an existing Content-Type alone", () => {
		expect(contentTypeToAdd("graphql", [header(CONTENT_TYPE, "application/json")])).toBeNull();
	});

	it("leaves a *different* Content-Type alone rather than replacing it", () => {
		// Someone who set `application/graphql` by hand means it. Overwriting it
		// would be a worse version of the bug this exists to fix.
		expect(
			contentTypeToAdd("graphql", [header(CONTENT_TYPE, "application/graphql")])
		).toBeNull();
	});

	it("ignores case, because header names are case-insensitive", () => {
		expect(
			contentTypeToAdd("graphql", [header("content-type", "application/json")])
		).toBeNull();
	});

	it("does not count a disabled row, which is not sent", () => {
		// A disabled header does not go on the wire, so the request would leave
		// without one - the header is still needed.
		expect(contentTypeToAdd("graphql", [header(CONTENT_TYPE, "application/json", false)])).toBe(
			"application/json"
		);
	});
});

describe("taking it back", () => {
	const ours = (row: KeyValueItem): AutoContentType => ({
		requestId: REQUEST,
		rowId: row.id,
		value: row.value,
	});

	it("removes the row that was added", () => {
		const added = header(CONTENT_TYPE, "application/json");
		const headers = [header("Accept", "*/*"), added];
		expect(withoutContentType(headers, ours(added))).toEqual([header("Accept", "*/*")]);
	});

	it("leaves a Content-Type it did not add", () => {
		// Undo means "undo what I just did", not "delete any Content-Type" - and
		// the user's own row is identical apart from its id.
		const headers = [header(CONTENT_TYPE, "application/json")];
		const someoneElses: AutoContentType = {
			requestId: REQUEST,
			rowId: "a-row-we-never-wrote",
			value: "application/json",
		};
		expect(withoutContentType(headers, someoneElses)).toEqual(headers);
	});

	it("leaves the row alone once the user has retyped its value", () => {
		// Same row, their content now: they changed application/json to
		// application/graphql, which is a decision, not our leftover.
		const added = header(CONTENT_TYPE, "application/json");
		const retyped = { ...added, value: "application/graphql" };
		expect(withoutContentType([retyped], ours(added))).toEqual([retyped]);
	});

	it("removes a row the user only switched off", () => {
		// Disabling our row is not adopting it.
		const added = header(CONTENT_TYPE, "application/json");
		expect(withoutContentType([{ ...added, enabled: false }], ours(added))).toEqual([]);
	});

	it("builds an enabled row, or adding it would do nothing", () => {
		expect(contentTypeRow("application/json")).toMatchObject({
			key: CONTENT_TYPE,
			value: "application/json",
			enabled: true,
		});
	});
});

describe("what a mode change does to the header", () => {
	const base = [header("Accept", "*/*")];

	/** Into GraphQL, which is where every case below starts. */
	const intoGraphql = (headers = base, requestId: string | null = REQUEST) =>
		switchContentType("graphql", headers, requestId, null);

	it("adds the header GraphQL needs, and remembers the row", () => {
		const on = intoGraphql();
		expect(on.added).toBe("application/json");
		expect(on.headers).toHaveLength(2);
		expect(on.auto).toMatchObject({ requestId: REQUEST, value: "application/json" });
		expect(on.auto?.rowId).toBe(on.headers[1].id);
	});

	it("removes it again on the way out", () => {
		// The reported bug: picking GraphQL and going back to None left
		// `Content-Type: application/json` on a request that sends no body.
		const on = intoGraphql();
		const off = switchContentType("none", on.headers, REQUEST, on.auto);
		expect(off.headers).toEqual(base);
		expect(off.auto).toBeNull();
		expect(off.added).toBeNull();
	});

	it.each(["json", "text", "form-data", "x-www-form-urlencoded"] as const)(
		"removes it on the way to %s too",
		(mode) => {
			// JSON declares the same content type, but the engine sets it from the
			// mode - the row we wrote is still ours to clear.
			const on = intoGraphql();
			expect(switchContentType(mode, on.headers, REQUEST, on.auto).headers).toEqual(base);
		}
	);

	it("keeps the user's own Content-Type through the whole trip", () => {
		// Nothing was added on the way in, so there is nothing to take away - and
		// their row must not be mistaken for ours on the way out.
		const theirs = [...base, header(CONTENT_TYPE, "application/json")];
		const on = intoGraphql(theirs);
		expect(on.added).toBeNull();
		expect(on.headers).toEqual(theirs);
		expect(switchContentType("none", on.headers, REQUEST, on.auto).headers).toEqual(theirs);
	});

	it("leaves the row behind once the user has retyped it", () => {
		const on = intoGraphql();
		const edited = on.headers.map((h) =>
			h.id === on.auto?.rowId ? { ...h, value: "application/graphql" } : h
		);
		const off = switchContentType("none", edited, REQUEST, on.auto);
		expect(off.headers).toEqual(edited);
		// And it is no longer ours, so a later switch cannot come back for it.
		expect(off.auto).toBeNull();
	});

	it("does not apply a record belonging to another request", () => {
		// One provider serves every request tab and the record outlives the request
		// that filled it. Row ids are not unique across a duplicated request, so an
		// id match alone would delete a header from a request we never edited.
		const on = intoGraphql(base, "req_a");
		const off = switchContentType("none", on.headers, "req_b", on.auto);
		expect(off.headers).toEqual(on.headers);
	});

	it("returns the same array when there is nothing to do", () => {
		// The panel skips `updateField` on identity, so an unrelated mode change
		// must not mark the request dirty.
		const result = switchContentType("json", base, REQUEST, null);
		expect(result.headers).toBe(base);
	});

	it("keeps the row when the next mode needs the same header", () => {
		// No mode pair does this today; the rule is here so adding one does not
		// silently churn the Headers tab by removing and re-adding the row.
		const on = intoGraphql();
		const again = switchContentType("graphql", on.headers, REQUEST, on.auto);
		expect(again.headers).toBe(on.headers);
		expect(again.auto).toBe(on.auto);
		expect(again.added).toBeNull();
	});
});

describe("what a mode requires", () => {
	it("separates the requirement from whether it needs adding", () => {
		// `contentTypeToAdd` answers "add one?" and goes null once a header is
		// there; the switch needs "does this mode still want that value?", which
		// must stay true for a request that already carries it.
		expect(requiredContentType("graphql")).toBe("application/json");
		expect(requiredContentType("json")).toBeNull();
	});
});

describe("the notice", () => {
	function renderNotice() {
		const onUndo = vi.fn();
		const onDismiss = vi.fn();
		render(
			<ContentTypeNotice value="application/json" onUndo={onUndo} onDismiss={onDismiss} />
		);
		return { onUndo, onDismiss };
	}

	it("names the header it added, not just that something happened", () => {
		renderNotice();
		expect(screen.getByText(`${CONTENT_TYPE}: application/json`)).toBeInTheDocument();
	});

	it("offers the way back", () => {
		const { onUndo } = renderNotice();
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		expect(onUndo).toHaveBeenCalledTimes(1);
	});

	it("can be dismissed without undoing", () => {
		// Keeping the header is the common case - the notice is about telling you,
		// not about asking.
		const { onUndo, onDismiss } = renderNotice();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onUndo).not.toHaveBeenCalled();
	});
});
