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

import type { ImportMeta } from "@/services/importers/types";
import { importNotices } from "./import-notices";

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
			text: "5 requests: cookie not imported - add it to the cookie jar - A, B, C, +2 more",
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
				text: "Sign in: auth imported but not sent (AWS, Digest and NTLM are not supported)",
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
					{ kind: "path_variables", count: 2 },
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
			"Folders grouped by URL path (the spec has no tags)",
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
});
