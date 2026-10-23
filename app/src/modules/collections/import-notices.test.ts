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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import type {
	CollectionDraft,
	ImportMeta,
	RequestDraft,
	SkippedItem,
} from "@/services/importers/types";
import {
	bodiesWithoutFileNotice,
	describeCarriedOver,
	describeCounts,
	fileReferenceNeeds,
	importNotices,
} from "./import-notices";
import { stubNumberLocale } from "@/test/number-locale";
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

describe("describeCounts", () => {
	let restoreLocale: () => void;
	beforeEach(() => {
		restoreLocale = stubNumberLocale("en-US");
	});
	afterEach(() => restoreLocale());

	const cases: [string, Partial<ImportMeta>, string][] = [
		[
			"a Postman collection names no environments or globals",
			{ requestCount: 1, folderCount: 3 },
			"1 request · 3 nested collections · 0 examples",
		],
		[
			"singular and plural per segment",
			{ requestCount: 2, folderCount: 1, exampleCount: 1 },
			"2 requests · 1 nested collection · 1 example",
		],
		[
			"zero examples stays an answer",
			{ requestCount: 5, folderCount: 0, exampleCount: 0 },
			"5 requests · 0 nested collections · 0 examples",
		],
		[
			"counts get thousands separators",
			{ requestCount: 1200, folderCount: 2 },
			"1,200 requests · 2 nested collections · 0 examples",
		],
		[
			"a collection that also carries environments names them",
			{ requestCount: 1, environmentCount: 2, globalCount: 1 },
			"1 request · 0 nested collections · 0 examples · 2 environments · 1 global",
		],
		["an environment file is only its environment", { environmentCount: 1 }, "1 environment"],
		["a globals file is only its globals", { globalCount: 4 }, "4 globals"],
		[
			"a file with both scopes names both",
			{ environmentCount: 2, globalCount: 1 },
			"2 environments · 1 global",
		],
		[
			"an environment file parsed with environments off has nothing to import",
			{},
			"0 requests · 0 nested collections · 0 examples",
		],
		[
			"a file of only nested collections is not an environment file",
			{ folderCount: 1, environmentCount: 1 },
			"0 requests · 1 nested collection · 0 examples · 1 environment",
		],
	];

	it.each(cases)("%s", (_name, counts, expected) => {
		expect(describeCounts(meta(counts))).toBe(expected);
	});

	it("never calls a nested collection a folder", () => {
		const line = describeCounts(meta({ requestCount: 1, folderCount: 3 }));
		expect(line).toContain("nested collection");
		expect(line).not.toMatch(/folder/i);
	});
});

describe("importNotices - a branch past the depth bound", () => {
	it("says how many branches were left out, as something to finish", () => {
		const notices = importNotices(meta({ skipped: [{ kind: "nesting_too_deep", count: 2 }] }));
		expect(notices).toEqual([
			{ tier: "action", text: "2 branches nested too deeply (over 100 levels) and left out" },
		]);
	});
});

describe("importNotices - what the $ref bundling refused and fetched", () => {
	it("names each refused reference as an action and lists the fetched hosts as a note", () => {
		const notices = importNotices(
			meta({
				refReport: {
					fetched: ["https://a.dev/x.json", "https://b.dev/y.json"],
					refused: [
						{
							target: "../../secret.json",
							reason: "outside the folder that was picked",
						},
					],
				},
			})
		);
		expect(notices).toContainEqual({
			tier: "action",
			text: "Reference not followed: ../../secret.json (outside the folder that was picked)",
		});
		expect(notices).toContainEqual({
			tier: "note",
			text: "Fetched from: https://a.dev/x.json, https://b.dev/y.json",
		});
	});

	it("prints an engine reason as the engine wrote it", () => {
		const notices = importNotices(
			meta({
				refReport: {
					fetched: [],
					refused: [
						{
							target: "https://cdn.acme.dev/c.json",
							reason: "The server answered HTTP 302",
						},
					],
				},
			})
		);
		expect(notices).toEqual([
			{
				tier: "action",
				text: "Reference not followed: https://cdn.acme.dev/c.json (The server answered HTTP 302)",
			},
		]);
	});

	it("says nothing when nothing was fetched or refused", () => {
		expect(importNotices(meta({ refReport: { fetched: [], refused: [] } }))).toEqual([]);
		expect(importNotices(meta())).toEqual([]);
	});
});

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
		expect(notice.text).toBe("Uploads an image: body not imported (unsupported media type)");
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

	describe("where the unsent auth is declared (#2537)", () => {
		const PHRASE =
			"auth imported but not sent (Vayu does not sign AWS, Digest, NTLM, Hawk, OAuth 1, EdgeGrid or JWT)";
		const authNotice = (overrides: Partial<ImportMeta>) =>
			importNotices(meta({ nonExecutableAuth: 2, ...overrides })).map((n) => n.text);

		it("names the declaring folders after the request names", () => {
			expect(
				authNotice({
					nonExecutableAuthRequests: ["Block a user ID", "Mute a user ID"],
					nonExecutableAuthFolders: ["Blocks", "Mutes"],
				})
			).toEqual([
				`2 requests: ${PHRASE} - Block a user ID, Mute a user ID; set on folders Blocks, Mutes`,
			]);
		});

		it("says folder, singular, for one declaring folder", () => {
			expect(
				authNotice({
					nonExecutableAuth: 1,
					nonExecutableAuthRequests: ["Sign in"],
					nonExecutableAuthFolders: ["Admin"],
				})
			).toEqual([`Sign in: ${PHRASE}; set on folder Admin`]);
		});

		it("says the collection when the root declares it", () => {
			expect(
				authNotice({
					nonExecutableAuthRequests: ["A", "B"],
					nonExecutableAuthCollection: "Twitter API",
				})
			).toEqual([`2 requests: ${PHRASE} - A, B; set on the collection`]);
		});

		it("names the collection and the folders in one clause", () => {
			expect(
				authNotice({
					nonExecutableAuthRequests: ["A", "B"],
					nonExecutableAuthCollection: "Twitter API",
					nonExecutableAuthFolders: ["Blocks", "Lists"],
				})
			).toEqual([
				`2 requests: ${PHRASE} - A, B; set on the collection and folders Blocks, Lists`,
			]);
		});

		it("cuts a long folder list short with how many were left out", () => {
			const folders = ["F1", "F2", "F3", "F4", "F5", "F6", "F7"];
			expect(
				authNotice({
					nonExecutableAuthRequests: ["A", "B"],
					nonExecutableAuthFolders: folders,
				})
			).toEqual([`2 requests: ${PHRASE} - A, B; set on folders F1, F2, F3, F4, F5, +2 more`]);
		});

		it("lists the first three requests and counts the rest beside the folder clause", () => {
			const requests = Array.from({ length: 23 }, (_, i) => `R${i + 1}`);
			expect(
				authNotice({
					nonExecutableAuth: 23,
					nonExecutableAuthRequests: requests,
					nonExecutableAuthFolders: ["Blocks", "Manage Tweets", "Mutes", "Lists"],
				})
			).toEqual([
				`23 requests: ${PHRASE} - R1, R2, R3, +20 more; set on folders Blocks, Manage Tweets, Mutes, Lists`,
			]);
		});

		it("keeps the clause on the count-only line, when no request is named", () => {
			expect(
				authNotice({ nonExecutableAuth: 4, nonExecutableAuthFolders: ["Blocks"] })
			).toEqual([`4 requests' ${PHRASE}; set on folder Blocks`]);
		});

		it("leaves the line as it was when no site is named", () => {
			expect(authNotice({ nonExecutableAuthRequests: ["A", "B"] })).toEqual([
				`2 requests: ${PHRASE} - A, B`,
			]);
			expect(authNotice({ nonExecutableAuth: 3 })).toEqual([`3 requests' ${PHRASE}`]);
		});

		it("shows nothing when no request loses its auth, whatever declares it", () => {
			expect(
				authNotice({
					nonExecutableAuth: 0,
					nonExecutableAuthFolders: ["Unused"],
					nonExecutableAuthCollection: "Twitter API",
				})
			).toEqual([]);
		});
	});

	describe("scripts that use an API Vayu does not run (#2576)", () => {
		const scriptApis = (entries: { request: string; names: string[] }[]) =>
			importNotices(meta({ unsupportedScriptApis: entries }));

		it("names the one request and its APIs, as an action", () => {
			expect(scriptApis([{ request: "Sign in", names: ["require()", "CryptoJS"] }])).toEqual([
				{
					tier: "action",
					text: "Sign in: script uses APIs Vayu does not run yet (require(), CryptoJS)",
					link: { label: "See what Vayu supports", key: "pmApiCompatibility" },
				},
			]);
		});

		it("counts and names several requests, with the APIs as a deduplicated union", () => {
			expect(
				scriptApis([
					{ request: "Sign in", names: ["require()", "CryptoJS"] },
					{ request: "List users", names: ["require()"] },
				])
			).toEqual([
				{
					tier: "action",
					text: "2 requests: script uses APIs Vayu does not run yet (require(), CryptoJS) - Sign in, List users",
					link: { label: "See what Vayu supports", key: "pmApiCompatibility" },
				},
			]);
		});

		it("cuts both lists short with how many were left out", () => {
			const [notice] = scriptApis([
				{
					request: "A",
					names: ["require()", "CryptoJS", "_", "Buffer", "cheerio"],
				},
				{ request: "B", names: ["moment"] },
				{ request: "C", names: [] },
				{ request: "D", names: [] },
				{ request: "E", names: [] },
			]);
			expect(notice.text).toBe(
				"5 requests: script uses APIs Vayu does not run yet (require(), CryptoJS, _, Buffer, +2 more) - A, B, C, +2 more"
			);
		});

		it("drops the parentheses when an entry names no API", () => {
			expect(scriptApis([{ request: "Sign in", names: [] }])[0].text).toBe(
				"Sign in: script uses APIs Vayu does not run yet"
			);
		});

		it("says nothing when the member is absent or empty", () => {
			expect(importNotices(meta())).toEqual([]);
			expect(scriptApis([])).toEqual([]);
		});

		it("is the only notice that carries a link", () => {
			const notices = importNotices(
				meta({
					skipped: [
						{ kind: "unmapped_body", count: 1 },
						{ kind: "proxy_config", count: 1 },
					],
					unsupportedScriptApis: [{ request: "Sign in", names: ["require()"] }],
				})
			);
			expect(notices).toHaveLength(3);
			expect(notices.filter((n) => n.link).map((n) => n.link?.key)).toEqual([
				"pmApiCompatibility",
			]);
		});

		it("sits among the other actions, ahead of the notes", () => {
			const notices = importNotices(
				meta({
					skipped: [{ kind: "proxy_config", count: 1 }],
					unsupportedScriptApis: [{ request: "Sign in", names: ["require()"] }],
				})
			);
			expect(notices.map((n) => n.tier)).toEqual(["action", "note"]);
		});
	});

	it("falls back to the count when the engine named no request", () => {
		expect(importNotices(meta({ skipped: [{ kind: "unmapped_body", count: 2 }] }))).toEqual([
			{ tier: "action", text: "2 request bodies not imported (unsupported media type)" },
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

	it("names the folder or collection that declared a setting Vayu cannot apply (#2538)", () => {
		const texts = (item: SkippedItem) =>
			importNotices(meta({ skipped: [item] })).map((n) => n.text);
		expect(texts({ kind: "protocol_behavior_folder", count: 1, names: ["Payments"] })).toEqual([
			"1 folder or collection has a Postman setting Vayu does not apply or carry (e.g. TLS options) (Payments)",
		]);
		expect(
			texts({
				kind: "protocol_behavior_folder",
				count: 2,
				names: ["Payments", "Billing"],
			})
		).toEqual([
			"2 folders or collections have Postman settings Vayu does not apply or carry (e.g. TLS options) (Payments, Billing)",
		]);
	});
});

describe("importNotices - a body on a GET or HEAD (#2540)", () => {
	const texts = (item: SkippedItem) => importNotices(meta({ skipped: [item] }));

	it("names the request and tells the user to clear the body, as an action", () => {
		expect(texts({ kind: "body_on_get", count: 1, requests: ["201"] })).toEqual([
			{
				tier: "action",
				text: "201: GET or HEAD body kept - Postman does not send it, Vayu will; clear the body to match",
			},
		]);
	});

	it("lists several requests under one count", () => {
		expect(
			texts({ kind: "body_on_get", count: 2, requests: ["Find", "Probe"] }).map((n) => n.text)
		).toEqual([
			"2 requests: GET or HEAD body kept - Postman does not send it, Vayu will; clear the body to match - Find, Probe",
		]);
	});

	it("falls back to the count form when the engine named no request", () => {
		expect(texts({ kind: "body_on_get", count: 1 }).map((n) => n.text)).toEqual([
			"1 GET or HEAD body kept - Postman does not send it, Vayu will; clear it to match",
		]);
		expect(texts({ kind: "body_on_get", count: 3 }).map((n) => n.text)).toEqual([
			"3 GET or HEAD bodies kept - Postman does not send them, Vayu will; clear them to match",
		]);
	});
});

describe("importNotices - a Postman OAuth 2.0 block (#2536)", () => {
	it("tells the user a saved token was not imported, naming the request, as a note", () => {
		expect(
			importNotices(
				meta({
					skipped: [{ kind: "oauth2_dropped_field", count: 1, requests: ["Sign in"] }],
				})
			)
		).toEqual([
			{
				tier: "note",
				text: "Sign in: saved OAuth 2.0 token not imported - Vayu fetches a new one through the grant",
			},
		]);
	});

	it("counts saved tokens when the engine named no request", () => {
		expect(
			importNotices(meta({ skipped: [{ kind: "oauth2_dropped_field", count: 3 }] }))[0].text
		).toBe("3 saved OAuth 2.0 tokens not imported - Vayu fetches new ones through the grant");
	});

	it("says nothing about a regenerated state: nothing sent changes", () => {
		expect(
			importNotices(meta({ skipped: [{ kind: "oauth2_state_regenerated", count: 2 }] }))
		).toEqual([]);
	});

	it("names the parameters not imported as something to finish, keys only", () => {
		expect(
			importNotices(
				meta({
					skipped: [
						{
							kind: "oauth2_unmapped_param",
							count: 2,
							requests: ["Sign in"],
							names: ["acr_values", "scope"],
						},
					],
				})
			)
		).toEqual([
			{
				tier: "action",
				text: "Sign in: OAuth 2.0 request parameter not imported (acr_values, scope) - Vayu sets some itself and cannot place the rest",
			},
		]);
	});

	it("caps the parameter names, and names the requests beside them", () => {
		const [notice] = importNotices(
			meta({
				skipped: [
					{
						kind: "oauth2_unmapped_param",
						count: 5,
						requests: ["A", "B"],
						names: ["a", "b", "c", "d", "e"],
					},
				],
			})
		);
		expect(notice.text).toBe(
			"2 requests: OAuth 2.0 request parameter not imported (a, b, c, +2 more) - Vayu sets some itself and cannot place the rest - A, B"
		);
	});

	it("counts parameters when no request or key was named, as a row with no key leaves neither", () => {
		const text = (count: number) =>
			importNotices(meta({ skipped: [{ kind: "oauth2_unmapped_param", count }] }))[0].text;
		expect(text(1)).toBe(
			"1 OAuth 2.0 request parameter not imported - Vayu sets some itself and cannot place the rest"
		);
		expect(text(4)).toBe(
			"4 OAuth 2.0 request parameters not imported - Vayu sets some itself and cannot place the rest"
		);
	});
});

describe("importNotices - a Postman script Vayu cannot import (#2541)", () => {
	const reason = "(loaded from a URL, or on an event Vayu has no phase for)";
	const notice = (item: Partial<SkippedItem>) =>
		importNotices(meta({ skipped: [{ kind: "script_unsupported", count: 1, ...item }] }))[0];

	it("names the one owner and says what to do, as something to finish", () => {
		expect(notice({ requests: ["Login"] })).toEqual({
			tier: "action",
			text: `Login: script not imported ${reason} - add it as a pre-request or test script`,
		});
	});

	it("counts scripts when the engine named no owner", () => {
		expect(notice({}).text).toBe(
			`1 script not imported ${reason} - add it as a pre-request or test script`
		);
		expect(notice({ count: 4 }).text).toBe(
			`4 scripts not imported ${reason} - add them as pre-request or test scripts`
		);
	});

	it("counts the owners as items, never requests: a folder or the collection can declare one", () => {
		const { text } = notice({
			count: 5,
			requests: ["Login", "Auth", "Pets", "Shop", "My collection"],
		});
		expect(text).toBe(
			`5 items: script not imported ${reason} - add it as a pre-request or test script - Login, Auth, Pets, +2 more`
		);
		expect(text).not.toContain("requests:");
	});
});

describe("the closed set of skipped kinds", () => {
	/** The string literals of `SkippedItem["kind"]` before its open JMeter tail. */
	function declaredKinds(): string[] {
		const source = readFileSync(join(__dirname, "../../services/importers/types.ts"), "utf8");
		const start = source.indexOf("export interface SkippedItem");
		const open = source.indexOf("(string & Record<never, never>)", start);
		return [...source.slice(start, open).matchAll(/^\s*\| "([^"]+)"/gm)].map((m) => m[1]);
	}

	it("has words, or a deliberate silence, for every kind", () => {
		const kinds = declaredKinds();
		// A scan over an empty read passes forever (the regexp and the path are
		// both ways to read nothing).
		expect(kinds.length).toBeGreaterThan(30);
		expect(kinds).toContain("oauth2_unmapped_param");
		const unworded = kinds.filter((kind) => {
			const [notice] = importNotices(meta({ skipped: [{ kind, count: 1 }] }));
			return notice !== undefined && notice.text === `1 ${kind} not imported`;
		});
		expect(unworded).toEqual([]);
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

	it("groups the paths the parse answered unresolved by their folder", () => {
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

	it("leaves out paths the engine would send, and folders that are still a variable", () => {
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

describe("describeCarriedOver", () => {
	let restoreLocale: () => void;
	beforeEach(() => {
		restoreLocale = stubNumberLocale("en-US");
	});
	afterEach(() => restoreLocale());

	const vars = (...keys: string[]) =>
		Object.fromEntries(keys.map((key) => [key, { value: "v", enabled: true }]));
	const bearer = () => request({ auth: { mode: "bearer", token: "t" } });
	const script = (kind: string, text: unknown, enabled?: boolean): unknown => ({
		id: "e1",
		kind,
		...(enabled === undefined ? {} : { enabled }),
		config: { script: text },
	});
	const withScripts = (...elements: unknown[]) => request({ elements });
	const describeTree = (root: CollectionDraft) =>
		describeCarriedOver([result({ collections: [root] })]);

	it("says nothing when the drafts carry no variables, auth or scripts", () => {
		const tree = collection({
			requests: [request(), request({ auth: { mode: "none" } })],
			children: [collection({ requests: [request({ auth: { mode: "noauth" } })] })],
		});

		expect(describeTree(tree)).toBe("");
		expect(describeCarriedOver([])).toBe("");
	});

	it("counts variables, authed requests and scripted requests across nested folders", () => {
		const tree = collection({
			variables: vars("baseUrl", "token"),
			requests: [bearer(), withScripts(script("script.pre", "pm.test()"))],
			children: [
				collection({
					variables: vars("page"),
					requests: [bearer(), withScripts(script("script.post", "console.log(1)"))],
					children: [
						collection({
							requests: [
								request({ auth: { mode: "basic", username: "u", password: "p" } }),
								withScripts(
									script("script.pre", "a()"),
									script("script.post", "b()")
								),
							],
						}),
					],
				}),
			],
		});

		expect(describeTree(tree)).toBe(
			"Carried over: 3 variables · auth on 3 requests · scripts on 3 requests"
		);
	});

	it("counts a request with auth once and leaves out none, noauth and inherit", () => {
		const tree = collection({
			requests: [
				request({ auth: { mode: "inherit" } }),
				request({ auth: { mode: "none" } }),
				request({ auth: { mode: "noauth" } }),
				bearer(),
			],
		});

		expect(describeTree(tree)).toBe("Carried over: auth on 1 request");
	});

	it("leaves out disabled and blank scripts, and elements that are not scripts", () => {
		const tree = collection({
			requests: [
				withScripts(script("script.pre", "pm.test()", false)),
				withScripts(script("script.pre", "   \n")),
				withScripts(script("script.post", undefined)),
				withScripts({ id: "a", kind: "assert.status", config: { script: "x" } }),
				withScripts(null, "script.pre", { kind: "script.pre" }),
			],
		});

		expect(describeTree(tree)).toBe("");
	});

	it("counts an element with no enabled flag, and one scripted request once", () => {
		const tree = collection({
			requests: [
				withScripts(script("script.pre", "a()"), script("script.pre", "b()", true)),
				withScripts(script("script.pre", "   ", true), script("script.post", "c()")),
			],
		});

		expect(describeTree(tree)).toBe("Carried over: scripts on 2 requests");
	});

	it("reads a request the engine sent with no elements key", () => {
		const bare: RequestDraft = JSON.parse(
			JSON.stringify({ ...request(), elements: undefined })
		);

		expect("elements" in bare).toBe(false);
		expect(describeTree(collection({ requests: [bare] }))).toBe("");
	});

	it("omits the segments that are zero, and spans every file of a batch", () => {
		const one = result({ collections: [collection({ variables: vars("a") })] });
		const two = result({ collections: [collection({ variables: vars("b", "c") })] });

		expect(describeCarriedOver([one])).toBe("Carried over: 1 variable");
		expect(describeCarriedOver([one, two])).toBe("Carried over: 3 variables");
	});

	it("groups thousands in a count", () => {
		const requests = Array.from({ length: 1200 }, bearer);

		expect(describeTree(collection({ requests }))).toBe("Carried over: auth on 1,200 requests");
	});
});

describe("importNotices - client certificates left unticked (#2363)", () => {
	const certificateLine = (unticked: number, skipped: SkippedItem[] = []) =>
		importNotices(meta({ skipped }), unticked).map((notice) => notice.text);

	it("says nothing when every candidate was ticked", () => {
		expect(certificateLine(0)).toEqual([]);
	});

	it("tallies the unticked ones in the existing certificate line", () => {
		expect(certificateLine(1)).toEqual([
			"1 client certificate not imported - add it in Settings",
		]);
		expect(certificateLine(2)).toEqual([
			"2 client certificates not imported - add them in Settings",
		]);
	});

	it("sums them with the certificates the engine could not resolve", () => {
		expect(certificateLine(2, [{ kind: "certificate", count: 1 }])).toEqual([
			"3 client certificates not imported - add them in Settings",
		]);
	});

	it("leaves the engine's own line, request names and all, when nothing is unticked", () => {
		expect(
			certificateLine(0, [{ kind: "certificate", count: 1, requests: ["Get user"] }])
		).toEqual(["Get user: client certificate not imported - add it in Settings"]);
	});

	it("keeps every other line as it was", () => {
		expect(
			certificateLine(1, [
				{ kind: "proxy_config", count: 1 },
				{ kind: "certificate", count: 1 },
			])
		).toEqual([
			"2 client certificates not imported - add them in Settings",
			"1 per-request proxy setting not imported",
		]);
	});
});
