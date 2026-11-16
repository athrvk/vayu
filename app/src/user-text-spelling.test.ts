/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The spellings `docs/ux-writing.md` fixes, held over every string the app's
 * sources carry (#2299). Four rules, each a spelling a reader sees as
 * inconsistency rather than as a mistake:
 *
 *  - a settings path is written `Settings › Files`, never `Settings > Files` (or
 *    any other names joined with `>`);
 *  - the tool is "cURL" in a sentence ("a cURL command", "a cURL request");
 *  - an ellipsis is the one character `…`, never three full stops after a word;
 *  - a group of requests is a "collection" or a "nested collection", never a
 *    "folder" (#3500); a directory on disk is a folder, and every string that
 *    says so is listed in `FILESYSTEM_FOLDERS` with its reason.
 *
 * The strings come from `ui-strings.testkit.ts`, which already leaves out
 * comments, logs, tests and `electron/mcp/**`. The command `curl` itself, the
 * code-generator id `"curl"` and a libcurl handle are not sentences about the
 * tool, so the rule names the two nouns the sentences use.
 */

import { describe, it, expect } from "vitest";
import { uiStrings } from "@/lib/ui-strings.testkit";

// ---------------------------------------------------------------------------
// The detectors, exported for the cases at the bottom of this file.
// ---------------------------------------------------------------------------

/**
 * A path of names joined with `>`, which reads as a comparison or a quote: a
 * letter, ` > `, then a capital - "Settings > Files", "Engine > Data & retention",
 * "General > Login Items". A comparison a sentence makes puts a number or a
 * lower-case word after the `>`.
 */
export function hasAsciiPathSeparator(text: string): boolean {
	return /\p{L} > \p{Lu}/u.test(text);
}

/** Case-sensitive on purpose: "cURL command" is the spelling being asked for. */
export function hasLowercaseCurl(text: string): boolean {
	return /\bcurl (command|request)/.test(text);
}

/**
 * Three full stops straight after a letter. A spread, a regex, a `"..."` code
 * sample and a GraphQL fragment all put something else before the dots.
 */
export function hasAsciiEllipsis(text: string): boolean {
	return /\p{L}\.\.\.(?!\.)/u.test(text);
}

/**
 * The directories the app's strings name, which the OS, its picker and the
 * engine's allow-list all call folders: a place on disk, never a group of
 * requests. Each entry is the exact phrase a file uses for one, matched without
 * regard to case, so a new "folder" in the same file that is not one of these
 * still fails. A phrase no string of its file carries fails the rot test.
 */
export const FILESYSTEM_FOLDERS: readonly {
	readonly file: string;
	readonly phrases: readonly string[];
	readonly reason: string;
}[] = [
	{
		file: "electron/file-ipc.ts",
		phrases: ["Allow a folder", "folder dialog", "allowed folders"],
		reason: "the system folder picker's title and the engine's allowed folders",
	},
	{
		file: "electron/file-trust-client.ts",
		phrases: ["allowed-folder id"],
		reason: "the id of an allowed folder on disk",
	},
	{
		file: "electron/spec-file.ts",
		phrases: ["the folder of the spec"],
		reason: "where a spec file sits on disk, which a relative reference may not leave",
	},
	{
		file: "src/hooks/useAllowFolder.ts",
		phrases: ["allowed folder", "folder picker"],
		reason: "the system folder picker and the engine's allowed folders",
	},
	{
		file: "src/modules/collections/ImportFileFolders.tsx",
		phrases: [
			"allowed folder",
			"its folder",
			"their folders",
			"Folders the imported files are in",
			"Allow folder",
		],
		reason: "the directories an imported file's path sits in, which Settings › Files allows",
	},
	{
		file: "src/modules/collections/ImportModal.tsx",
		phrases: ["in that folder", "Import folder"],
		reason: "a directory picked from disk to import the files of",
	},
	{
		file: "src/modules/collections/import-notices.ts",
		phrases: ["allow its folder"],
		reason: "the directory a file body's path sits in, which Settings › Files allows",
	},
	{
		file: "src/modules/request-builder/components/RequestTabs/panels/body/BinaryBodyPanel.tsx",
		phrases: ["allowed folder", "Allow folder", "allow its folder", "from a folder allowed"],
		reason: "the allowed directories a binary body's path may sit under",
	},
	{
		file: "src/modules/settings/main/app-panels.ts",
		phrases: ["The folders request-body files"],
		reason: "the Files panel's description of the allowed directories",
	},
	{
		file: "src/modules/settings/main/app-settings.ts",
		phrases: ["Allowed folders", "Folders Vayu may send"],
		reason: "the Files panel's setting, which is a list of directories",
	},
	{
		file: "src/modules/settings/main/panels/FilesPanel.tsx",
		phrases: [
			"allowed folder",
			"a folder you allow",
			"from these folders",
			"Allowed folders",
			"Remove folder",
			"Allow folder",
			"Choose folder",
		],
		reason: "the Files panel is the list of allowed directories",
	},
	{
		file: "src/modules/settings/main/panels/GeneralPanel.tsx",
		phrases: ["logs folder"],
		reason: "the directory the log files are in, opened in the file manager",
	},
	{
		file: "src/modules/settings/main/panels/WorkspaceBackupCard.tsx",
		phrases: ["backups folder"],
		reason: "the directory a backup is written to",
	},
	{
		file: "src/services/api.ts",
		phrases: ["Allowed folders"],
		reason: "the engine's allowed directories, which only the app may change",
	},
	{
		file: "src/services/importers/ref-bundler.ts",
		phrases: ["the folder that was picked"],
		reason: "the directory the user picked, which a `$ref` may not leave",
	},
];

/** `folder`, `new-folder-form`, `folder:`: an id or a key, not text a user reads. */
const IDENTIFIER_LIKE = /^[a-z][a-z0-9:-]*$/;

/** What is left of `text`, lower-cased, once the filesystem phrases listed for `file` are removed. */
function withoutFilesystemFolders(text: string, file: string): string {
	const phrases = FILESYSTEM_FOLDERS.filter((listed) => listed.file === file).flatMap(
		(listed) => listed.phrases
	);
	return phrases.reduce(
		(rest, phrase) => rest.split(phrase.toLowerCase()).join(""),
		text.toLowerCase()
	);
}

/**
 * "folder" or "folders" as a word, in a string that is not an identifier and
 * not one of the filesystem phrases listed for its file.
 */
export function hasFolderWord(text: string, file: string): boolean {
	if (IDENTIFIER_LIKE.test(text)) return false;
	return /\bfolders?\b/.test(withoutFilesystemFolders(text, file));
}

const RULES: readonly {
	readonly name: string;
	readonly breaks: (text: string, file: string) => boolean;
}[] = [
	{ name: "ASCII > in a settings path (write ›)", breaks: hasAsciiPathSeparator },
	{ name: "lowercase curl in a sentence (write cURL)", breaks: hasLowercaseCurl },
	{ name: "ASCII ellipsis (write …)", breaks: hasAsciiEllipsis },
	{ name: "folder (write collection or nested collection)", breaks: hasFolderWord },
];

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

const { files, strings } = uiStrings();

const breaches = strings.flatMap((entry) =>
	RULES.filter(({ breaks }) => breaks(entry.text, entry.file)).map(({ name }) => ({
		report: `${entry.file}:${entry.line} ${name}: ${JSON.stringify(entry.text)}`,
	}))
);

describe("the user-text spelling scan", () => {
	it("reads a real tree", () => {
		expect(files.length).toBeGreaterThan(500);
		expect(strings.length).toBeGreaterThan(2000);
		// A string that carries the right spelling, so a scan that read nothing
		// of the tree's text cannot pass for one that found no breach.
		expect(strings.some(({ text }) => text === "Import environment…")).toBe(true);
	});

	it("reads the strings the folder rule exists for", () => {
		// The rule judges every string; these are the two shapes it must tell
		// apart, so a scan that read neither cannot pass for one that found no
		// breach.
		const folderWords = strings.filter(({ text }) => /\bfolders?\b/i.test(text));
		expect(folderWords.length).toBeGreaterThan(20);
		expect(folderWords.some(({ text }) => text === "Allow folder…")).toBe(true);
		expect(folderWords.some(({ text }) => text === "folder")).toBe(true);
	});

	it("lists only filesystem phrases a string still carries", () => {
		const stale = FILESYSTEM_FOLDERS.flatMap(({ file, phrases }) =>
			phrases
				.filter(
					(phrase) =>
						!strings.some(
							(entry) =>
								entry.file === file &&
								entry.text.toLowerCase().includes(phrase.toLowerCase())
						)
				)
				.map((phrase) => `${file} :: ${phrase}`)
		);
		expect(
			stale.join("\n"),
			"No string of that file carries the phrase any more. Delete the entry."
		).toBe("");
		expect(FILESYSTEM_FOLDERS.filter(({ reason }) => reason.trim() === "")).toEqual([]);
	});

	it("finds no breach", () => {
		expect(
			breaches.map(({ report }) => report).join("\n"),
			"Spell it the way docs/ux-writing.md says: `Settings ›`, `cURL`, `…`, collection for a group of requests."
		).toBe("");
	});
});

// ---------------------------------------------------------------------------
// The detectors, one bad and one good per rule.
// ---------------------------------------------------------------------------

describe("the settings path rule", () => {
	it("refuses an ASCII chevron between the names of a path, whatever the first is", () => {
		expect(hasAsciiPathSeparator("allow its folder in Settings > Files.")).toBe(true);
		expect(hasAsciiPathSeparator("System Settings > General > Login Items")).toBe(true);
		expect(hasAsciiPathSeparator("Engine > Data & retention")).toBe(true);
		expect(hasAsciiPathSeparator("set under Network > Proxy")).toBe(true);
	});

	it("passes the chevron the guide asks for, and a comparison", () => {
		expect(hasAsciiPathSeparator("Settings › Dashboard › p99 threshold")).toBe(false);
		expect(hasAsciiPathSeparator("Engine › Data & retention")).toBe(false);
		expect(hasAsciiPathSeparator("fires when p99 > 500ms")).toBe(false);
		expect(hasAsciiPathSeparator("x > y")).toBe(false);
		expect(hasAsciiPathSeparator("a status > 399 is an error")).toBe(false);
	});
});

describe("the cURL rule", () => {
	it("refuses lowercase curl before command or request", () => {
		expect(hasLowercaseCurl("Paste a URL or a curl command")).toBe(true);
		expect(hasLowercaseCurl("Import a curl request")).toBe(true);
	});

	it("passes cURL, and the tool's other nouns", () => {
		expect(hasLowercaseCurl("Paste a URL or a cURL command")).toBe(false);
		expect(hasLowercaseCurl("curl handles")).toBe(false);
		expect(hasLowercaseCurl("libcurl request")).toBe(false);
		expect(hasLowercaseCurl("curl -X POST https://api.example.com")).toBe(false);
	});
});

describe("the ellipsis rule", () => {
	it("refuses three full stops after a letter", () => {
		expect(hasAsciiEllipsis("Allow folder...")).toBe(true);
		expect(hasAsciiEllipsis("Move to... ")).toBe(true);
		expect(hasAsciiEllipsis("Reading the document... done")).toBe(true);
	});

	it("passes the ellipsis character, and dots after anything else", () => {
		expect(hasAsciiEllipsis("Allow folder…")).toBe(false);
		expect(hasAsciiEllipsis('pm.variables.replaceIn("...")')).toBe(false);
		expect(hasAsciiEllipsis("... on Query")).toBe(false);
	});
});

describe("the folder rule", () => {
	it("refuses folder as a word in copy", () => {
		expect(hasFolderWord("Folder", "src/a.tsx")).toBe(true);
		expect(hasFolderWord("Sub-folders", "src/a.tsx")).toBe(true);
		expect(hasFolderWord("1 folder or collection has a setting", "src/a.tsx")).toBe(true);
		expect(hasFolderWord("Move the focused row out of its folder", "src/a.tsx")).toBe(true);
	});

	it("passes the words that carry the same meaning, and a longer word", () => {
		expect(hasFolderWord("Nested collection", "src/a.tsx")).toBe(false);
		expect(hasFolderWord("Move the row out of its collection", "src/a.tsx")).toBe(false);
		expect(hasFolderWord("folderStrategy", "src/a.tsx")).toBe(false);
	});

	it("passes an identifier: an exact lower-case word or a hyphenated id", () => {
		expect(hasFolderWord("folder", "src/a.tsx")).toBe(false);
		expect(hasFolderWord("allow-folder", "src/a.tsx")).toBe(false);
		expect(hasFolderWord("new-folder-form", "src/a.tsx")).toBe(false);
		expect(hasFolderWord("folder:", "src/a.tsx")).toBe(false);
	});

	it("passes a directory on disk only in the file that lists the phrase", () => {
		const file = "src/modules/settings/main/panels/GeneralPanel.tsx";
		expect(hasFolderWord("Couldn't open the logs folder - ", file)).toBe(false);
		expect(hasFolderWord("Couldn't open the logs folder - ", "src/a.tsx")).toBe(true);
		// A second, unlisted use in the same string is still a breach.
		expect(hasFolderWord("Open the logs folder in a folder tree", file)).toBe(true);
	});
});
