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
 * "Copy for agent" on the Services drawer's inbox, issuer and mock rows
 * (#2047).
 *
 * Each row also offers its own URL, so the pair is the thing to pin: the
 * reference line is the one that names the service by id, and the URL, the
 * signing key and a canned response body stay off the clipboard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useToastStore } from "@/stores";
import type { Inbox, MockIssuer, MockServer } from "@/types";
import ServicesPanel from "./ServicesPanel";

const SENTINEL = "s3cr3t-sentinel";

const listInboxes = vi.fn();
const listMockIssuers = vi.fn();
const listMockServers = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listMockIssuers: () => listMockIssuers(),
			listMockServers: () => listMockServers(),
		},
	};
});

const INBOX = {
	inboxId: "inbox_a",
	url: "http://127.0.0.1:41234/",
	bind: "127.0.0.1",
	port: 41234,
	running: true,
	loopback: true,
	captureCount: 0,
	allowedOrigins: [],
	response: { status: 200, body: SENTINEL, headers: {}, delayMs: 0 },
} as Inbox;

const ISSUER = {
	issuerId: "iss_a",
	issuerUrl: "http://127.0.0.1:42000",
	tokenUrl: "http://127.0.0.1:42000/token",
	authorizeUrl: "http://127.0.0.1:42000/authorize",
	signingKey: SENTINEL.padEnd(32, "k"),
	port: 42000,
	expiresInSeconds: 3600,
	failureMode: "none",
	slowMs: 0,
	issueRefreshTokens: false,
	clientCount: 0,
	createdAt: 1700000000000,
} as MockIssuer;

const MOCK = {
	mockId: "mock_a",
	collectionId: "col_1",
	collectionName: "Pet Store",
	url: `http://127.0.0.1:43100/?k=${SENTINEL}`,
	port: 43100,
	latencyMs: 0,
	errorRatePct: 0,
	routeCount: 3,
	routesWithoutExample: 0,
	createdAt: 1700000000000,
	allowedOrigins: [],
} as MockServer;

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	listInboxes.mockReset().mockResolvedValue([INBOX]);
	listMockIssuers.mockReset().mockResolvedValue([ISSUER]);
	listMockServers.mockReset().mockResolvedValue([MOCK]);
	writeText.mockReset().mockResolvedValue(undefined);
	// jsdom ships no clipboard, and `useCopy` reports a rejection rather than
	// claiming a copy that did not happen - so the stub has to resolve.
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

async function copyForAgent(menuName: RegExp) {
	render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<ServicesPanel />
			</TooltipProvider>
		</QueryClientProvider>
	);
	fireEvent.pointerDown(await screen.findByRole("button", { name: menuName }), {
		button: 0,
		ctrlKey: false,
		pointerType: "mouse",
	});
	fireEvent.click(
		within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Copy for agent/ })
	);
	await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
	return writeText.mock.calls[0][0] as string;
}

const ROWS: [string, RegExp, string][] = [
	["an inbox", /more actions for inbox on port 41234/i, 'Vayu inbox "port 41234" (inbox_a)'],
	[
		"a mock issuer",
		/more actions for issuer on port 42000/i,
		'Vayu mock issuer "port 42000" (iss_a)',
	],
	[
		"a mock server",
		/more actions for mock server on port 43100/i,
		'Vayu mock server "Pet Store on port 43100" (mock_a)',
	],
];

describe("Copy for agent on a Services row", () => {
	for (const [name, menu, line] of ROWS) {
		it(`copies ${name}'s reference line and says so`, async () => {
			expect(await copyForAgent(menu)).toBe(line);
			await waitFor(() =>
				expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
					"Reference copied",
				])
			);
		});

		it(`keeps ${name}'s url and secrets off the clipboard`, async () => {
			const copied = await copyForAgent(menu);

			expect(copied).not.toContain(SENTINEL);
			expect(copied).not.toContain("127.0.0.1");
		});
	}
});
