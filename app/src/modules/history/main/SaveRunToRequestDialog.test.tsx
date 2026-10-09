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
 * The disabled Save's hint on a run the request already matches (issue #1943).
 * The dialog has no collection concept, so the hint must give the body's own
 * reason rather than the new-request flow's sentence.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import SaveRunToRequestDialog from "./SaveRunToRequestDialog";
import { seedFromRun } from "./design-run-seed";
import type { Request, Run } from "@/types";

vi.mock("@/queries", async () => {
	const actual = await vi.importActual<typeof import("@/queries")>("@/queries");
	return {
		...actual,
		useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	};
});

const liveRequest = {
	id: "req_1",
	collectionId: "c1",
	name: "Create user",
	method: "POST",
	url: "https://api.example.test/users",
	params: [],
	headers: [],
	body: { mode: "none" },
	auth: { mode: "none" },
	followRedirects: true,
	maxRedirects: 10,
	httpVersion: "auto",
	verifySSL: true,
	disableCookies: false,
	disabledSystemHeaders: [],
	disableUrlEncoding: false,
	elements: [],
} as unknown as Request;

function matchingRun(): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_000_300,
		requestId: "req_1",
		environmentId: null,
		configSnapshot: {
			method: "POST",
			url: "https://api.example.test/users",
			body: { mode: "none" },
			auth: { mode: "none" },
		},
		result: {
			timestamp: 1_750_000_000_000,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 12,
			trace: {
				request: { method: "POST", url: "https://api.example.test/users", headers: {} },
				response: { headers: {}, body: "{}" },
			},
		},
	} as Run;
}

describe("SaveRunToRequestDialog - nothing to write", () => {
	it("explains the disabled Save by the match, not by collections", async () => {
		const run = matchingRun();
		render(
			<QueryClientProvider client={new QueryClient()}>
				<TooltipProvider>
					<SaveRunToRequestDialog
						open
						onOpenChange={vi.fn()}
						seed={seedFromRun(run, liveRequest)}
						run={run}
						liveRequest={liveRequest}
					/>
				</TooltipProvider>
			</QueryClientProvider>
		);

		const save = screen.getByRole("button", { name: /^save to request$/i });
		expect((save as HTMLButtonElement).disabled).toBe(true);

		const wrapper = save.closest('[data-slot="disabled-hint"]') as HTMLElement;
		fireEvent.focus(wrapper);
		const hint = await screen.findByRole("tooltip");
		expect(hint.textContent).toMatch(/request already matches this run/i);
		expect(hint.textContent).not.toMatch(/collection/i);
	});
});
