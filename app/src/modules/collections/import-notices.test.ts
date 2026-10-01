/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The words and tiers an import preview uses (`import-notices.ts`). The
 * rendering is `ImportModal.notices.test.tsx`; this file holds the rules a
 * rendered preview would need a fixture per case to show.
 */

import { describe, it, expect } from "vitest";

import type { ImportMeta, RequestDraft } from "@/services/importers/types";
import { bodiesWithoutFileNotice, fileReferenceNeeds, importNotices } from "./import-notices";
import { collection, request, result } from "./import-preview.testkit";

function meta(overrides: Partial<ImportMeta> = {}): ImportMeta {
	return {
		format: "OpenAPI 3.0",
		requestCount: 0,
		folderCount: 0,
		environmentCount: 0,
		globalCount: 0,
		exampleCount: 0,
		skipped: [],
		nonExecutableAuth: 0,
		unattachedFileParts: 0,
		...overrides,
	};
}

describe("importNotices", () => {
	it("names up to three requests, then says how many more", () => {
		const [notice] = importNotices(
			meta({
				skipped: [
					{
						kind: "cookie_param",
						count: 5,
						requests: ["A", "B", "C", "D", "E"],
					},
				],
			})
		);
		expect(notice).toEqual({
			tier: "action",
			text: "5 requests: cookie not imported - add it as a Cookie header - A, B, C, +2 more",
		});
	});

	it("drops a summary's closing period before the colon", () => {
		const [notice] = importNotices(
			meta({
				skipped: [{ kind: "unmapped_body", count: 1, requests: ["Uploads an image."] }],
			})
		);
		expect(notice.text).toBe("Uploads an image: body not imported (binary file)");
	});

	it("names the requests whose auth will not be sent", () => {
		expect(
			importNotices(meta({ nonExecutableAuth: 1, nonExecutableAuthRequests: ["Sign in"] }))
		).toEqual([
			{
				tier: "action",
				text: "Sign in: auth imported but not sent (Vayu does not sign AWS, Digest, NTLM, Hawk, OAuth 1, EdgeGrid or JWT)",
			},
		]);
	});

	it("falls back to the count when the engine named no request", () => {
		expect(importNotices(meta({ skipped: [{ kind: "unmapped_body", count: 2 }] }))).toEqual([
			{ tier: "action", text: "2 request bodies not imported (binary file)" },
		]);
	});

	it("shows nothing for what changes nothing the user sends", () => {
		const notices = importNotices(
			meta({
				skipped: [
					{ kind: "default_response", count: 19 },
					{ kind: "deprecated_operation", count: 1 },
					{ kind: "url_without_raw", count: 2 },
					{ kind: "Timer_disabled", count: 3 },
				],
				folderStrategy: "mixed",
			})
		);
		expect(notices).toEqual([]);
	});

	it("lists what the user must finish before what the import decided", () => {
		const notices = importNotices(
			meta({
				skipped: [
					{ kind: "servers_dropped", count: 1 },
					{ kind: "websocket", count: 1 },
				],
				unattachedFileParts: 2,
				folderStrategy: "paths",
			})
		);
		expect(notices.map((n) => n.tier)).toEqual(["action", "action", "note", "note"]);
		expect(notices.map((n) => n.text)).toEqual([
			"1 WebSocket request not imported",
			"2 file fields need files",
			"1 other server URL ignored - only the first is used",
			"Collections grouped by URL path (the spec has no tags)",
		]);
	});

	it("gives a JMeter class it has no words for a readable line, never a slug", () => {
		const texts = importNotices(
			meta({
				skipped: [
					{ kind: "IfController_unrecognised", count: 1 },
					{ kind: "assert.status_unmappable", count: 2 },
					{ kind: "ResultCollector", count: 3 },
				],
			})
		).map((n) => n.text);
		expect(texts).toEqual([
			"2 assert.status elements dropped (invalid)",
			"1 IfController not imported",
			"3 ResultCollector not imported",
		]);
	});

	it("says a Postman protocol setting is kept, not dropped, now that cookies, headers and encoding apply (#1765)", () => {
		// The engine counts only what it stores without applying (TLS options,
		// a Host / Content-Length opt-out), so the line must not name cookies or
		// URL encoding as missing: those three are honoured on Send.
		const texts = importNotices(
			meta({ skipped: [{ kind: "protocol_behavior", count: 2 }] })
		).map((n) => n.text);
		expect(texts).toEqual([
			"2 requests' Postman settings kept but not applied (e.g. TLS options, Host header)",
		]);
	});
});

describe("fileReferenceNeeds", () => {
	function binary(src: string, unresolved = true): RequestDraft {
		return request({ body: { mode: "binary", file: { src, unresolved } } });
	}
	function formFile(src: string, unresolved = true): RequestDraft {
		return request({
			body: {
				mode: "form-data",
				fields: [
					{ key: "caption", value: "hi", enabled: true },
					{ key: "file", value: "", enabled: true, type: "file", src, unresolved },
				],
			},
		});
	}

	it("groups unresolved binary and form-part paths by their folder", () => {
		const needs = fileReferenceNeeds([
			result({
				collections: [
					collection({
						requests: [binary("/data/a.bin"), formFile("/data/b.png")],
						children: [collection({ requests: [binary("C:\\up\\c.bin")] })],
					}),
				],
			}),
		]);

		expect(needs.folders).toEqual([
			{ folder: "/data", count: 2 },
			{ folder: "C:\\up", count: 1 },
		]);
		expect(needs.bodiesWithoutFile).toBe(0);
	});

	it("leaves out paths someone chose, and folders that are still a variable", () => {
		const needs = fileReferenceNeeds([
			result({
				collections: [
					collection({
						requests: [
							binary("/mine/a.bin", false),
							formFile("{{dir}}/b.png"),
							binary("a.bin"),
						],
					}),
				],
			}),
		]);

		expect(needs.folders).toEqual([]);
	});

	it("counts across every file of a batch, once per folder", () => {
		const one = result({ collections: [collection({ requests: [binary("/data/a.bin")] })] });
		const two = result({ collections: [collection({ requests: [binary("/data/b.bin")] })] });

		expect(fileReferenceNeeds([one, two]).folders).toEqual([{ folder: "/data", count: 2 }]);
	});

	it("counts binary bodies that arrived with no file at all", () => {
		const needs = fileReferenceNeeds([
			result({ collections: [collection({ requests: [binary(""), binary("  ")] })] }),
		]);

		expect(needs.bodiesWithoutFile).toBe(2);
		expect(bodiesWithoutFileNotice(needs.bodiesWithoutFile)).toEqual({
			tier: "action",
			text: "2 file bodies need files",
		});
		expect(bodiesWithoutFileNotice(0)).toBeNull();
	});
});
