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
 * A request created blank opens with the caret in its URL field (#3400).
 *
 * Ctrl/Cmd+N left focus on `<body>`, so the first keystroke after it went
 * nowhere. The field mounts after the tab opens, which is why this drives the
 * real `useNewRequest`, the real tabs store and the real `UrlInput` together:
 * each half passes alone, and only the pair can fail to meet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useNewRequest } from "@/hooks/useNewRequest";
import { useTabsStore } from "@/stores";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import { emptyDrafts } from "../../utils/body-drafts";
import UrlInput from "./UrlInput";

const mocks = vi.hoisted(() => ({ createRequest: vi.fn() }));

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: [{ id: "c1", name: "API" }] }),
	useCreateRequestMutation: () => ({ mutateAsync: mocks.createRequest, isPending: false }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn() }),
}));

function contextFor(id: string): RequestBuilderContextValue {
	return {
		request: { ...createDefaultRequestState(), id, url: "" },
		setRequest: vi.fn(),
		updateField: vi.fn(),
		getBodyDrafts: () => emptyDrafts(null),
		setBodyDrafts: vi.fn(),
		resolveString: (s: string) => s,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		updateVariable: vi.fn(),
		writableScopes: [],
	} as unknown as RequestBuilderContextValue;
}

/**
 * The shell in miniature: a trigger for the flow, and a builder that mounts its
 * URL field only once a request tab is active - the order the real app has.
 */
function Harness({
	preset,
}: {
	preset?: Parameters<ReturnType<typeof useNewRequest>["newRequest"]>[0];
}) {
	const { newRequest } = useNewRequest();
	const activeRequestId = useTabsStore((s) => {
		const tab = s.openTabs.find((t) => t.id === s.activeTabId);
		return tab?.type === "request" ? tab.entityId : null;
	});
	return (
		<TooltipProvider>
			<button type="button" onClick={() => newRequest(preset)}>
				new
			</button>
			{activeRequestId && (
				<RequestBuilderContext.Provider value={contextFor(activeRequestId)}>
					<UrlInput />
				</RequestBuilderContext.Provider>
			)}
		</TooltipProvider>
	);
}

async function startNewRequest(preset?: Parameters<typeof Harness>[0]["preset"]) {
	render(<Harness preset={preset} />);
	const trigger = screen.getByRole("button", { name: "new" });
	trigger.focus();
	act(() => trigger.click());
	return screen.findByLabelText("Request URL");
}

beforeEach(() => {
	mocks.createRequest = vi.fn().mockResolvedValue({ id: "r1" });
	useTabsStore.setState({ openTabs: [], activeTabId: null, navIntent: null });
});

afterEach(cleanup);

describe("a new request's URL field", () => {
	it("takes focus once it mounts, when the request was created blank", async () => {
		const input = await startNewRequest();

		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(useTabsStore.getState().navIntent).toBeNull();
	});

	it("leaves focus alone when the request was created from a preset", async () => {
		const input = await startNewRequest({ name: "Demo", method: "GET", url: "https://x.test" });

		// The intent is what would move focus; with none issued there is nothing to wait for.
		expect(useTabsStore.getState().navIntent).toBeNull();
		expect(document.activeElement).not.toBe(input);
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "new" }));
	});

	it("does not carry an unanswered ask over to a later request", async () => {
		// A tab that never got to mount its builder: the user moved on first.
		act(() => useTabsStore.getState().openRequestFocusingUrl("r_gone"));
		act(() => useTabsStore.getState().openTab({ type: "request", entityId: "r_later" }));

		render(
			<TooltipProvider>
				<RequestBuilderContext.Provider value={contextFor("r_later")}>
					<UrlInput />
				</RequestBuilderContext.Provider>
			</TooltipProvider>
		);

		expect(document.activeElement).not.toBe(screen.getByLabelText("Request URL"));
	});
});
