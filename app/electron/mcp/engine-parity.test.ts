/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The four tools that close the gaps between the engine's routes and the MCP
 * surface: a connection diagnosis, the client-certificate registry, and the two
 * previews (an import, a spec bind) the app shows before it writes.
 */

import { describe, expect, test, vi } from "vitest";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import type { EngineClient } from "./engine-client.js";
import { TOOLS, dispatchTool, type ToolContext } from "./tools.js";

function ctxWith(
	client: Partial<Record<keyof EngineClient, unknown>>,
	safety: Partial<McpSafetyConfig> = {}
): ToolContext {
	return { client: client as unknown as EngineClient, config: resolveSafetyConfig(safety) };
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");
const body = (r: { content: Array<{ text: string }> }) =>
	JSON.parse(r.content[0].text) as Record<string, unknown>;
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

describe("diagnose_connection", () => {
	test("refuses a host off the allowlist without sending anything", async () => {
		const diagnoseConnection = vi.fn();
		const result = await dispatchTool(
			"diagnose_connection",
			{ url: "https://api.example.com/" },
			ctxWith({ diagnoseConnection })
		);
		expect(result.isError).toBe(true);
		expect(diagnoseConnection).not.toHaveBeenCalled();
	});

	test("tests an allowed URL and names the setting its outcome points at", async () => {
		const diagnoseConnection = vi.fn().mockResolvedValue({
			url: "https://api.example.com/",
			outcome: "tls_failed",
			errorCode: "SSL_ERROR",
			detail: "handshake failure",
			proxy: { mode: "none" },
			clientCertificate: "",
		});
		const result = await dispatchTool(
			"diagnose_connection",
			{ url: "https://api.example.com/" },
			ctxWith({ diagnoseConnection }, { allowlist: ["api.example.com"] })
		);
		expect(diagnoseConnection).toHaveBeenCalledWith("https://api.example.com/", undefined);
		expect(body(result).outcome).toBe("tls_failed");
		expect(text(result)).toContain("list_client_certificates");
	});

	test("is an execute tool, since it sends a request to the host", () => {
		expect(tool("diagnose_connection").category).toBe("execute");
	});
});

describe("list_client_certificates", () => {
	test("is a read tool that answers the registry as the engine does", async () => {
		const rows = [{ id: "cert_1", host: "api.example.com", port: null, hasPassphrase: true }];
		const result = await dispatchTool(
			"list_client_certificates",
			{},
			ctxWith({ listClientCertificates: vi.fn().mockResolvedValue(rows) })
		);
		expect(tool("list_client_certificates").category).toBe("read");
		expect(JSON.parse(result.content[0].text)).toEqual(rows);
	});
});

describe("preview_import", () => {
	const TREE = {
		collections: [
			{
				name: "Pets",
				requests: [{ name: "Health", body: "x".repeat(10) }],
				children: [
					{ name: "pets", requests: [{ name: "List" }, { name: "Get" }], children: [] },
				],
			},
		],
		environments: [{ name: "Staging" }],
		globals: { token: "t" },
		clientCertificates: [],
		meta: {
			format: "OpenAPI 3.0",
			requestCount: 3,
			folderCount: 1,
			environmentCount: 1,
			skipped: [{ kind: "cookie_param", count: 1, requests: ["List"] }],
		},
	};

	test("asks the engine exactly what import_document would, and stores nothing", async () => {
		const args = { content: "{}", importScripts: false, fileName: "pets.json" };
		const parseImport = vi.fn().mockResolvedValue(TREE);
		const importDocument = vi.fn().mockResolvedValue({});
		// Writes off: a preview must still answer, since it is how an agent
		// decides whether to ask for writes at all.
		const preview = await dispatchTool(
			"preview_import",
			args,
			ctxWith({ parseImport, importDocument })
		);
		await dispatchTool(
			"import_document",
			args,
			ctxWith({ parseImport, importDocument }, { allowWrites: true })
		);
		expect(preview.isError).toBeFalsy();
		// Mutation check: build either payload differently and this fails.
		expect(parseImport.mock.calls[0][0]).toEqual(importDocument.mock.calls[0][0]);
		expect(importDocument).toHaveBeenCalledTimes(1);
	});

	test("summarizes the tree - counts and names, never the requests themselves", async () => {
		const result = await dispatchTool(
			"preview_import",
			{ content: "{}" },
			ctxWith({ parseImport: vi.fn().mockResolvedValue(TREE) })
		);
		expect(body(result)).toEqual({
			collections: [{ name: "Pets", folders: 1, requests: 3 }],
			environments: ["Staging"],
			globals: 1,
			clientCertificates: 0,
			meta: TREE.meta,
		});
		expect(text(result)).toContain("Nothing was stored");
		expect(text(result)).toContain("1 cookie_param");
	});
});

describe("preview_spec_bind", () => {
	const OPERATIONS = [
		{ operationId: "listPets", method: "GET", path: "/pets" },
		{ method: "DELETE", path: "/pets/{id}" },
	];

	function client() {
		return {
			describeSpec: vi.fn().mockResolvedValue({
				format: "OpenAPI 3.0",
				title: "Pets",
				operations: OPERATIONS,
			}),
			matchSpec: vi.fn().mockResolvedValue({
				matched: [{ requestId: "req_list", operation: OPERATIONS[0] }],
				unmatchedRequests: ["req_old", "req_new"],
				unmatchedOperations: [OPERATIONS[1]],
			}),
			listCollections: vi.fn().mockResolvedValue([
				{ id: "col_root", parentId: null },
				{ id: "col_tag", parentId: "col_root" },
				{ id: "col_other", parentId: null },
			]),
			listRequests: vi.fn().mockImplementation((id: string) =>
				Promise.resolve(
					id === "col_root"
						? [{ id: "req_list", name: "List", specOperation: OPERATIONS[0] }]
						: id === "col_tag"
							? [
									// Stamped by a previous document: a bind clears it.
									{
										id: "req_old",
										name: "Old",
										specOperation: { method: "GET", path: "/cats" },
									},
									// Never stamped: unmatched, but nothing to clear.
									{ id: "req_new", name: "New", specOperation: null },
								]
							: []
				)
			),
			bindSpec: vi.fn(),
		};
	}

	test("matches the operations the engine read, and names what a bind would clear", async () => {
		const c = client();
		const result = await dispatchTool(
			"preview_spec_bind",
			{ collectionId: "col_root", content: "openapi: 3.0.0" },
			ctxWith(c)
		);
		expect(c.matchSpec).toHaveBeenCalledWith(
			{ collectionId: "col_root", operations: OPERATIONS },
			undefined
		);
		// The whole subtree, and nothing outside it.
		expect(c.listRequests.mock.calls.map((call) => call[0]).sort()).toEqual([
			"col_root",
			"col_tag",
		]);
		const preview = body(result);
		expect(preview.matched).toBe(1);
		// Mutation check: drop the specOperation filter and req_new is listed too.
		expect(preview.wouldClear).toEqual({
			count: 1,
			requests: [{ id: "req_old", name: "Old" }],
		});
		expect(preview.unmatchedRequests).toMatchObject({ count: 2 });
		expect(preview.unmatchedOperations).toEqual({ count: 1, operations: [OPERATIONS[1]] });
		expect(text(result)).toContain("clear identity from 1 request");
		expect(c.bindSpec).not.toHaveBeenCalled();
	});

	test("both previews are read tools, answered with writes off", () => {
		expect(tool("preview_spec_bind").category).toBe("read");
		expect(tool("preview_import").category).toBe("read");
		expect(tool("preview_spec_bind").annotations.readOnlyHint).toBe(true);
	});
});
