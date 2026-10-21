/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every main-process read of a renderer-named path is wired to the grant
 * registry (#2357).
 *
 * The readers refuse an ungranted path only because `isGranted` is injected
 * (`spec-file.test.ts`, `data-file.test.ts` drive that with a stub), so the
 * remaining way to lose the gate is a call site in `main.ts` that supplies a
 * filesystem with an `isGranted` of its own making, or none. The type system
 * keeps `isGranted` from being omitted; this keeps it from being anything but
 * `fileGrants`. `main.ts` creates windows and starts the engine at import time,
 * so the wiring can only be read, the approach `startup-order.test.ts` takes.
 *
 * `file:stat` is the fourth: `registerFileIpc` takes the same `isGranted` and
 * the allowed-folder reader, and a call without them fails type-check, so the
 * case below holds what they are.
 *
 * Mutation check: pass `async () => true` instead of `fileGrants.isGranted(p)`
 * at any one call site and that site's case fails; delete a handler's read call
 * and the "found" case fails.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

/** The source with line and block comments blanked, so a comment cannot satisfy a check. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const code = stripComments(main);

/** The text between the bracket at @p open and its match. */
function balanced(source: string, open: number): string {
	const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (pairs[source[i]]) depth++;
		else if (Object.values(pairs).includes(source[i]) && --depth === 0) {
			return source.slice(open + 1, i);
		}
	}
	throw new Error("unbalanced source");
}

/** The body of `ipcMain.handle("<channel>", ...)`, or null when main registers none. */
function handlerBody(channel: string): string | null {
	const at = code.indexOf(`ipcMain.handle("${channel}"`);
	return at < 0 ? null : balanced(code, code.indexOf("(", at));
}

/** The arguments of every call to @p fn in @p source. */
function callArguments(source: string, fn: string): string[] {
	const calls: string[] = [];
	const pattern = new RegExp(`(?<![\\w.])${fn}\\(`, "g");
	for (const match of source.matchAll(pattern)) {
		calls.push(balanced(source, match.index + fn.length));
	}
	return calls;
}

const READERS = ["readDataFile", "hashDataFileReply", "hashDataFile", "readSpecFile"];

describe("the readers of a renderer-named path consult the grant registry", () => {
	it.each([
		["dataFile:read", "readDataFile"],
		["dataFile:hash", "hashDataFileReply"],
		["specFile:read", "readSpecFile"],
	])("%s hands %s a filesystem gated by fileGrants.isGranted", (channel, reader) => {
		const body = handlerBody(channel);
		// The scan found the handler, and the handler calls the reader.
		expect(body).not.toBeNull();
		const calls = callArguments(body as string, reader);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatch(/fileGrants\.isGranted\(/);
	});

	it("gives the MCP content hash the same gate", () => {
		const lambdas = [...code.matchAll(/currentDataFileHash:/g)];
		expect(lambdas).toHaveLength(1);
		const rest = code.slice((lambdas[0].index ?? 0) + "currentDataFileHash:".length);
		const lambda = rest.slice(0, rest.indexOf("appFocus:"));
		expect(callArguments(lambda, "hashDataFile")).toHaveLength(1);
		expect(callArguments(lambda, "hashDataFile")[0]).toMatch(/fileGrants\.isGranted\(/);
	});

	it("leaves no other call to a reader in main.ts", () => {
		// A fourth call site added later would be unguarded by the cases above.
		const sites = READERS.flatMap((fn) => callArguments(code, fn));
		expect(sites).toHaveLength(4);
		for (const args of sites) expect(args).toMatch(/fileGrants\.isGranted\(/);
	});

	it("gives file:stat the grant registry and the allowed-folder reader", () => {
		const calls = callArguments(code, "registerFileIpc");
		// The scan found the one registration.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatch(/isGranted:\s*\(\w+\)\s*=>\s*fileGrants\.isGranted\(/);
		expect(calls[0]).toMatch(/roots:\s*fileRoots\b/);
		expect(code).toMatch(/const fileRoots = createFileRoots\(fileTrust\)/);
	});

	it("re-reads the allowed folders when an engine is spawned", () => {
		const at = code.indexOf("function receiveGrantSecret(");
		expect(at).toBeGreaterThan(-1);
		expect(balanced(code, code.indexOf("{", at))).toMatch(/fileRoots\.invalidate\(\)/);
	});
});
