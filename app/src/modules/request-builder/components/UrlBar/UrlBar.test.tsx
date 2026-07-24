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
 * The Load Test button is hidden when the builder cannot start one.
 *
 * A detached copy of a past design run (History run view) is mounted without an
 * `onStartLoadTest` handler, so `canStartLoadTest` is false. The button used to
 * render anyway and do nothing on click. Dropping the `canStartLoadTest` gate in
 * the bar makes the second case below render the button again.
 *
 * The method selector and URL input are stubbed - they pull in the
 * variable-highlighting input and are not what this guards.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import UrlBar from "./index";

vi.mock("./MethodSelector", () => ({ default: () => null }));
vi.mock("./UrlInput", () => ({ default: () => null }));

function ctx(canStartLoadTest: boolean): RequestBuilderContextValue {
	return {
		request: { ...createDefaultRequestState(), url: "https://example.test/x" },
		setRequest: vi.fn(),
		updateField: vi.fn(),
		response: null,
		setResponse: vi.fn(),
		activeTab: "params",
		setActiveTab: vi.fn(),
		isExecuting: false,
		isSaving: false,
		hasUnsavedChanges: false,
		saveStatus: "idle",
		resolveString: (s: string) => s,
		resolveVariables: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
		updateVariable: vi.fn(),
		executeRequest: vi.fn(async () => {}),
		saveRequest: vi.fn(async () => {}),
		startLoadTest: vi.fn(),
		canStartLoadTest,
	};
}

function renderBar(canStartLoadTest: boolean) {
	return render(
		<RequestBuilderContext.Provider value={ctx(canStartLoadTest)}>
			<UrlBar />
		</RequestBuilderContext.Provider>
	);
}

describe("UrlBar Load Test button visibility", () => {
	it("shows Load Test when the builder can start one", () => {
		renderBar(true);
		expect(screen.getByRole("button", { name: /load test/i })).toBeTruthy();
	});

	it("hides Load Test on a detached copy that cannot start one", () => {
		renderBar(false);
		expect(screen.queryByRole("button", { name: /load test/i })).toBeNull();
		// Send is still there - only the load-test affordance is gated.
		expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
	});
});
