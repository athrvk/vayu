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
 * and the notice that admits it.
 *
 * The old version did it inside `handleModeChange`: appended
 * `Content-Type: application/json` with no feedback of any kind - the Headers
 * tab's count badge simply went up - and **nothing ever removed it**, so one
 * visit to GraphQL left the header on the request permanently, including after
 * switching back to None.
 *
 * The rule is tested here rather than through the panel because the panel only
 * runs it when a Radix Select commits a value, and a Select does not commit in
 * jsdom - it raises no pointer events. A first attempt drove the trigger by
 * keyboard, found the option and clicked it, and changed nothing: three tests
 * that looked like they exercised the side effect and exercised none of it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { contentTypeToAdd, withoutContentType, contentTypeRow, CONTENT_TYPE } from "./content-type";
import { ContentTypeNotice } from "./ContentTypeNotice";
import type { KeyValueItem } from "../../../../types";

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
	it("removes the row that was added", () => {
		const headers = [header("Accept", "*/*"), header(CONTENT_TYPE, "application/json")];
		expect(withoutContentType(headers, "application/json")).toEqual([header("Accept", "*/*")]);
	});

	it("leaves a Content-Type it did not add", () => {
		// Undo means "undo what I just did", not "delete any Content-Type".
		const headers = [header(CONTENT_TYPE, "application/graphql")];
		expect(withoutContentType(headers, "application/json")).toEqual(headers);
	});

	it("builds an enabled row, or adding it would do nothing", () => {
		expect(contentTypeRow("application/json")).toMatchObject({
			key: CONTENT_TYPE,
			value: "application/json",
			enabled: true,
		});
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
