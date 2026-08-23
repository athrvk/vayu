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
 * The window-level send listener had no behavioural coverage at all (#935),
 * which is how it came to fire from inside a dialog's name field and on top of
 * an open stream.
 *
 * Each guard is asserted as a pair - the chord acts, then the same chord does
 * not under the one changed condition - because a listener that never fired
 * would satisfy every negative case at once.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import RequestBuilderLayout from "./RequestBuilderLayout";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui";

const executeRequest = vi.fn();
const startLoadTest = vi.fn();

const context = {
	request: { url: "https://example.com" },
	isExecuting: false,
	isStreaming: false,
	executeRequest,
	startLoadTest,
	canStartLoadTest: true,
};

vi.mock("../context", () => ({
	useRequestBuilderContext: () => context,
}));

vi.mock("./RequestBreadcrumb", () => ({ default: () => <div data-testid="breadcrumb" /> }));
vi.mock("./UrlBar", () => ({ default: () => <div data-testid="url-bar" /> }));
vi.mock("./RequestTabs", () => ({ default: () => <div data-testid="request-tabs" /> }));
vi.mock("./ResponseAnnouncer", () => ({ default: () => <div data-testid="announcer" /> }));
vi.mock("./ResponseViewer", () => ({ default: () => <div data-testid="response-viewer" /> }));

/** The layout, optionally with a real dialog over it - as SaveAsExample is. */
function renderLayout(withDialog = false) {
	return render(
		<>
			<RequestBuilderLayout />
			{withDialog && (
				<Dialog open>
					<DialogContent>
						<DialogTitle>Save response as example</DialogTitle>
						<DialogDescription>A dialog over the builder.</DialogDescription>
						<input aria-label="Name" autoFocus />
					</DialogContent>
				</Dialog>
			)}
		</>
	);
}

const sendChord = (target: Element | null = null, shiftKey = false) =>
	fireEvent.keyDown(target ?? document.activeElement ?? document.body, {
		key: "Enter",
		ctrlKey: true,
		shiftKey,
		bubbles: true,
	});

describe("RequestBuilderLayout send chord", () => {
	beforeEach(() => {
		executeRequest.mockClear();
		startLoadTest.mockClear();
		context.isExecuting = false;
		context.isStreaming = false;
		context.request = { url: "https://example.com" };
	});

	it("sends on mod+Enter from an ordinary target", () => {
		renderLayout();
		sendChord(document.body);
		expect(executeRequest).toHaveBeenCalledTimes(1);
	});

	it("starts a load test on mod+shift+Enter, and does not also send", () => {
		renderLayout();
		sendChord(document.body, true);
		expect(startLoadTest).toHaveBeenCalledTimes(1);
		expect(executeRequest).not.toHaveBeenCalled();
	});

	it("does not send from a field inside an open dialog", () => {
		const { getByLabelText } = renderLayout(true);
		sendChord(getByLabelText("Name"));
		expect(executeRequest).not.toHaveBeenCalled();
	});

	it("does not start a load test from inside an open dialog either", () => {
		const { getByLabelText } = renderLayout(true);
		sendChord(getByLabelText("Name"), true);
		expect(startLoadTest).not.toHaveBeenCalled();
	});

	it("does not send while a stream is open - the chord matches the Stop button", () => {
		context.isStreaming = true;
		renderLayout();
		sendChord(document.body);
		expect(executeRequest).not.toHaveBeenCalled();
	});

	it("still refuses while the request is in flight, and with an empty URL", () => {
		context.isExecuting = true;
		const first = renderLayout();
		sendChord(document.body);
		expect(executeRequest).not.toHaveBeenCalled();
		first.unmount();

		context.isExecuting = false;
		context.request = { url: "   " };
		renderLayout();
		sendChord(document.body);
		expect(executeRequest).not.toHaveBeenCalled();
	});

	it("leaves a textarea's Enter alone", () => {
		renderLayout();
		const textarea = document.createElement("textarea");
		document.body.appendChild(textarea);
		sendChord(textarea);
		expect(executeRequest).not.toHaveBeenCalled();
		textarea.remove();
	});
});
