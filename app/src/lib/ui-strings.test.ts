/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { uiStrings, uiStringsIn, decodeJsxEntities } from "./ui-strings.testkit";
import { UNNAMED_MCP_CLIENT } from "./mcp-client-names";

/** The texts `source` yields, in order. */
const textsIn = (source: string, file = "src/a.tsx") =>
	uiStringsIn(file, source).map(({ text }) => text);

describe("the tree the testkit reads", () => {
	const { files, strings } = uiStrings();

	it("reads both trees, and a real number of strings", () => {
		expect(files.some((file) => file.startsWith("src/"))).toBe(true);
		expect(files.some((file) => file.startsWith("electron/"))).toBe(true);
		expect(strings.length).toBeGreaterThan(2000);
	});

	it("leaves out tests, testkits, test support and the MCP server", () => {
		const excluded = files.filter(
			(file) =>
				file.includes(".test.") ||
				file.includes(".testkit.") ||
				file.startsWith("src/test/") ||
				file.startsWith("electron/mcp/")
		);
		expect(excluded).toEqual([]);
	});

	it("finds a known string in its file", () => {
		expect(
			strings.some(
				({ file, text }) =>
					file === "src/lib/mcp-client-names.ts" && text === UNNAMED_MCP_CLIENT
			)
		).toBe(true);
	});
});

describe("what one source yields", () => {
	it("yields string literals, template segments and JSX text, with their lines", () => {
		const found = uiStringsIn(
			"src/a.tsx",
			[
				'const a = "one";',
				"const b = `two ${a} three`;",
				"const c = <p>\n\tfour\n</p>;",
			].join("\n")
		).map(({ text, kind, line }) => ({ text, kind, line }));

		expect(found).toEqual([
			{ text: "one", kind: "string", line: 1 },
			{ text: "two ", kind: "template", line: 2 },
			{ text: " three", kind: "template", line: 2 },
			{ text: "four", kind: "jsx-text", line: 4 },
		]);
	});

	it("collapses JSX whitespace and decodes its entities, as React renders them", () => {
		expect(textsIn("<p>\n\tEngine &gt; Data &amp;\n\tretention</p>")).toEqual([
			"Engine > Data & retention",
		]);
		expect(textsIn('<p title="Don&apos;t" />')).toEqual(["Don't"]);
		expect(decodeJsxEntities("&#8250; &#x2026; &unknown;")).toBe("› … &unknown;");
	});

	it("skips comments, module specifiers and type positions", () => {
		expect(
			textsIn(
				[
					'import x from "react";',
					'export { y } from "./y";',
					'const z = import("./z");',
					'type Mode = "Failed to";',
					"// Failed to load",
					"/* Could not load */",
					'const kept = "kept";',
				].join("\n"),
				"src/a.ts"
			)
		).toEqual(["kept"]);
	});

	it.each([
		["console", 'console.warn("dropped");'],
		["an app logger", 'appLogger().info("app", "dropped");'],
		["an injected log", 'deps.log("dropped", { a: "dropped" });'],
		["a system log", "system.log(`dropped ${e}`);"],
		["an optional logger", 'ctx.log?.warn("dropped");'],
		["a log property", 'deps.appLog.warn("dropped");'],
		["a log callback", 'log("dropped");'],
		["the renderer's logError", 'logError(err, "high", { action: "dropped" });'],
	])("drops the arguments of %s", (_shape, call) => {
		expect(textsIn(`${call}\nconst kept = "kept";`, "src/a.ts")).toEqual(["kept"]);
	});

	it("keeps a call that only looks like a log", () => {
		expect(textsIn('toast.error("kept"); dialog.showMessageBox({ message: "kept" });')).toEqual(
			["kept", "kept"]
		);
	});
});
