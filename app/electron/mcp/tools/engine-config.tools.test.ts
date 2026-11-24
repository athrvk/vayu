/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool } from "../tools.js";
import { fakeClient, ctxWith, firstText } from "../tools.testkit.js";

describe("engine config tools", () => {
	test("get_engine_config passes the engine response through", async () => {
		const client = fakeClient();
		const res = await dispatchTool("get_engine_config", {}, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain("workers");
	});

	test("update_engine_config is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { workers: "16" } },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.updateConfig).not.toHaveBeenCalled();
	});

	test("update_engine_config applies when writes are enabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { workers: "16" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.updateConfig).toHaveBeenCalledWith({ entries: { workers: "16" } }, undefined);
		const out = res.structuredContent as { changedKeys: string[]; restartRequired: string[] };
		expect(out.changedKeys).toEqual(["workers"]);
		expect(out.restartRequired).toEqual([]);
	});

	/*
	 * The allowlist checks the host a request names, never the proxy it leaves
	 * through, so the proxy and trust-anchor keys get a gate of their own
	 * (#1805). Every key network.cpp seeds under it, plus a casing an engine
	 * key match might accept.
	 */
	test.each([
		"proxyUrl",
		"proxyMode",
		"proxySystemUrl",
		"proxyBypass",
		"customCaCertificates",
		"PROXYURL",
	])("update_engine_config refuses %s without the network gate", async (key) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { workers: "16", [key]: "http://evil.test:8080" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain(key);
		expect(firstText(res)).toMatch(/Network settings/);
		// Refused whole: the ordinary key in the same batch is not applied either.
		expect(client.updateConfig).not.toHaveBeenCalled();
	});

	test("update_engine_config applies proxyUrl with the network gate on", async () => {
		const client = fakeClient();
		const entries = { proxyMode: "manual", proxyUrl: "http://proxy.corp:8080" };
		const res = await dispatchTool(
			"update_engine_config",
			{ entries },
			ctxWith(client, { allowWrites: true, allowNetworkSettings: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.updateConfig).toHaveBeenCalledWith({ entries }, undefined);
	});

	describe("a proxyUrl written back while secrets are withheld (#3549)", () => {
		const network = { allowWrites: true, allowNetworkSettings: true };
		const storedProxy = () =>
			fakeClient({
				getConfig: vi.fn().mockResolvedValue({
					entries: [{ key: "proxyUrl", value: "http://alice:pw@proxy.corp:8080" }],
				}),
			});

		// Mutation check: send `entries` to `updateConfig` instead of the
		// restored batch, and the stored password is gone.
		test("keeps the stored credentials of the address the read showed", async () => {
			const client = storedProxy();
			const res = await dispatchTool(
				"update_engine_config",
				{ entries: { proxyMode: "manual", proxyUrl: "http://proxy.corp:8080" } },
				ctxWith(client, network)
			);
			expect(res.isError).toBeFalsy();
			expect(client.updateConfig).toHaveBeenCalledWith(
				{ entries: { proxyMode: "manual", proxyUrl: "http://alice:pw@proxy.corp:8080" } },
				undefined
			);
			expect((res.structuredContent as { changedKeys: string[] }).changedKeys).toEqual([
				"proxyMode",
				"proxyUrl",
			]);
			expect(res.content[res.content.length - 1].text).toMatch(
				/^proxyUrl kept the user:password of its stored value/
			);
		});

		test("another address is written as given", async () => {
			const client = storedProxy();
			const res = await dispatchTool(
				"update_engine_config",
				{ entries: { proxyUrl: "http://other.corp:8080" } },
				ctxWith(client, network)
			);
			expect(res.isError).toBeFalsy();
			expect(client.updateConfig).toHaveBeenCalledWith(
				{ entries: { proxyUrl: "http://other.corp:8080" } },
				undefined
			);
			expect(res.content).toHaveLength(1);
		});

		test("with reveal on, the value is written as given and read only for the restart check", async () => {
			const client = storedProxy();
			await dispatchTool(
				"update_engine_config",
				{ entries: { proxyUrl: "http://proxy.corp:8080" } },
				ctxWith(client, { ...network, revealSecretsToAgents: true })
			);
			expect(client.updateConfig).toHaveBeenCalledWith(
				{ entries: { proxyUrl: "http://proxy.corp:8080" } },
				undefined
			);
			expect(client.getConfig).toHaveBeenCalledTimes(1);
		});

		test("a failed read writes nothing", async () => {
			const client = fakeClient({
				getConfig: vi.fn().mockRejectedValue(new Error("fetch failed")),
			});
			const res = await dispatchTool(
				"update_engine_config",
				{ entries: { proxyUrl: "http://proxy.corp:8080" } },
				ctxWith(client, network)
			);
			expect(res.isError).toBe(true);
			expect(client.updateConfig).not.toHaveBeenCalled();
		});
	});

	test("the network gate grants nothing without write access", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { proxyUrl: "http://proxy.corp:8080" } },
			ctxWith(client, { allowNetworkSettings: true })
		);
		expect(res.isError).toBe(true);
		expect(client.updateConfig).not.toHaveBeenCalled();
	});

	test("update_engine_config flags restart-required keys from the engine's read-back", async () => {
		const client = fakeClient({
			getConfig: vi.fn().mockResolvedValue({
				entries: [
					// A key the engine really does read once, when it opens the
					// database. `workers` used to stand here and stopped being
					// restart-gated in #873 - the run reads it - so the example
					// moved rather than teaching the next reader the old claim.
					{
						key: "dbCacheSize",
						value: "67108864",
						label: "Database Cache Size",
						requiresRestart: true,
					},
					{
						key: "timeoutMs",
						value: "5000",
						label: "Request timeout",
						requiresRestart: false,
					},
				],
			}),
		});
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { dbCacheSize: "67108864", timeoutMs: "5000" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const out = res.structuredContent as { changedKeys: string[]; restartRequired: string[] };
		expect(out.changedKeys.sort()).toEqual(["dbCacheSize", "timeoutMs"]);
		expect(out.restartRequired).toEqual(["dbCacheSize"]);
		// The human-readable text warns about the restart.
		expect(firstText(res)).toMatch(/restart required/i);
	});
});
