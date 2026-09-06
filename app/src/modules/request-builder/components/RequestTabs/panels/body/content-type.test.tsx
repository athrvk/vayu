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
 * Ownership of the row used to live in an in-memory record the provider held,
 * which could not survive a reload - a stale auto-written row was then
 * indistinguishable from one the user typed (issue #1481). It now lives on the
 * row itself (`source: "body-mode"`), so several cases below construct a row
 * directly with `contentTypeRow` rather than threading a record through, which
 * is the point: there is nothing left to thread.
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
import type { KeyValueItem } from "@/types";

const header = (key: string, value: string, enabled = true): KeyValueItem => ({
	id: `${key}-${value}`,
	key,
	value,
	enabled,
});

describe("when a mode needs a Content-Type", () => {
	it("asks for one on GraphQL, which is sent as a JSON envelope", () => {
		expect(contentTypeToAdd("graphql", [])).toBe("application/json");
	});

	it("asks for one on JSON-RPC, whose frame is JSON too", () => {
		expect(contentTypeToAdd("jsonrpc", [])).toBe("application/json");
	});

	// Not an envelope like the two above - the document is sent byte for byte -
	// but the header carries the same weight: a SOAP endpoint reads the body as
	// XML only when the request says it is one, and without this the document
	// goes out under libcurl's `x-www-form-urlencoded` default.
	it("asks for one on XML, which is a document the server must be told about", () => {
		expect(contentTypeToAdd("xml", [])).toBe("application/xml");
	});

	it("asks for one on JSON, the panel's most common mode", () => {
		expect(contentTypeToAdd("json", [])).toBe("application/json");
	});

	it.each(["none", "text", "form-data", "x-www-form-urlencoded"] as const)(
		"asks for nothing on %s",
		(mode) => {
			// Only the four modes above write a header the user did not type. The
			// others declare a content type, but the engine sets it from the mode.
			expect(contentTypeToAdd(mode, [])).toBeNull();
		}
	);

	// The user-wins rule, on the mode where it is load-bearing rather than
	// theoretical: SOAP 1.2 requires `application/soap+xml`, so an XML body whose
	// author typed that must keep it.
	it("leaves a hand-typed application/soap+xml alone on an XML body", () => {
		expect(
			contentTypeToAdd("xml", [header(CONTENT_TYPE, "application/soap+xml; charset=utf-8")])
		).toBeNull();
	});

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
	it("removes the row that was added", () => {
		const added = contentTypeRow("application/json");
		const headers = [header("Accept", "*/*"), added];
		expect(withoutContentType(headers)).toEqual([header("Accept", "*/*")]);
	});

	it("leaves a Content-Type it did not add", () => {
		// Undo means "undo what I just did", not "delete any Content-Type" - a
		// row the user typed carries no marker at all.
		const headers = [header(CONTENT_TYPE, "application/json")];
		expect(withoutContentType(headers)).toEqual(headers);
	});

	it("leaves the row alone once the user has retyped it", () => {
		// Same row, their content now: retyping clears the marker (see
		// `KeyValueEditor`'s `handleUpdate`), so this rule sees an ordinary row.
		const added = contentTypeRow("application/json");
		const { source: _source, ...retyped } = { ...added, value: "application/graphql" };
		expect(withoutContentType([retyped])).toEqual([retyped]);
	});

	it("removes a row the user only switched off", () => {
		// Disabling our row is not adopting it - the marker survives a toggle.
		const added = contentTypeRow("application/json");
		expect(withoutContentType([{ ...added, enabled: false }])).toEqual([]);
	});

	it("recognises its own row with no earlier record at all", () => {
		// The fix for issue #1481: nothing outside the row itself has to say this
		// row is ours, so a value rebuilt fresh from storage after a reload works
		// exactly like one still held in the panel's own state.
		const afterReload = [contentTypeRow("application/json")];
		expect(withoutContentType(afterReload)).toEqual([]);
	});

	it("builds an enabled row marked as its own, or adding it would do nothing", () => {
		expect(contentTypeRow("application/json")).toMatchObject({
			key: CONTENT_TYPE,
			value: "application/json",
			enabled: true,
			source: "body-mode",
		});
	});
});

describe("what a mode change does to the header", () => {
	const base = [header("Accept", "*/*")];

	/** Into GraphQL, which is where every case below starts. */
	const intoGraphql = (headers = base) => switchContentType("graphql", headers);

	it("adds the header GraphQL needs, marked as its own", () => {
		const on = intoGraphql();
		expect(on.added).toBe("application/json");
		expect(on.headers).toHaveLength(2);
		expect(on.headers[1]).toMatchObject({ value: "application/json", source: "body-mode" });
	});

	it("removes it again on the way out", () => {
		// The reported bug: picking GraphQL and going back to None left
		// `Content-Type: application/json` on a request that sends no body.
		const on = intoGraphql();
		const off = switchContentType("none", on.headers);
		expect(off.headers).toEqual(base);
		expect(off.added).toBeNull();
	});

	it.each(["text", "form-data", "x-www-form-urlencoded"] as const)(
		"removes it on the way to %s too",
		(mode) => {
			// These modes declare a content type, but the engine sets it from the
			// mode - the row we wrote is still ours to clear.
			const on = intoGraphql();
			expect(switchContentType(mode, on.headers).headers).toEqual(base);
		}
	);

	it("keeps the user's own Content-Type through the whole trip", () => {
		// Nothing was added on the way in, so there is nothing to take away - and
		// their row must not be mistaken for ours on the way out.
		const theirs = [...base, header(CONTENT_TYPE, "application/json")];
		const on = intoGraphql(theirs);
		expect(on.added).toBeNull();
		expect(on.headers).toEqual(theirs);
		expect(switchContentType("none", on.headers).headers).toEqual(theirs);
	});

	it("leaves the row behind once the user has edited it by hand", () => {
		const on = intoGraphql();
		const edited = on.headers.map((h) => {
			if (h.key !== CONTENT_TYPE) return h;
			const { source: _source, ...rest } = h;
			return { ...rest, value: "application/graphql" };
		});
		const off = switchContentType("none", edited);
		expect(off.headers).toEqual(edited);
	});

	it("returns the same array when there is nothing to do", () => {
		// The panel skips `updateField` on identity, so an unrelated mode change
		// must not mark the request dirty.
		const result = switchContentType("text", base);
		expect(result.headers).toBe(base);
	});

	it("keeps the row when the next mode needs the same header", () => {
		// The rule is here so a mode pair sharing a header does not silently churn
		// the Headers tab by removing and re-adding the row.
		const on = intoGraphql();
		const again = switchContentType("graphql", on.headers);
		expect(again.headers).toBe(on.headers);
		expect(again.added).toBeNull();
	});

	it("keeps it across GraphQL and JSON-RPC, which need the same one", () => {
		// The pair the rule above was written for before either existed: both are
		// JSON envelopes, so the row stays put - same id, still ours - and the
		// notice does not fire for a header that was already there.
		const on = intoGraphql();
		const rpc = switchContentType("jsonrpc", on.headers);
		expect(rpc.headers).toBe(on.headers);
		expect(rpc.added).toBeNull();

		// And leaving JSON-RPC still takes back the row GraphQL added.
		expect(switchContentType("none", rpc.headers).headers).toEqual(base);
	});

	it("keeps it across GraphQL and JSON, which need the same one", () => {
		// json now auto-writes the same header, so switching into it from GraphQL
		// must not churn the row any more than switching to JSON-RPC does.
		const on = intoGraphql();
		const json = switchContentType("json", on.headers);
		expect(json.headers).toBe(on.headers);
		expect(json.added).toBeNull();
	});
});

describe("what a mode requires", () => {
	it("separates the requirement from whether it needs adding", () => {
		// `contentTypeToAdd` answers "add one?" and goes null once a header is
		// there; the switch needs "does this mode still want that value?", which
		// must stay true for a request that already carries it.
		expect(requiredContentType("graphql")).toBe("application/json");
		expect(requiredContentType("text")).toBeNull();
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
