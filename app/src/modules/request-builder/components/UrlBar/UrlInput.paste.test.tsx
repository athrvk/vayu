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
 * A URL wrapped across lines (a terminal, a mail, a PDF) is pasted joined, not
 * with each break turned into a space, which sent `/wrap/ /second` and a
 * rejected `http:/ /host` (#3688). A curl command and a one-line URL paste as
 * they always did.
 */

import { useState, type ReactNode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useToastStore } from "@/stores";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { emptyDrafts } from "../../utils/body-drafts";
import UrlInput from "./UrlInput";

/** A builder whose `url` really changes, so the field shows what a paste left. */
function Harness({
	initialUrl,
	setRequest,
}: {
	initialUrl: string;
	setRequest: RequestBuilderContextValue["setRequest"];
}): ReactNode {
	const [url, setUrl] = useState(initialUrl);
	const context = {
		request: { ...createDefaultRequestState(), url },
		setRequest,
		updateField: (field: string, value: unknown) => {
			if (field === "url") setUrl(value as string);
		},
		getBodyDrafts: () => emptyDrafts(null),
		setBodyDrafts: vi.fn(),
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: vi.fn(),
		writableScopes: [],
	} as unknown as RequestBuilderContextValue;

	return (
		<TooltipProvider>
			<RequestBuilderContext.Provider value={context}>
				<UrlInput />
			</RequestBuilderContext.Provider>
		</TooltipProvider>
	);
}

function renderField(initialUrl = "") {
	const setRequest = vi.fn();
	render(<Harness initialUrl={initialUrl} setRequest={setRequest} />);
	return { field: screen.getByLabelText("Request URL") as HTMLInputElement, setRequest };
}

/** Fires a paste carrying `text`; returns whether the default was left alone. */
function paste(field: HTMLInputElement, text: string): boolean {
	return fireEvent.paste(field, { clipboardData: { getData: () => text } });
}

afterEach(cleanup);

describe("pasting a wrapped URL", () => {
	it.each([
		["a break and the indent after it", "https://a/b/\n  /c", "https://a/b//c"],
		["a CRLF break", "https://a/b/\r\n/c", "https://a/b//c"],
		["blanks before the break too", "https://a/b/  \n  /c", "https://a/b//c"],
		["a break inside the scheme", "http:\n//127.0.0.1:9/x", "http://127.0.0.1:9/x"],
		["a run of breaks", "https://a/b\n\n\n/c?q=1", "https://a/b/c?q=1"],
		["three wrapped lines", "https://a/\nb/\nc", "https://a/b/c"],
	])("joins %s", (_name, pasted, expected) => {
		const { field } = renderField();

		paste(field, pasted);

		expect(field.value).toBe(expected);
	});

	it("leaves a blank that is not beside a break", () => {
		const { field } = renderField();

		paste(field, "https://a/b c\n/d");

		expect(field.value).toBe("https://a/b c/d");
	});

	it("inserts at the caret, replaces a selection, and leaves the caret after the paste", () => {
		const { field } = renderField("https://a/XX/z");
		field.setSelectionRange(10, 12); // "XX"

		paste(field, "b/\n  c");

		expect(field.value).toBe("https://a/b/c/z");
		const caretAfterPaste = "https://a/b/c".length;
		expect(field.selectionStart).toBe(caretAfterPaste);
		expect(field.selectionEnd).toBe(caretAfterPaste);
	});

	it("takes the default over, so the browser does not paste the break as a space", () => {
		const { field } = renderField();

		expect(paste(field, "https://a/b/\n/c")).toBe(false);
	});
});

describe("pasting anything else", () => {
	it("leaves a one-line URL to the browser", () => {
		const { field } = renderField();

		// Not prevented, and nothing written by hand: jsdom does not paste, so
		// the field staying empty shows this handler did not insert it.
		expect(paste(field, "https://a/b/c")).toBe(true);
		expect(field.value).toBe("");
	});

	it("still imports a curl command into the whole request", () => {
		const { field, setRequest } = renderField();

		const notPrevented = paste(field, "curl -X POST https://a.test/x \\\n  -H 'X-A: 1'");

		expect(notPrevented).toBe(false);
		expect(setRequest).toHaveBeenCalledTimes(1);
		expect(field.value).toBe("");
	});
});

describe("pasting a command that cannot be read (#3685)", () => {
	beforeEach(() => {
		useToastStore.setState({ toasts: [] });
	});

	it.each([
		["an open quote", "curl -H 'A: b", "You opened a quote and never closed it"],
		["no URL", "curl -H 'A: b'", "The command has no URL"],
		// Throws inside the parser (encodeURIComponent on a lone surrogate).
		[
			"a command the parser throws on",
			"curl -T $'\\ud800' https://x.com",
			"Vayu couldn't parse the command",
		],
	])("says so for %s and leaves the request alone", (_name, command, cause) => {
		const { field, setRequest } = renderField("https://keep.test/");

		const notPrevented = paste(field, command);

		// Still taken over: a broken command must not drop into the one-line field.
		expect(notPrevented).toBe(false);
		expect(setRequest).not.toHaveBeenCalled();
		expect(field.value).toBe("https://keep.test/");
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({
			variant: "warning",
			title: "Couldn't import the command",
			message: expect.stringContaining(cause),
		});
	});

	it("shows no notice for a command that reads", () => {
		const { field } = renderField();

		paste(field, "curl https://a.test/x");

		expect(useToastStore.getState().toasts).toEqual([]);
	});
});
