/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { formatGraphqlDocument } from "./format";

describe("formatGraphqlDocument", () => {
	/*
	 * The defect this module exists for. `print(parse(text))` returned a document
	 * with every `#` line gone, so Format Document was a delete button for
	 * comments - reverting to the AST round trip reddens this and nothing else.
	 */
	it("keeps comments, on their own line and trailing", async () => {
		const formatted = await formatGraphqlDocument(
			"query Q($a: Int) {\n# why we ask\nuser(id: $a) { name # the display one\n}\n}"
		);
		expect(formatted).toContain("# why we ask");
		expect(formatted).toContain("# the display one");
	});

	it("still reindents", async () => {
		const formatted = await formatGraphqlDocument("query    {   user(id: 1)    { name } }");
		expect(formatted).toBe("query {\n  user(id: 1) {\n    name\n  }\n}\n");
	});

	it("returns null rather than mangling a document mid-edit", async () => {
		expect(await formatGraphqlDocument("query { user(id: ")).toBeNull();
	});

	it("returns null for empty and whitespace-only text", async () => {
		// Null, not "", so the caller pushes no undo entry for a no-op edit.
		expect(await formatGraphqlDocument("")).toBeNull();
		expect(await formatGraphqlDocument("  \n ")).toBeNull();
	});
});
