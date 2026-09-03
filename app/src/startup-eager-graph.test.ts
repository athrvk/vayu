/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What may be reached from the renderer's entry, and what may not (#1146).
 *
 * The entry chunk is everything the window has to parse before it can appear,
 * and it grew to 5.5MB one ordinary-looking import at a time: a side-effecting
 * `monaco-setup` line at the top of `main.tsx`, eight statically imported tab
 * surfaces, a markdown pipeline reached through the `ui` barrel. Each was
 * correct on its own and none of them looks like a startup cost at the call
 * site.
 *
 * That is why these are scans. The boundaries themselves are covered by
 * behaviour - `monaco-loader.test.tsx` proves subscribing does not load,
 * `code-editor.loading.test.tsx` proves the editor waits - but nothing a test
 * renders can see a *static import* re-appear, and the rendered result is
 * identical either way. The cost shows up only in a build.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));

function read(...segments: string[]): string {
	const source = readFileSync(join(SRC, ...segments), "utf8");
	// A scan that reads an empty string passes everything. Every case below
	// depends on this having found real source.
	expect(source.length).toBeGreaterThan(500);
	return source;
}

/** Surfaces `Shell` must not pull into the entry, and the module each lives in. */
const LAZY_SURFACES = [
	"@/modules/collections/CollectionDetail",
	"@/modules/dashboard",
	"@/modules/history/main/HistoryDetail",
	"@/modules/welcome/WelcomeScreen",
	"@/modules/settings/main/SettingsMain",
	"@/modules/variables/main/VariablesMain",
	"@/modules/inbox",
];

describe("Monaco stays off the startup path", () => {
	it("is not imported by the renderer entry", () => {
		const main = read("main.tsx");

		// The exact line this issue removed. It looks harmless - a side-effecting
		// import for worker wiring - and it cost ~4MB of parse before first paint.
		expect(main).not.toContain("monaco-setup");
	});

	it("is reached only through the loader, and only dynamically", () => {
		const loader = read("lib", "monaco-loader.ts");

		expect(loader).toContain('import("./monaco-setup")');
		// A static import in the loader would put monaco back in whatever chunk
		// imports the loader - which is the editor, which is the `ui` barrel.
		expect(loader).not.toMatch(/^import .*monaco-setup/m);
	});
});

describe("Shell's tab surfaces are lazy", () => {
	const shell = read("components", "layout", "Shell.tsx");

	it.each(LAZY_SURFACES)("loads %s through a dynamic import", (surface) => {
		expect(shell).toContain(`import("${surface}")`);
		expect(shell).not.toMatch(new RegExp(`^import .*from "${surface}";`, "m"));
	});

	it("keeps RequestBuilder eager, which is the surface most starts open into", () => {
		expect(shell).toMatch(/^import RequestBuilder from "@\/modules\/request-builder";$/m);
	});
});

describe("the always-mounted chrome does not defeat the split", () => {
	it("Drawer takes the settings tree from its own file, not the module barrel", () => {
		const drawer = read("components", "layout", "Drawer.tsx");

		// `@/modules/settings` also exports `SettingsMain`, and a barrel is one
		// module: importing it here made Shell's dynamic import of the settings
		// surface an INEFFECTIVE_DYNAMIC_IMPORT, which the build says out loud
		// and nothing else would have caught.
		expect(drawer).toContain("@/modules/settings/sidebar/SettingsCategoryTree");
		expect(drawer).not.toMatch(/from "@\/modules\/settings";/);
	});

	it("the context bar loads its GraphQL section rather than importing it", () => {
		const registry = read("components", "layout", "context-bar", "registry.ts");

		// The bar is mounted on every tab, and this section is the only one that
		// reaches the `graphql` package - the parser and the type system, ~320KB
		// of source, for a section most sessions never expand.
		expect(registry).toContain('import("./GraphQLSection")');
		expect(registry).not.toMatch(/^import \{ GraphQLSection \}/m);
	});

	it("keeps the GraphQL section's relevance hook out of the section's own file", () => {
		// The registry has to name `useRelevance` eagerly - it is a field on a
		// plain array entry, evaluated at module load - so a hook exported from
		// `GraphQLSection.tsx` would import the parser into the entry chunk
		// through the back door and quietly undo the split the case above
		// guards. `relevance.ts` reads `request.bodyType` and nothing else.
		const relevance = read("components", "layout", "context-bar", "relevance.ts");

		expect(relevance).toContain("useGraphQLRelevance");
		expect(relevance).not.toContain("./GraphQLSection");
		expect(relevance).not.toMatch(/from "graphql/);
	});

	it("the settings registry the tree reads holds data, not panels", () => {
		const registry = read("modules", "settings", "main", "app-panels.ts");

		// Avoiding the barrel was not enough on its own: the category tree reads
		// this registry for labels and icons, and a `Component` field here
		// imported all eight panels into the entry chunk from an always-mounted
		// Drawer - a lazy `SettingsMain` around code that had already arrived.
		// The components live in `app-panel-components.ts`, which only
		// `SettingsMain` and its drift guard import.
		expect(registry).not.toMatch(/from "\.\/panels\//);
		expect(read("modules", "settings", "main", "app-panel-components.ts")).toMatch(
			/from "\.\/panels\//
		);
	});
});

describe("the markdown pipeline is lazy", () => {
	it("is reached only through MarkdownView's boundary", () => {
		const view = read("components", "ui", "markdown-view.tsx");

		expect(view).toContain('lazy(() => import("./markdown-renderer"))');
		// remark/rehype belong to the renderer module alone: imported here they
		// would ride the `ui` barrel into the entry again. Matched as imports,
		// not as words - the file names them in prose, which is fine.
		expect(view).not.toMatch(/^import .*"(react-markdown|remark-|rehype-)/m);
	});
});
