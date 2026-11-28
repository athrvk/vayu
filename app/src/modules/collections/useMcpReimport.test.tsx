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
 * "Update existing" (#3994): what it sends, when it asks first, and that a new comparison starts
 * from the defaults. The dialog around it is `ImportModal.mcp.test.tsx`'s.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { mcpUpdateFailureMessage, mcpUpdateToastMessage, useMcpReimport } from "./useMcpReimport";
import { mcpBatchEntry, type BatchEntry } from "@/services/importers/batch";
import { apiService } from "@/services/api";
import { ApiError } from "@/services/http-client";
import { result as emptyResult } from "./import-preview.testkit";
import type {
	ImportMcpApplyResponse,
	ImportMcpDiffMatch,
	ImportMcpRequest,
	OAuth2Config,
} from "@/types";

const MATCH: ImportMcpDiffMatch = {
	collectionId: "col_1",
	name: "Acme tools",
	identical: false,
	added: [{ kind: "tool", key: "export", name: "export" }],
	removed: [{ kind: "resource", key: "file:///a.txt", name: "a.txt", requestId: "req_9" }],
	changed: [
		{ kind: "tool", key: "find", name: "find", requestId: "req_1", fields: ["description"] },
	],
	renameCandidates: [],
};

/** What the connect sent: a token and a header no other field of this test spells. */
const CONNECT: ImportMcpRequest = {
	url: "https://mcp.example.com/mcp",
	headers: [{ name: "X-Tenant", value: "acme" }],
	auth: { mode: "bearer", token: "connect-time-token" },
	include: { tools: true, resources: true, prompts: false },
};

const ANSWER: ImportMcpApplyResponse = {
	collectionId: "col_1",
	created: [{ kind: "tool", key: "export", requestId: "req_3" }],
	updated: ["req_1"],
	deleted: [],
};

function entryFor(matches: ImportMcpDiffMatch[]): BatchEntry {
	return mcpBatchEntry(emptyResult(), CONNECT, matches);
}

function mount(initial: BatchEntry | null) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
	);
	return renderHook(({ entry }) => useMcpReimport(entry), {
		wrapper,
		initialProps: { entry: initial },
	});
}

let importMcpApply: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.restoreAllMocks();
	importMcpApply = vi.spyOn(apiService, "importMcpApply").mockResolvedValue(ANSWER);
});

/** Runs `call` inside act and answers what it settled with. */
async function settle<T>(call: () => Promise<T>): Promise<T> {
	let answer!: T;
	await act(async () => {
		answer = await call();
	});
	return answer;
}

/** The ticks of `MATCH` with its one removal ticked too. */
function withRemovalTicked(hook: ReturnType<typeof mount>) {
	act(() =>
		hook.result.current.setSelection("col_1", {
			...hook.result.current.selectionFor(MATCH),
			removed: new Set(["req_9"]),
		})
	);
}

describe("useMcpReimport", () => {
	it("sends the request the connect made, with the collection and the default ticks", async () => {
		const { result } = mount(entryFor([MATCH]));

		const landed = await settle(() => result.current.update("col_1"));

		expect(landed).toEqual({ match: MATCH, response: ANSWER });
		expect(importMcpApply).toHaveBeenCalledTimes(1);
		expect(importMcpApply).toHaveBeenCalledWith({
			...CONNECT,
			collectionId: "col_1",
			select: {
				added: [{ kind: "tool", key: "export" }],
				changed: ["req_1"],
				removed: [],
				renamed: [],
			},
		});
	});

	it("asks before deleting, naming the count, and sends nothing until it is confirmed", async () => {
		const hook = mount(entryFor([MATCH]));
		const { result } = hook;
		withRemovalTicked(hook);

		expect(await settle(() => result.current.update("col_1"))).toBeNull();

		expect(result.current.confirming).toEqual({ collectionId: "col_1", deleteCount: 1 });
		expect(importMcpApply).not.toHaveBeenCalled();

		act(() => result.current.cancelConfirm());
		expect(result.current.confirming).toBeNull();
		expect(await settle(() => result.current.confirmUpdate())).toBeNull();
		expect(importMcpApply).not.toHaveBeenCalled();

		await settle(() => result.current.update("col_1"));
		const landed = await settle(() => result.current.confirmUpdate());

		expect(landed?.match).toBe(MATCH);
		expect(importMcpApply).toHaveBeenCalledTimes(1);
		expect(importMcpApply.mock.calls[0][0]).toMatchObject({ select: { removed: ["req_9"] } });
		expect(result.current.confirming).toBeNull();
	});

	it("does not ask about a removal that a ticked rename stands in for, and sends the rename", async () => {
		const renaming: ImportMcpDiffMatch = {
			...MATCH,
			added: [{ kind: "tool", key: "find", name: "find" }],
			removed: [{ kind: "tool", key: "search", name: "search", requestId: "req_5" }],
			changed: [],
			renameCandidates: [
				{
					kind: "tool",
					key: "find",
					name: "search",
					requestId: "req_5",
					fields: [],
					renamedFrom: "search",
				},
			],
		};
		const { result } = mount(entryFor([renaming]));
		act(() =>
			result.current.setSelection("col_1", {
				added: new Set(),
				changed: new Set(),
				removed: new Set(["req_5"]),
				renamed: new Set(["req_5"]),
			})
		);

		await settle(() => result.current.update("col_1"));

		expect(result.current.confirming).toBeNull();
		expect(importMcpApply.mock.calls[0][0]).toMatchObject({
			select: {
				added: [],
				removed: [],
				renamed: [{ requestId: "req_5", key: "find" }],
			},
		});
	});

	it("keeps the ticks and the error after a refusal, and reports nothing landed", async () => {
		importMcpApply.mockRejectedValue(new ApiError(409, "CONFLICT", "stale"));
		const hook = mount(entryFor([MATCH]));
		const { result } = hook;
		withRemovalTicked(hook);

		await settle(() => result.current.update("col_1"));
		const landed = await settle(() => result.current.confirmUpdate());

		expect(landed).toBeNull();
		expect(result.current.error).toBeInstanceOf(ApiError);
		expect(result.current.confirming).toBeNull();
		expect([...result.current.selectionFor(MATCH).removed]).toEqual(["req_9"]);
	});

	it("starts a new comparison from the defaults, with no error carried over", async () => {
		importMcpApply.mockRejectedValue(new Error("down"));
		const hook = mount(entryFor([MATCH]));
		const { result, rerender } = hook;
		withRemovalTicked(hook);
		await settle(() => result.current.update("col_1"));
		await settle(() => result.current.confirmUpdate());
		expect(result.current.error).not.toBeNull();

		// A reconnect: the same collection and the very same diff answer, a fresh entry.
		rerender({ entry: entryFor([MATCH]) });

		expect(result.current.error).toBeNull();
		expect(result.current.selectionFor(MATCH).removed.size).toBe(0);
	});

	it("forgets the comparison, and the request it held, once there is no entry", async () => {
		const hook = mount(entryFor([MATCH]));
		withRemovalTicked(hook);

		hook.rerender({ entry: null });

		expect(hook.result.current.selectionFor(MATCH).removed.size).toBe(0);
		expect(await settle(() => hook.result.current.update("col_1"))).toBeNull();
		expect(importMcpApply).not.toHaveBeenCalled();
	});

	it("does nothing for a collection the comparison did not name, or an entry that kept no request", async () => {
		const bare: BatchEntry = { ...entryFor([MATCH]) };
		delete bare.mcpRequest;

		const noRequest = mount(bare);
		const named = mount(entryFor([MATCH]));

		expect(await settle(() => noRequest.result.current.update("col_1"))).toBeNull();
		expect(await settle(() => named.result.current.update("col_404"))).toBeNull();
		expect(importMcpApply).not.toHaveBeenCalled();
	});
});

describe("an update of an OAuth connect's comparison (#3983)", () => {
	const SIGNED_IN: OAuth2Config = {
		grantType: "authorization_code",
		discoverUrl: CONNECT.url,
		accessTokenUrl: "https://auth.example.com/token",
		clientId: "registered-client",
	};

	it("sends the token the engine holds now, never the one the connect sent", async () => {
		const fetchToken = vi.spyOn(apiService, "fetchOAuth2Token").mockResolvedValue({
			cacheKey: "key",
			accessToken: "refreshed-token",
			tokenType: "Bearer",
			expiresIn: 3600,
			createdAt: 0,
			expiresAt: 3_600_000,
			hasRefreshToken: true,
		});
		const { result } = mount(mcpBatchEntry(emptyResult(), CONNECT, [MATCH], SIGNED_IN));

		await settle(() => result.current.update("col_1"));

		expect(fetchToken).toHaveBeenCalledWith({ config: SIGNED_IN });
		const sent = importMcpApply.mock.calls[0][0] as ImportMcpRequest;
		expect(sent.auth).toEqual({ mode: "bearer", token: "refreshed-token" });
		expect(JSON.stringify(sent)).not.toContain("connect-time-token");
	});

	it("writes nothing and says to sign in again when no token is left to refresh", async () => {
		vi.spyOn(apiService, "fetchOAuth2Token").mockRejectedValue(
			new ApiError(409, "oauth2_interactive_required", "OAuth 2.0 authorization required")
		);
		const { result } = mount(mcpBatchEntry(emptyResult(), CONNECT, [MATCH], SIGNED_IN));

		expect(await settle(() => result.current.update("col_1"))).toBeNull();

		expect(importMcpApply).not.toHaveBeenCalled();
		const said = mcpUpdateFailureMessage(result.current.error as Error);
		expect(said).toContain("the sign-in to this server has run out");
		expect(said).toContain("connect again to sign in");
	});
});

describe("what an update says", () => {
	it("counts a sync's way, naming the collection", () => {
		expect(mcpUpdateToastMessage("Acme tools", ANSWER)).toBe(
			'Updated "Acme tools" - 1 request created, 1 updated, 0 deleted.'
		);
		expect(
			mcpUpdateToastMessage("Acme tools", { ...ANSWER, created: [], deleted: ["a", "b"] })
		).toBe('Updated "Acme tools" - 0 requests created, 1 updated, 2 deleted.');
	});

	it("tells a 409 to compare again and that nothing was written", () => {
		const stale = mcpUpdateFailureMessage(
			new ApiError(
				409,
				"CONFLICT",
				"export is no longer an added entry in this server's diff."
			)
		);

		expect(stale).toContain(
			"Couldn't update the collection - export is no longer an added entry"
		);
		expect(stale).toContain("Nothing was written");
		expect(stale).toContain("connect again to compare");
	});

	it("passes any other failure through as the engine said it", () => {
		expect(
			mcpUpdateFailureMessage(new ApiError(502, "BAD_GATEWAY", "The server did not answer"))
		).toBe("Couldn't update the collection - The server did not answer");
		expect(mcpUpdateFailureMessage(new Error("offline"))).toBe(
			"Couldn't update the collection - offline"
		);
	});
});
