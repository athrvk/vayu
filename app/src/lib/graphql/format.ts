/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Format Document for GraphQL, keeping the user's comments. Not `print(parse(text))`: graphql-js's
 * AST has nowhere to hang a `#` comment, so that round trip removes every one, and a formatter must
 * never be destructive. Preserving comments is possible, so withdrawing the command would be the
 * lazier half of "never lie".
 *
 * Prettier's GraphQL parser keeps comments and is already in the tree. Loaded on demand, not at
 * module scope: most sessions never invoke Format Document, and a static import would put the whole
 * formatter in the startup bundle. Vite splits the dynamic import into its own chunk, so the first
 * format pays the cost.
 */

/**
 * The formatted document, or null when it cannot be formatted (unparseable input, the normal
 * mid-edit case). Null, not the original text, so the caller can skip the edit rather than replace
 * the document with itself, which would push an undo entry for a no-op.
 */
export async function formatGraphqlDocument(text: string): Promise<string | null> {
	if (!text.trim()) return null;
	try {
		const [prettier, graphqlPlugin] = await Promise.all([
			import("prettier/standalone"),
			import("prettier/plugins/graphql"),
		]);
		return await prettier.format(text, {
			parser: "graphql",
			plugins: [graphqlPlugin.default ?? graphqlPlugin],
		});
	} catch {
		// A syntax error mid-edit, or the chunk failed to load. Either way the
		// honest answer is to leave the document exactly as the user has it.
		return null;
	}
}
