/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The app scheme answers with files the build shipped and nothing else (#2380).
 *
 * Driven against a real directory, because the refusals that matter are the
 * filesystem's: a symlink that points out of `dist` passes every lexical
 * check. Every refusal below names a file that exists outside `dist`, so a
 * null cannot come from a missing target instead of from the check.
 *
 * Mutation check: drop the `isWithin` containment from `resolveAppFile` and the
 * traversal, absolute-path and symlink cases go red.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_SCHEME_PRIVILEGES, createAppProtocolHandler, resolveAppFile } from "./app-protocol.js";
import { APP_ENTRY_URL, APP_HOST, APP_SCHEME } from "./constants.js";

let tmp: string;
let dist: string;
let outsideSecret: string;
let siblingPackageJson: string;

/** The canonical path of a file under the fixture's `dist`. */
function shipped(...segments: string[]): string {
	return realpathSync(path.join(dist, ...segments));
}

function resolve(urlPath: string): Promise<string | null> {
	return resolveAppFile(`${APP_SCHEME}://${APP_HOST}${urlPath}`, dist);
}

beforeAll(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "vayu-app-protocol-"));
	dist = path.join(tmp, "dist");
	mkdirSync(path.join(dist, "assets", "nested"), { recursive: true });
	writeFileSync(path.join(dist, "index.html"), "<!doctype html>");
	writeFileSync(path.join(dist, "assets", "nested", "chunk.js"), "export {};");
	writeFileSync(path.join(dist, "assets", "a b.js"), "export {};");

	siblingPackageJson = path.join(tmp, "package.json");
	writeFileSync(siblingPackageJson, "{}");
	const outside = path.join(tmp, "outside");
	mkdirSync(outside);
	outsideSecret = path.join(outside, "secret.txt");
	writeFileSync(outsideSecret, "secret");
	// A junction on Windows, which needs no privilege; the type is ignored
	// elsewhere and a plain directory symlink is made.
	symlinkSync(outside, path.join(dist, "escape"), "junction");
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("the fixture", () => {
	it("has files in dist and real targets outside it, so every refusal means something", () => {
		expect(readdirSync(dist).length).toBeGreaterThan(0);
		expect(existsSync(path.join(dist, "index.html"))).toBe(true);
		expect(existsSync(siblingPackageJson)).toBe(true);
		// The symlink resolves: reading through it lexically reaches the secret.
		expect(readFileSync(path.join(dist, "escape", "secret.txt"), "utf8")).toBe("secret");
	});
});

describe("resolveAppFile serves what the build shipped", () => {
	it("answers / with the entry document", async () => {
		expect(await resolve("/")).toBe(shipped("index.html"));
	});

	it("answers the entry URL the window loads", async () => {
		expect(await resolveAppFile(APP_ENTRY_URL, dist)).toBe(shipped("index.html"));
	});

	it("answers a nested asset", async () => {
		expect(await resolve("/assets/nested/chunk.js")).toBe(
			shipped("assets", "nested", "chunk.js")
		);
	});

	it("decodes a percent-encoded name", async () => {
		expect(await resolve("/assets/a%20b.js")).toBe(shipped("assets", "a b.js"));
	});

	it("ignores a query and a hash", async () => {
		expect(await resolve("/index.html?v=1#/collections/1")).toBe(shipped("index.html"));
	});
});

describe("resolveAppFile refuses everything else", () => {
	it.each([
		"/../package.json",
		"/%2e%2e/package.json",
		"/..%2fpackage.json",
		"/%2e%2e%2fpackage.json",
		"/assets/..%2f..%2fpackage.json",
	])("refuses the traversal %s", async (urlPath) => {
		expect(await resolve(urlPath)).toBeNull();
	});

	it("refuses an absolute path", async () => {
		expect(await resolve("//etc/passwd")).toBeNull();
		// The same shape naming a file that does exist, so the refusal is the
		// check's and not a missing file's. On Windows this is `/C:/...`.
		const absolute = outsideSecret.split(path.sep).join("/");
		expect(await resolve(`/${encodeURI(absolute)}`)).toBeNull();
	});

	it("refuses a symlink inside dist that resolves outside it", async () => {
		expect(await resolve("/escape/secret.txt")).toBeNull();
	});

	it("refuses a missing file and a directory", async () => {
		expect(await resolve("/missing.js")).toBeNull();
		expect(await resolve("/assets")).toBeNull();
		expect(await resolve("/assets/")).toBeNull();
	});

	it.each([
		["another host on the scheme", `${APP_SCHEME}://evil/index.html`],
		["the scheme with no host", `${APP_SCHEME}:///index.html`],
		["a file URL", "file:///opt/Vayu/resources/app.asar/dist/index.html"],
		["http with the app's host", `http://${APP_HOST}/index.html`],
		["malformed percent-encoding", `${APP_SCHEME}://${APP_HOST}/%E0%A4%A`],
		["not a URL", "index.html"],
	])("refuses %s", async (_label, url) => {
		expect(await resolveAppFile(url, dist)).toBeNull();
	});

	it("refuses everything when the root itself is missing", async () => {
		expect(await resolveAppFile(APP_ENTRY_URL, path.join(tmp, "no-dist"))).toBeNull();
	});
});

describe("createAppProtocolHandler", () => {
	it("fetches the shipped file by its file URL", async () => {
		const served = new Response("ok");
		const fetchFile = vi.fn(async () => served);
		const response = await createAppProtocolHandler(dist, fetchFile)({ url: APP_ENTRY_URL });
		expect(response).toBe(served);
		expect(fetchFile).toHaveBeenCalledWith(pathToFileURL(shipped("index.html")).toString());
	});

	it("answers 404 without touching fetch for anything it refuses", async () => {
		const fetchFile = vi.fn(async () => new Response("leak"));
		const handle = createAppProtocolHandler(dist, fetchFile);
		for (const url of [
			`${APP_SCHEME}://${APP_HOST}/missing.js`,
			`${APP_SCHEME}://${APP_HOST}/escape/secret.txt`,
			`${APP_SCHEME}://evil/index.html`,
		]) {
			expect((await handle({ url })).status, url).toBe(404);
		}
		expect(fetchFile).not.toHaveBeenCalled();
	});
});

describe("the scheme's registration", () => {
	it("is privileged as standard, secure and fetchable, and nothing more", () => {
		// No bypassCSP: the policy applying is the point. No corsEnabled: the
		// engine is reached through engine-origin.ts. No service workers.
		expect(APP_SCHEME_PRIVILEGES).toEqual({
			standard: true,
			secure: true,
			supportFetchAPI: true,
		});
	});

	it("is not plain `vayu`, which a user may give an OAuth provider as a redirect", () => {
		expect(APP_SCHEME).not.toBe("vayu");
		expect(APP_ENTRY_URL).toBe(`${APP_SCHEME}://${APP_HOST}/index.html`);
	});
});
