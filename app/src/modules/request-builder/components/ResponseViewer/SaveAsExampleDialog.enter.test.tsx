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
 * One press, one action (#935).
 *
 * The dialog and the builder's window listener are rendered together, because
 * apart neither reproduces the defect: the name field acted on every Enter and
 * the listener excluded only textareas, contenteditables and Monaco, so
 * mod+Enter in this field saved the example *and* re-sent the request behind
 * the dialog. Both halves are asserted on every case - "saved" and "sent" are
 * different mistakes and a fix could trade one for the other.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import SaveAsExampleDialog from "./SaveAsExampleDialog";
import RequestBuilderLayout from "../RequestBuilderLayout";
import type { ResponseState } from "../../types";

const executeRequest = vi.fn();
const mutate = vi.fn();
const onClose = vi.fn();

vi.mock("@/queries", () => ({
	useCreateRequestExampleMutation: () => ({ mutate, isPending: false, error: null }),
}));

vi.mock("../../context", () => ({
	useRequestBuilderContext: () => ({
		request: { url: "https://example.com" },
		isExecuting: false,
		isStreaming: false,
		executeRequest,
		startLoadTest: vi.fn(),
		canStartLoadTest: true,
	}),
}));

vi.mock("../RequestBreadcrumb", () => ({ default: () => <div /> }));
vi.mock("../UrlBar", () => ({ default: () => <div /> }));
vi.mock("../RequestTabs", () => ({ default: () => <div /> }));
vi.mock("../ResponseAnnouncer", () => ({ default: () => <div /> }));
vi.mock("../ResponseViewer", () => ({ default: () => <div /> }));

const response = {
	status: 200,
	statusText: "OK",
	headers: {},
	body: "{}",
	time: 12,
	size: 2,
	bodyTruncated: false,
} as unknown as ResponseState;

/** The name field, reached through the portal the dialog renders into. */
const nameField = () => document.querySelector<HTMLInputElement>("#example-name")!;

function renderBoth() {
	return render(
		<>
			<RequestBuilderLayout />
			<SaveAsExampleDialog requestId="req-1" response={response} onClose={onClose} />
		</>
	);
}

describe("SaveAsExampleDialog Enter", () => {
	beforeEach(() => {
		executeRequest.mockClear();
		mutate.mockClear();
		onClose.mockClear();
	});

	it("saves exactly once on a plain Enter, and sends nothing", () => {
		renderBoth();
		fireEvent.keyDown(nameField(), { key: "Enter", bubbles: true });
		expect(mutate).toHaveBeenCalledTimes(1);
		expect(executeRequest).not.toHaveBeenCalled();
	});

	it("does nothing at all on mod+Enter - neither the save nor the send", () => {
		renderBoth();
		fireEvent.keyDown(nameField(), { key: "Enter", ctrlKey: true, bubbles: true });
		expect(mutate).not.toHaveBeenCalled();
		expect(executeRequest).not.toHaveBeenCalled();
	});
});
