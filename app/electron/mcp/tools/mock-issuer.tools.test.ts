/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { dispatchTool, TOOLS } from "../tools.js";
import { argumentsSchema } from "./kit.js";
import { MOCK_ISSUER_FAILURE_MODES } from "./mock-issuer.js";
import { EngineRequestError } from "../engine-client.js";
import { FAILURE_MODE_LABELS } from "@/modules/services/failure-modes";
import { fakeClient, ctxWith, firstText } from "../tools.testkit.js";

/*
 * The local OAuth 2.0 mock issuer (#509). The engine has served
 * `/mock-issuer/*` since #479; these three tools are what let an agent asked to
 * "test this auth flow" mint its own tokens instead of having a human curl the
 * engine first.
 */
describe("mock issuer tools", () => {
	const byName = () => new Map(TOOLS.map((t) => [t.name, t]));

	test("start, stop and update are execute, list is read, and none of them opens the world", () => {
		const tools = byName();
		expect(tools.get("start_mock_issuer")?.category).toBe("execute");
		expect(tools.get("stop_mock_issuer")?.category).toBe("execute");
		expect(tools.get("update_mock_issuer")?.category).toBe("execute");
		expect(tools.get("list_mock_issuers")?.category).toBe("read");
		for (const name of [
			"start_mock_issuer",
			"stop_mock_issuer",
			"update_mock_issuer",
			"list_mock_issuers",
		]) {
			// Loopback-only by engine contract, so an agent's client must not be
			// told these reach an open world - that hint is what a cautious client
			// asks about before calling.
			expect(tools.get(name)?.annotations.openWorldHint, name).toBe(false);
			expect(tools.get(name)?.annotations.destructiveHint, name).toBeFalsy();
		}
	});

	test("the mutating ones invalidate the services family, the read stays silent", () => {
		// The other half of the #502 coordination: the drawer reads issuers, so
		// the tools that change what it would show declare the entity that
		// refreshes it (#757). A read declaring one would be the inverse defect.
		for (const name of ["start_mock_issuer", "stop_mock_issuer", "update_mock_issuer"]) {
			expect(byName().get(name)?.invalidates, name).toEqual(["service"]);
		}
		expect(byName().get("list_mock_issuers")?.invalidates).toEqual([]);
	});

	test("start sends only the fields the caller named and returns the issuer's urls", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_mock_issuer",
			{
				expiresInSeconds: 60,
				claims: { sub: "alice", roles: ["admin"] },
				issueRefreshTokens: true,
			},
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startMockIssuer as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// An absent field must stay absent: the engine reads a present one with a
		// bad value as a 400 rather than falling back to its default, and
		// `undefined` would serialize to `null`.
		expect(payload).toEqual({
			expiresInSeconds: 60,
			claims: { sub: "alice", roles: ["admin"] },
			issueRefreshTokens: true,
		});
		expect(Object.keys(payload as object)).not.toContain("port");
		expect(Object.keys(payload as object)).not.toContain("failureMode");
		const body = JSON.parse(firstText(res)) as Record<string, unknown>;
		expect(body.issuerId).toBe("issuer_1");
		expect(body.tokenUrl).toBe("http://127.0.0.1:41234/token");
		expect(body.authorizeUrl).toBe("http://127.0.0.1:41234/authorize");
		expect(body.signingKey).toBe("k3y");
	});

	test("start forwards every configurable field, none renamed on the way", async () => {
		const client = fakeClient();
		const args = {
			port: 41234,
			expiresInSeconds: 3600,
			claims: { sub: "alice" },
			clients: [{ clientId: "cid", clientSecret: "s3cret" }],
			failureMode: "slow",
			slowMs: 2000,
			issueRefreshTokens: false,
			resourceScope: "mcp:read mcp:write",
		};
		const res = await dispatchTool("start_mock_issuer", args, ctxWith(client));
		expect(res.isError).toBeFalsy();
		// Keyed exactly as `parse_mock_issuer_settings` reads them - a rename here
		// is a field the engine silently ignores.
		expect((client.startMockIssuer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(args);
	});

	test("list round-trips the engine's envelope", async () => {
		const running = {
			issuers: [
				{ issuerId: "issuer_1", tokenUrl: "http://127.0.0.1:41234/token", port: 41234 },
			],
		};
		const client = fakeClient({ listMockIssuers: vi.fn().mockResolvedValue(running) });
		const res = await dispatchTool("list_mock_issuers", {}, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(firstText(res))).toEqual(running);
	});

	test("stop names the issuer, and an unknown id is an error rather than a shrug", async () => {
		const client = fakeClient();
		const ok = await dispatchTool(
			"stop_mock_issuer",
			{ issuerId: "issuer_1" },
			ctxWith(client)
		);
		expect(ok.isError).toBeFalsy();
		expect(client.stopMockIssuer).toHaveBeenCalledWith("issuer_1", undefined);

		const gone = fakeClient({
			stopMockIssuer: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Mock issuer not found")
				),
		});
		const res = await dispatchTool("stop_mock_issuer", { issuerId: "issuer_9" }, ctxWith(gone));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('No mock issuer with id "issuer_9"');
		expect(firstText(res)).toContain("list_mock_issuers");
	});

	test("stop refuses an empty id before the engine is called", async () => {
		const client = fakeClient();
		const res = await dispatchTool("stop_mock_issuer", { issuerId: "" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(client.stopMockIssuer).not.toHaveBeenCalled();
	});

	test("update sends only the fields it was asked to change", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_mock_issuer",
			{ issuerId: "issuer_1", failureMode: "server_error" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		// A merge-patch: `slowMs` absent means "leave it", and spelling it as
		// null or 0 would mean something else entirely.
		expect(client.updateMockIssuer).toHaveBeenCalledWith(
			"issuer_1",
			{ failureMode: "server_error" },
			undefined
		);
	});

	test("update forwards both mutable settings under the engine's own names", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_mock_issuer",
			{ issuerId: "issuer_1", failureMode: "slow", slowMs: 2500 },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		// Keyed as `read_mutable_settings` reads them - a rename here is a field
		// the engine silently ignores while the tool reports success.
		expect(client.updateMockIssuer).toHaveBeenCalledWith(
			"issuer_1",
			{ failureMode: "slow", slowMs: 2500 },
			undefined
		);
	});

	test("update refuses an empty patch rather than reporting a no-op as done", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_mock_issuer",
			{ issuerId: "issuer_1" },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/failureMode/);
		// The engine accepts `{}` and answers 200, so without this the agent is
		// told its change landed when nothing changed.
		expect(client.updateMockIssuer).not.toHaveBeenCalled();
	});

	test("update refuses a start-only setting through the schema, not the engine", () => {
		const shape = TOOLS.find((t) => t.name === "update_mock_issuer")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		// Port, clients, claims, issueRefreshTokens and resourceScope cannot change
		// under a bound listener - the engine answers "stop it and start a new
		// one" - so they are not offered here at all.
		for (const key of [
			"port",
			"clients",
			"claims",
			"issueRefreshTokens",
			"resourceScope",
			"expiresInSeconds",
		]) {
			expect(shape[key], key).toBeUndefined();
		}
		expect(shape.failureMode.safeParse("explode").success).toBe(false);
		expect(shape.failureMode.safeParse("none").success).toBe(true);
		expect(shape.slowMs.safeParse(-1).success).toBe(false);
	});

	test("update surfaces an unknown id as an error", async () => {
		const gone = fakeClient({
			updateMockIssuer: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Mock issuer not found")
				),
		});
		const res = await dispatchTool(
			"update_mock_issuer",
			{ issuerId: "issuer_9", failureMode: "none" },
			ctxWith(gone)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('No mock issuer with id "issuer_9"');
	});

	/*
	 * The gating matrix. The issuer is loopback-only by engine contract, so
	 * neither of the two gates that govern the other effectful tools applies: the
	 * allowlist exists to stop an agent generating traffic against third parties,
	 * and the write toggle gates saved data. What does govern them is the per-tool
	 * switch - and an agent that could already reach `POST /mock-issuer/start`
	 * through `run_request` with `localhost` allowlisted gains no capability here.
	 */
	test("neither the empty allowlist nor the write toggle gates them", async () => {
		const client = fakeClient();
		const locked = ctxWith(client, { allowlist: [], allowAll: false, allowWrites: false });
		for (const [tool, args] of [
			["start_mock_issuer", {}],
			["list_mock_issuers", {}],
			["update_mock_issuer", { issuerId: "issuer_1", failureMode: "none" }],
			["stop_mock_issuer", { issuerId: "issuer_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, locked);
			expect(res.isError, tool).toBeFalsy();
		}
		expect(client.startMockIssuer).toHaveBeenCalled();
		expect(client.updateMockIssuer).toHaveBeenCalled();
		expect(client.stopMockIssuer).toHaveBeenCalled();
	});

	test("the per-tool switch is what turns them off", async () => {
		const client = fakeClient();
		const off = ctxWith(client, {
			disabledTools: [
				"start_mock_issuer",
				"list_mock_issuers",
				"update_mock_issuer",
				"stop_mock_issuer",
			],
		});
		for (const [tool, args] of [
			["start_mock_issuer", {}],
			["list_mock_issuers", {}],
			["update_mock_issuer", { issuerId: "issuer_1", failureMode: "none" }],
			["stop_mock_issuer", { issuerId: "issuer_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, off);
			expect(res.isError, tool).toBe(true);
			expect(firstText(res), tool).toMatch(/is disabled\..*Vayu Settings → MCP/);
		}
		expect(client.startMockIssuer).not.toHaveBeenCalled();
		expect(client.listMockIssuers).not.toHaveBeenCalled();
		expect(client.updateMockIssuer).not.toHaveBeenCalled();
		expect(client.stopMockIssuer).not.toHaveBeenCalled();
	});

	test("the schema refuses a malformed config before the engine sees it", () => {
		const shape = TOOLS.find((t) => t.name === "start_mock_issuer")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		// A failure mode outside the closed set would start an issuer that behaves
		// nothing like the one the agent asked for.
		expect(shape.failureMode.safeParse("explode").success).toBe(false);
		expect(shape.failureMode.safeParse("invalid_client").success).toBe(true);
		expect(shape.resourceScope.safeParse("mcp:read mcp:write").success).toBe(true);
		expect(shape.resourceScope.safeParse(["mcp:read"]).success).toBe(false);
		expect(shape.claims.safeParse("sub=alice").success).toBe(false);
		expect(shape.claims.safeParse({ sub: "alice" }).success).toBe(true);
		expect(shape.port.safeParse(70000).success).toBe(false);
		expect(shape.port.safeParse(1.5).success).toBe(false);
		expect(shape.port.safeParse(0).success).toBe(true);
		expect(shape.expiresInSeconds.safeParse(0).success).toBe(false);
		expect(shape.slowMs.safeParse(-1).success).toBe(false);
		expect(shape.clients.safeParse([{ clientSecret: "s" }]).success).toBe(false);
		expect(shape.clients.safeParse([{ clientId: "cid" }]).success).toBe(true);
		// Every field is optional: an issuer with no config at all is the common
		// "I just need a token" case.
		expect(argumentsSchema(shape).safeParse({}).success).toBe(true);
	});

	test("both tools offer exactly the failure modes the app's issuer UI names", () => {
		// The app's labels table is a `Record` over the engine's modes, so it is the
		// list a new mode cannot be missing from; the tools' own list is a second
		// copy and a mode absent from it is one an agent can never select.
		const ui = Object.keys(FAILURE_MODE_LABELS).sort();
		expect([...MOCK_ISSUER_FAILURE_MODES].sort()).toEqual(ui);
		for (const name of ["start_mock_issuer", "update_mock_issuer"]) {
			const shape = TOOLS.find((t) => t.name === name)!.inputSchema as Record<
				string,
				z.ZodType
			>;
			for (const mode of ui)
				expect(shape.failureMode.safeParse(mode).success, mode).toBe(true);
		}
	});

	test("an agent mints a token against its own issuer, end to end", async () => {
		// The owner scenario from #509, through the MCP layer: stand up an issuer,
		// point a request at the token URL it returned, get a token back.
		const client = fakeClient({
			executeRequest: vi.fn().mockImplementation((payload: Record<string, unknown>) =>
				Promise.resolve(
					String(payload.url ?? "").endsWith("/token")
						? {
								statusCode: 200,
								body: JSON.stringify({
									access_token: "header.payload.signature",
									token_type: "Bearer",
									expires_in: 3600,
								}),
							}
						: { statusCode: 404 }
				)
			),
		});
		const ctx = ctxWith(client, { allowlist: ["127.0.0.1"] });

		const started = await dispatchTool(
			"start_mock_issuer",
			{ clients: [{ clientId: "cid", clientSecret: "s3cret" }] },
			ctx
		);
		expect(started.isError).toBeFalsy();
		const { tokenUrl } = JSON.parse(firstText(started)) as { tokenUrl: string };

		const token = await dispatchTool(
			"run_request",
			{
				method: "POST",
				url: tokenUrl,
				bodyType: "x-www-form-urlencoded",
				body: "grant_type=client_credentials&client_id=cid&client_secret=s3cret",
			},
			ctx
		);
		expect(token.isError).toBeFalsy();
		const sent = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(sent.url).toBe(tokenUrl);
		expect(firstText(token)).toContain("header.payload.signature");

		const stopped = await dispatchTool(
			"stop_mock_issuer",
			{ issuerId: (JSON.parse(firstText(started)) as { issuerId: string }).issuerId },
			ctx
		);
		expect(stopped.isError).toBeFalsy();
		expect(client.stopMockIssuer).toHaveBeenCalledWith("issuer_1", undefined);
	});
});
