/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every piece of text the app's sources could put in front of a user, with
 * where it was written: the input of the writing guards that hold
 * `docs/ux-writing.md` (`voice-casing.test.ts`, #2300, and the narrow scanners
 * that join it).
 *
 * Read through the TypeScript AST rather than a regex, because the two things a
 * regex scan gets wrong are the two this has to get right: a comment is not
 * text (the parser never yields one), and an apostrophe inside a JSX text node
 * or a template literal does not open a string.
 *
 * Not text a person reads, so not yielded:
 *  - module specifiers (`import`, `export … from`, `import()`, `require()`);
 *  - type positions (`type Mode = "a" | "b"`), which never reach runtime;
 *  - the arguments of a `console.*` or logger call, because the writing guide
 *    exempts logs (`docs/ux-writing.md`, "One opener only"). The logger shapes
 *    are the ones the main process writes: `appLogger().info(...)`,
 *    `deps.log(...)`, `system.log(...)`, `ctx.log?.warn(...)`, an injected
 *    `log(...)` callback, the renderer's `logError(...)`.
 *
 * Not scanned at all: tests, testkits, declaration files, the test support
 * under `src/test/`, and `electron/mcp/**`, whose text is written for agents
 * rather than people.
 */

import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

/** `app/`, which every `file` below is relative to. */
export const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type UiStringKind = "string" | "template" | "jsx-text";

export interface UiString {
	/** Relative to `app/`, POSIX-spelled: `src/...` or `electron/...`. */
	readonly file: string;
	/** 1-based, of the text's first character. */
	readonly line: number;
	/**
	 * The text as the program holds it: escapes resolved, and for a JSX text node
	 * trimmed with its whitespace runs collapsed, which is what React renders.
	 * A template literal yields one entry per text segment.
	 */
	readonly text: string;
	readonly kind: UiStringKind;
	/** The node, parents set, for a guard that judges the text by where it sits. */
	readonly node: ts.Node;
}

/** The files read, relative to `app/` and POSIX-spelled. */
export function scannedSourceFiles(): string[] {
	return globSync("{src,electron}/**/*.{ts,tsx}", { cwd: appRoot })
		.map((file) => file.split("\\").join("/"))
		.filter(
			(file) =>
				!file.includes(".test.") &&
				!file.includes(".testkit.") &&
				!file.endsWith(".d.ts") &&
				!file.startsWith("src/test/") &&
				!file.startsWith("electron/mcp/")
		)
		.sort();
}

/** A call whose arguments go to a log rather than a screen. */
const LOG_METHODS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "log"]);

/** `console`, `log`, `logger`, `appLog`, `appLogger`, `mcpLogger`; not `dialog`. */
const LOGGER_NAME = /^(?:console|log|logger|\w+Log|\w+Logger)$/;

/** An injected `log(...)` callback, or the renderer's `logError` / `logApiError`. */
const LOG_FUNCTION = /^log(?:[A-Z]\w*)?$/;

function unwrap(node: ts.Expression): ts.Expression {
	let current = node;
	while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
		current = current.expression;
	}
	return current;
}

/** `appLogger()`, `deps.appLog`, `ctx.log`, `console`. */
function isLoggerReceiver(node: ts.Expression): boolean {
	const receiver = unwrap(node);
	if (ts.isIdentifier(receiver)) return LOGGER_NAME.test(receiver.text);
	if (ts.isPropertyAccessExpression(receiver)) return LOGGER_NAME.test(receiver.name.text);
	if (ts.isCallExpression(receiver)) return isLoggerReceiver(receiver.expression);
	return false;
}

export function isLogCall(call: ts.CallExpression): boolean {
	const callee = unwrap(call.expression);
	if (ts.isIdentifier(callee)) return LOG_FUNCTION.test(callee.text);
	if (!ts.isPropertyAccessExpression(callee)) return false;
	// Any `.log(...)`: `deps.log`, `system.log`, `transport.log`, and the
	// numeric `Math.log`, which carries no text to lose.
	if (callee.name.text === "log") return true;
	return LOG_METHODS.has(callee.name.text) && isLoggerReceiver(callee.expression);
}

/** A string that names a module rather than saying anything. */
function isModuleSpecifier(node: ts.Node): boolean {
	const parent = node.parent;
	if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
		return parent.moduleSpecifier === node;
	}
	if (ts.isExternalModuleReference(parent)) return true;
	if (!ts.isCallExpression(parent)) return false;
	const callee = parent.expression;
	return (
		callee.kind === ts.SyntaxKind.ImportKeyword ||
		(ts.isIdentifier(callee) && callee.text === "require")
	);
}

/** The entities the sources write in JSX; an unlisted one is kept as written. */
const JSX_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	quot: '"',
	ldquo: "“",
	rdquo: "”",
	rsquo: "’",
	middot: "·",
	rarr: "→",
	nbsp: " ",
};

/**
 * JSX decodes HTML entities in its text and attribute strings, and the parser
 * hands them over raw: `Engine &gt; Data` renders as `Engine > Data`.
 */
export function decodeJsxEntities(text: string): string {
	return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
		if (name.startsWith("#x") || name.startsWith("#X")) {
			return String.fromCodePoint(parseInt(name.slice(2), 16));
		}
		if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
		return JSX_ENTITIES[name] ?? match;
	});
}

function textOf(node: ts.Node): { text: string; kind: UiStringKind } | null {
	if (ts.isStringLiteral(node)) {
		const text = ts.isJsxAttribute(node.parent) ? decodeJsxEntities(node.text) : node.text;
		return { text, kind: "string" };
	}
	if (
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateHead(node) ||
		ts.isTemplateMiddle(node) ||
		ts.isTemplateTail(node)
	) {
		return { text: node.text, kind: "template" };
	}
	if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) {
		const text = decodeJsxEntities(node.text.replace(/\s+/g, " ").trim());
		return text === "" ? null : { text, kind: "jsx-text" };
	}
	return null;
}

/** The first non-whitespace character, so a JSX text node reports its words' line. */
function lineOf(source: ts.SourceFile, node: ts.Node): number {
	const start = node.getStart(source);
	const lead = /^\s*/.exec(source.text.slice(start, node.end))?.[0].length ?? 0;
	return source.getLineAndCharacterOfPosition(start + lead).line + 1;
}

/** The strings in one source; `file` is only recorded, never read. */
export function uiStringsIn(file: string, source: string): UiString[] {
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);
	const found: UiString[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isTypeNode(node)) return;
		if (ts.isCallExpression(node) && isLogCall(node)) return;
		const text = textOf(node);
		if (text && !isModuleSpecifier(node)) {
			found.push({ file, line: lineOf(sourceFile, node), node, ...text });
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

let cached: { files: string[]; strings: UiString[] } | undefined;

/** Every scanned file and every string in them, read once per test file. */
export function uiStrings(): { files: string[]; strings: UiString[] } {
	if (cached) return cached;
	const files = scannedSourceFiles();
	const strings = files.flatMap((file) =>
		uiStringsIn(file, readFileSync(join(appRoot, file), "utf8"))
	);
	cached = { files, strings };
	return cached;
}
