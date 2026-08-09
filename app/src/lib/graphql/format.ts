/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Format Document for GraphQL, without deleting the user's comments.
 *
 * It used to be `print(parse(text))`. graphql-js's AST has nowhere to hang a
 * `#` comment, so the round trip silently removed every one of them - a
 * *destructive* formatter, which is the one thing a formatter may never be. The
 * options were to preserve comments or to withdraw the command; preserving them
 * is possible, so withdrawing would have been the lazier half of "never lie".
 *
 * Prettier's GraphQL parser keeps comments and is already in the tree. It is
 * loaded on demand rather than imported at module scope: Format Document is a
 * command most sessions never invoke, and a static import would put the whole
 * formatter in the startup bundle for all of them. Vite splits the dynamic
 * import into its own chunk, so the cost is paid by the first format and not
 * before.
 */

/**
 * The formatted document, or null when it cannot be formatted.
 *
 * Null - not the original text - so the caller can skip the edit entirely
 * rather than replace the document with itself, which would push an undo entry
 * for a no-op. Unparseable input lands here, which is the normal mid-edit case.
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
