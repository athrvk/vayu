/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The voice and casing rules of `docs/ux-writing.md`, held over every string the
 * app's sources carry (#2300). Three rules:
 *
 *  - no banned opener ("Failed to", "Could not", "Oops", "Please",
 *    "Something went wrong") at the start of a sentence;
 *  - no exclamation mark after a word;
 *  - no Title Case on the surfaces the guide calls labels (`labelSurface`).
 *
 * The strings come from `ui-strings.testkit.ts`, which already leaves out
 * comments, logs, tests and `electron/mcp/**`. What is wrong today and owned by
 * an open issue sits in `KNOWN_BREACHES`; the commit that fixes a string deletes
 * its entry, and the rot test below fails until it does.
 */

import { describe, it, expect } from "vitest";
import ts from "typescript";
import { uiStrings, uiStringsIn, type UiString } from "@/lib/ui-strings.testkit";
import { MCP_CLIENTS } from "@/lib/mcp-client-names";

// ---------------------------------------------------------------------------
// The detectors, exported for the cases at the bottom of this file.
// ---------------------------------------------------------------------------

const BANNED_OPENERS = ["Failed to", "Could not", "Oops", "Please", "Something went wrong"];

/**
 * At the start of the text or of a sentence inside it, and spelled as an opener:
 * "the request failed to send" is a clause, not the register the guide bans.
 */
const BANNED_OPENER = new RegExp(
	`(?:^|[.!?]\\s+)\\s*(${BANNED_OPENERS.map((opener) => opener.replace(/ /g, "\\s+")).join("|")})\\b`
);

export function bannedOpener(text: string): string | null {
	return BANNED_OPENER.exec(text.trimStart())?.[1] ?? null;
}

/** A word, then `!` - but not `!=`, which is code. */
export function hasExclamation(text: string): boolean {
	return /[\p{L}\p{N}]!(?!=)/u.test(text);
}

/**
 * Names that keep their capitals mid-label, matched as whole word runs. Each
 * entry is a proper noun; a common noun that happens to follow one is not
 * covered unless the pair is itself the name ("Postman Collection").
 */
const PROPER_NOUNS: readonly { readonly name: string; readonly reason: string }[] = [
	{ name: "Vayu", reason: "the product" },
	{ name: "Postman", reason: "a product the app imports from and exports to" },
	{
		name: "Postman Collection",
		reason: "the name of Postman's file format, which an export targets",
	},
	{ name: "Insomnia", reason: "a product the app imports from" },
	{ name: "Windows", reason: "an operating system" },
	{ name: "Linux", reason: "an operating system" },
	{ name: "OAuth", reason: "a protocol name, mixed case by its own spelling" },
	{ name: "OpenAPI", reason: "a specification name, mixed case by its own spelling" },
	{ name: "GraphQL", reason: "a protocol name, mixed case by its own spelling" },
	{ name: "Content-Type", reason: "an HTTP header name, spelled as the protocol registers it" },
	{ name: "Akamai EdgeGrid", reason: "a vendor's authentication scheme" },
	{ name: "Space Grotesk", reason: "a typeface in constants/appearance.ts" },
	{ name: "JetBrains Mono", reason: "a typeface in constants/appearance.ts" },
	{ name: "Fira Code", reason: "a typeface in constants/appearance.ts" },
	{ name: "IBM Plex Mono", reason: "a typeface in constants/appearance.ts" },
	{ name: "Space Mono", reason: "a typeface in constants/appearance.ts" },
	// Claude Code, VS Code, GitHub Copilot CLI and the rest: the registry holds
	// each client's product name as its vendor spells it, so reading it here
	// keeps one list rather than two.
	...MCP_CLIENTS.map(({ label }) => ({
		name: label,
		reason: "an MCP client's product name, from lib/mcp-client-names.ts",
	})),
];

/**
 * A word with its surrounding punctuation and a possessive stripped: `(PKCE)`
 * is `PKCE`, `Vayu's` is `Vayu`.
 */
function wordsOf(text: string): string[] {
	return text
		.split(/[\s-]+/)
		.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’]s$/u, ""))
		.filter((word) => /\p{L}/u.test(word));
}

/** `URL`, `PKCE`, `IDs`: capitals by spelling, not by casing choice. */
function isAcronym(word: string): boolean {
	return /^\p{Lu}[\p{Lu}\d]+s?$/u.test(word);
}

/** Indexes of `words` that fall inside a proper noun. */
function properNounIndexes(words: readonly string[]): Set<number> {
	const covered = new Set<number>();
	for (const { name } of PROPER_NOUNS) {
		const parts = wordsOf(name);
		for (let start = 0; start + parts.length <= words.length; start++) {
			if (!parts.every((part, i) => words[start + i] === part)) continue;
			parts.forEach((_, i) => covered.add(start + i));
		}
	}
	return covered;
}

/** A full stop, question or exclamation mark with more words after it. */
const SENTENCE_BREAK = /[.!?]\s+\p{L}/u;

/** `Settings › Network & connectivity`: a path of names, each a label of its own. */
const PATH_SEPARATOR = /\s+[›>]\s+/;

/**
 * Two to six words, after splitting on hyphens, where a word after the first
 * starts upper-case and is neither an acronym nor part of a proper noun.
 * Sentence case wins over a hyphenated name, so "Ramp-Up" is Title Case. A
 * text with a sentence break in it is prose, whose capitals start sentences.
 */
export function isTitleCase(text: string): boolean {
	if (SENTENCE_BREAK.test(text)) return false;
	return text.split(PATH_SEPARATOR).some(isTitleCaseName);
}

function isTitleCaseName(text: string): boolean {
	const words = wordsOf(text);
	if (words.length < 2 || words.length > 6) return false;
	const covered = properNounIndexes(words);
	return words.some(
		(word, i) => i > 0 && !covered.has(i) && !isAcronym(word) && /^\p{Lu}/u.test(word)
	);
}

// ---------------------------------------------------------------------------
// Where a label sits: the surfaces the guide's case rule names.
// ---------------------------------------------------------------------------

/** Components whose text is a label (button, menu item, tab, title). */
const LABEL_COMPONENTS = new Set([
	"Button",
	"DropdownMenuItem",
	"ContextMenuItem",
	"SelectItem",
	"TabsTrigger",
	"DialogTitle",
	"CardTitle",
	"Label",
]);

const LABEL_PROPERTIES = new Set(["label", "title"]);

/** Expressions that pass a value through unchanged, so a label inside one is still the label. */
function isPassThrough(node: ts.Node, child: ts.Node): boolean {
	if (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isTemplateSpan(node) ||
		ts.isTemplateExpression(node)
	) {
		return true;
	}
	return ts.isConditionalExpression(node) && child !== node.condition;
}

/** The nearest ancestor that does something with the value, and the child it came through. */
function valueSite(node: ts.Node): { site: ts.Node; via: ts.Node } {
	let via = node;
	let site = node.parent;
	while (isPassThrough(site, via)) {
		via = site;
		site = site.parent;
	}
	return { site, via };
}

function propertyName(node: ts.PropertyAssignment): string | null {
	const { name } = node;
	return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

/** JSX text, through intrinsic wrappers (`<span>`), up to the first component. */
function enclosingComponent(node: ts.Node): string | null {
	const { site } = valueSite(node);
	const child = ts.isJsxText(node) ? node : ts.isJsxExpression(site) ? site : null;
	if (!child) return null;
	let element: ts.Node = child.parent;
	while (ts.isJsxElement(element) || ts.isJsxFragment(element)) {
		if (ts.isJsxElement(element)) {
			const tag = element.openingElement.tagName.getText();
			if (/^[A-Z]/.test(tag)) return tag.split(".").pop() ?? tag;
		}
		element = element.parent;
	}
	return null;
}

/** A value inside a `*_LABELS` record declared under `src/constants/`. */
function inLabelsRecord(file: string, node: ts.Node): boolean {
	if (!file.startsWith("src/constants/")) return false;
	let { site, via } = valueSite(node);
	while (
		(ts.isPropertyAssignment(site) && site.initializer === via) ||
		ts.isObjectLiteralExpression(site) ||
		ts.isArrayLiteralExpression(site) ||
		isPassThrough(site, via)
	) {
		via = site;
		site = site.parent;
	}
	return (
		ts.isVariableDeclaration(site) &&
		ts.isIdentifier(site.name) &&
		/_LABELS$/.test(site.name.text)
	);
}

/** `label: "..."` / `title: "..."`, or the same property written as a prop. */
function labelProperty(site: ts.Node, via: ts.Node): string | null {
	if (ts.isPropertyAssignment(site) && site.initializer === via) {
		const name = propertyName(site);
		return name && LABEL_PROPERTIES.has(name) ? `${name}:` : null;
	}
	// `<X label="..." />` is `{ label: "..." }` by the time it reaches X.
	const attribute = ts.isJsxExpression(site) ? site.parent : site;
	if (!ts.isJsxAttribute(attribute)) return null;
	const name = attribute.name.getText();
	return LABEL_PROPERTIES.has(name) ? `${name}=` : null;
}

/** The first argument of OAuth2Form's local `field(label, node, hint)`. */
function isOAuth2FieldLabel(file: string, site: ts.Node, via: ts.Node): boolean {
	return (
		file.endsWith("/OAuth2Form.tsx") &&
		ts.isCallExpression(site) &&
		ts.isIdentifier(site.expression) &&
		site.expression.text === "field" &&
		site.arguments[0] === via
	);
}

/** Why `entry` is a label the case rule covers, or null when it is not one. */
export function labelSurface(entry: UiString): string | null {
	const component = enclosingComponent(entry.node);
	if (component && LABEL_COMPONENTS.has(component)) return `<${component}> text`;

	const { site, via } = valueSite(entry.node);
	const property = labelProperty(site, via);
	if (property) return property;
	if (inLabelsRecord(entry.file, entry.node)) return "*_LABELS record";
	if (isOAuth2FieldLabel(entry.file, site, via)) return "field() label";
	return null;
}

/** Every rule `entry` breaks, as a short name for the report. */
export function breachesOf(entry: UiString): string[] {
	const found: string[] = [];
	const opener = bannedOpener(entry.text);
	if (opener) found.push(`opens with "${opener}"`);
	if (hasExclamation(entry.text)) found.push("exclamation mark");
	const surface = labelSurface(entry);
	if (surface && isTitleCase(entry.text)) found.push(`Title Case ${surface}`);
	return found;
}

// ---------------------------------------------------------------------------
// The allowlist: today's breaches, each owned by the issue that fixes it.
// ---------------------------------------------------------------------------

/** `file :: literal`, the key both lists below use. */
const keyOf = (entry: Pick<UiString, "file" | "text">) => `${entry.file} :: ${entry.text}`;

/**
 * Breaches that ship today, each with the issue that retires it. The fix
 * deletes its entry in the same commit; the rot test fails until it does.
 */
const KNOWN_BREACHES: Readonly<Record<string, string>> = {
	"electron/sidecar.ts :: Please close the Application and reopen it.": "#2292",

	// The native menu: Title Case is right in the macOS menu bar and wrong in the
	// same template popped from the title bar elsewhere, so the fix is the
	// per-platform label function `docs/ux-writing.md` ("Case") assigns to the
	// sentence-case sweep, not a respelling.
	"electron/main.ts :: Check for Updates…": "#2287",
	"electron/main.ts :: Actual Size": "#2287",
	"electron/main.ts :: Zoom In": "#2287",
	"electron/main.ts :: Zoom Out": "#2287",
	"electron/main.ts :: Scripting Guide": "#2287",
	"electron/main.ts :: Report an Issue": "#2287",

	// An engine setting's label, quoted by hand; it moves with the engine's.
	"src/services/curl/parseCurl.ts :: Custom CA Certificates": "#2293",

	"src/components/shared/ElementList/element-modes.ts :: Every Nth": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Client Credentials": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Password Credentials": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Authorization Code (PKCE)": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Client Secret": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Client Authentication": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Send as Basic Auth header": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Token Placement": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Query Param Name": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Header Prefix": "#2296",
	"src/components/shared/OAuth2Form/OAuth2Form.tsx :: Refresh Token URL": "#2296",
	"src/components/shared/ScriptLifecycleSummary.tsx :: Setup / Teardown": "#2296",
	"src/components/shared/TestValidationSummary.tsx :: Test Validation": "#2296",
	"src/constants/appearance.ts :: System Mono": "#2296",
	"src/constants/auth-modes.ts :: No Auth": "#2296",
	"src/constants/auth-modes.ts :: No Auth (blocks inheriting)": "#2296",
	"src/constants/auth-modes.ts :: Inherit from Collection": "#2296",
	"src/constants/auth-modes.ts :: Bearer Token": "#2296",
	"src/constants/auth-modes.ts :: Basic Auth": "#2296",
	"src/constants/auth-modes.ts :: API Key": "#2296",
	"src/constants/auth-modes.ts :: AWS Signature": "#2296",
	"src/constants/auth-modes.ts :: JWT Bearer": "#2296",
	"src/constants/load-test-modes.ts :: Constant Virtual Users": "#2296",
	"src/constants/load-test-modes.ts :: Ramp-Up": "#2296",
	"src/constants/load-test-modes.ts :: Capacity Discovery": "#2296",
	"src/constants/oauth2-fields.ts :: Grant Type": "#2296",
	"src/constants/oauth2-fields.ts :: Access Token URL": "#2296",
	"src/modules/collections/CollectionDetail/ElementsTab.tsx :: Save Elements": "#2296",
	"src/modules/history/main/components/PerformanceTab.tsx :: P50 (Median)": "#2296",
	"src/modules/history/main/components/SamplesTab.tsx :: Sampled Request Details": "#2296",
	"src/modules/request-builder/components/RequestTabs/panels/AuthPanel.tsx :: Authentication Type":
		"#2296",
	"src/modules/variables/sidebar/VariablesCategoryTree.tsx :: Export as Postman Environment":
		"#2296",
};

/**
 * Text the rules match that is not interface copy, each with its reason. Not
 * owed a fix, so no issue number.
 */
const NOT_INTERFACE_COPY: Readonly<Record<string, string>> = {
	'src/modules/settings/main/panels/EditorPanel.tsx :: \t\treturn "Hello, world!";':
		"a line of the code sample the editor preview renders, not a sentence to the user",
};

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

const { files, strings } = uiStrings();

const breaches = strings.flatMap((entry) =>
	breachesOf(entry).map((rule) => ({ entry, rule, key: keyOf(entry) }))
);

describe("the voice and casing scan", () => {
	it("reads a real tree", () => {
		expect(files.length).toBeGreaterThan(200);
		expect(strings.length).toBeGreaterThan(2000);
	});

	it("finds no breach outside the allowlist", () => {
		const unlisted = breaches
			.filter(({ key }) => !(key in KNOWN_BREACHES) && !(key in NOT_INTERFACE_COPY))
			.map(
				({ entry, rule }) =>
					`${entry.file}:${entry.line} ${rule}: ${JSON.stringify(entry.text)}`
			);

		expect(
			unlisted.join("\n"),
			"Rewrite the string to docs/ux-writing.md. A breach an open issue already owns goes in KNOWN_BREACHES with that issue's number."
		).toBe("");
	});

	it("allowlists only what still breaks a rule", () => {
		const flagged = new Set(breaches.map(({ key }) => key));
		const stale = [...Object.keys(KNOWN_BREACHES), ...Object.keys(NOT_INTERFACE_COPY)].filter(
			(key) => !flagged.has(key)
		);

		expect(
			stale.join("\n"),
			"These entries name a literal the sources no longer carry, or one that now passes. Delete the entry."
		).toBe("");
	});

	it("files every known breach under an issue", () => {
		const unowned = Object.entries(KNOWN_BREACHES)
			.filter(([, owner]) => !/^#\d+\b/.test(owner))
			.map(([key]) => key);
		expect(unowned).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The detectors, one bad and one good per rule.
// ---------------------------------------------------------------------------

describe("the banned openers", () => {
	it.each(BANNED_OPENERS)("refuses %s at the start of a sentence", (opener) => {
		expect(bannedOpener(`${opener} load the collection.`)).toBe(opener);
		expect(bannedOpener(`Couldn't restart. ${opener} reopen the app.`)).toBe(opener);
	});

	it("passes the opener the guide asks for, and the same words mid-clause", () => {
		expect(bannedOpener("Couldn't load the collection.")).toBeNull();
		expect(bannedOpener("The request failed to send")).toBeNull();
		expect(bannedOpener("Pleased to meet you")).toBeNull();
	});
});

describe("the exclamation rule", () => {
	it("refuses an exclamation mark after a word", () => {
		expect(hasExclamation("Saved!")).toBe(true);
	});

	it("passes a negation and an inequality", () => {
		expect(hasExclamation("!important")).toBe(false);
		expect(hasExclamation("a != b")).toBe(false);
	});
});

describe("the Title Case rule", () => {
	it("refuses a capital on a word after the first, a hyphenated one too", () => {
		expect(isTitleCase("Bearer Token")).toBe(true);
		expect(isTitleCase("Ramp-Up")).toBe(true);
		expect(isTitleCase("Inherit from Collection")).toBe(true);
		expect(isTitleCase("Authorization Code (PKCE)")).toBe(true);
	});

	it("passes sentence case, acronyms and proper nouns", () => {
		expect(isTitleCase("Bearer token")).toBe(false);
		expect(isTitleCase("Ramp-up")).toBe(false);
		expect(isTitleCase("Callback URL")).toBe(false);
		expect(isTitleCase("VS Code")).toBe(false);
		expect(isTitleCase("Export as Postman Collection")).toBe(false);
		expect(isTitleCase("Import from Postman")).toBe(false);
	});

	it("leaves a proper noun's neighbour to the rule", () => {
		expect(isTitleCase("Postman Environment")).toBe(true);
	});

	it("reads a possessive proper noun as the noun", () => {
		expect(isTitleCase("Couldn't restart Vayu's engine")).toBe(false);
		expect(isTitleCase("Restart Vayu's Engine")).toBe(true);
	});

	it("judges each name in a settings path on its own", () => {
		expect(isTitleCase("Engine > Data & retention")).toBe(false);
		expect(isTitleCase("Settings › Network & connectivity")).toBe(false);
		expect(isTitleCase("Settings › Network › Custom CA Certificates")).toBe(true);
	});

	it("reads text with a sentence break as prose", () => {
		expect(isTitleCase("Seconds. What")).toBe(false);
	});

	it("reads one word, and a sentence past six, as neither", () => {
		expect(isTitleCase("Save")).toBe(false);
		expect(isTitleCase("Open The Settings Page And Pick A Theme")).toBe(false);
	});

	it("gives every proper noun a reason", () => {
		expect(PROPER_NOUNS.filter(({ reason }) => reason.trim() === "")).toEqual([]);
	});
});

describe("the label surfaces", () => {
	/** The surface of the one string `source` carries that reads `text`. */
	const surfaceOf = (file: string, source: string, text: string) => {
		const entry = uiStringsIn(file, source).find((found) => found.text === text);
		expect(entry, `no string "${text}" in the fixture`).toBeDefined();
		return labelSurface(entry as UiString);
	};

	it("reads a label component's text, through a wrapper span", () => {
		expect(surfaceOf("src/a.tsx", "<Button>Save Request</Button>", "Save Request")).toBe(
			"<Button> text"
		);
		expect(
			surfaceOf(
				"src/a.tsx",
				"<DropdownMenuItem><span>Move To Trash</span></DropdownMenuItem>",
				"Move To Trash"
			)
		).toBe("<DropdownMenuItem> text");
		expect(
			surfaceOf("src/a.tsx", "<Button>{`Save Request ${n}`}</Button>", "Save Request ")
		).toBe("<Button> text");
		expect(surfaceOf("src/a.tsx", "<Hint>Some Text</Hint>", "Some Text")).toBeNull();
	});

	it("reads label: and title: properties, through a conditional", () => {
		expect(surfaceOf("src/a.ts", 'const a = { label: "Zoom In" };', "Zoom In")).toBe("label:");
		expect(surfaceOf("src/a.ts", 'const a = { title: x ? "A B" : "C D" };', "C D")).toBe(
			"title:"
		);
		expect(surfaceOf("src/a.ts", 'const a = { hint: "Zoom In" };', "Zoom In")).toBeNull();
	});

	it("reads the same properties written as props", () => {
		expect(surfaceOf("src/a.tsx", '<Row label="Save Elements" />', "Save Elements")).toBe(
			"label="
		);
		expect(surfaceOf("src/a.tsx", '<Row title={x ? "A B" : "C D"} />', "A B")).toBe("title=");
		expect(surfaceOf("src/a.tsx", '<Row hint="Save Elements" />', "Save Elements")).toBeNull();
	});

	it("reads a *_LABELS record under constants/ only", () => {
		const record = 'export const MODE_LABELS = { none: "No Auth" } as const;';
		expect(surfaceOf("src/constants/a.ts", record, "No Auth")).toBe("*_LABELS record");
		expect(surfaceOf("src/lib/a.ts", record, "No Auth")).toBeNull();
	});

	it("reads OAuth2Form's field() label, not its other arguments", () => {
		const file = "src/components/shared/OAuth2Form/OAuth2Form.tsx";
		const source = 'field("Client Secret", node, "Leave It Blank")';
		expect(surfaceOf(file, source, "Client Secret")).toBe("field() label");
		expect(surfaceOf(file, source, "Leave It Blank")).toBeNull();
	});
});
