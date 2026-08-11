/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { parse, validate, type GraphQLSchema } from "graphql";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import {
	insertField,
	insertFragment,
	insertionForNode,
	isAlreadyPresent,
	isRefusal,
	mergeVariables,
	type DocumentInsertion,
	type InsertAlreadyPresent,
	type InsertResult,
} from "./insert-skeleton";
import {
	buildSearchIndex,
	childNodes,
	schemaBranches,
	searchSchema,
	type SchemaTreeNode,
} from "./schema-tree";

const schema: GraphQLSchema = fixtureSchema();

/** Unwrap an insertion, failing loudly when it was refused or already there. */
function inserted(result: InsertResult): DocumentInsertion {
	if (isRefusal(result)) throw new Error(`refused: ${result.reason}`);
	if (isAlreadyPresent(result)) throw new Error(`already present: ${result.label}`);
	return result;
}

/**
 * The whole point of the module: whatever it writes has to be a document the
 * server would accept. Parsing proves syntax, validating proves the schema
 * agrees - including that every `$variable` used is declared, which is the rule
 * a naive inserter breaks.
 */
function expectValid(document: string) {
	const errors = validate(schema, parse(document));
	expect(errors.map((e) => e.message)).toEqual([]);
}

describe("insertField - a root field with no document", () => {
	it("writes a named operation with typed variables and scalar leaves", () => {
		const result = inserted(
			insertField(schema, "", 0, {
				parentTypeName: "Query",
				fieldName: "user",
				rootPath: [{ parentTypeName: "Query", fieldName: "user" }],
			})
		);

		expect(result.placement).toBe("new-operation");
		expect(result.text).toContain("query User($id: ID!)");
		expect(result.text).toContain("user(id: $id)");
		// Scalar leaves selected; `posts` is an object field and is left out.
		expect(result.text).toContain("id");
		expect(result.text).toContain("handle");
		expect(result.text).not.toContain("posts");
		expectValid(result.text);
	});

	it("does not select a deprecated field", () => {
		const result = inserted(
			insertField(schema, "", 0, {
				parentTypeName: "Query",
				fieldName: "user",
				rootPath: [{ parentTypeName: "Query", fieldName: "user" }],
			})
		);
		// `User.nickname` is `@deprecated(reason: "Use handle.")`. It browses in
		// the tree; it does not get written into a new operation.
		expect(result.text).not.toContain("nickname");
	});

	it("seeds a placeholder of the right JSON shape per variable type", () => {
		const result = inserted(
			insertField(schema, "", 0, {
				parentTypeName: "Query",
				fieldName: "search",
				rootPath: [{ parentTypeName: "Query", fieldName: "search" }],
			})
		);
		// `term: String!` is required; `ranking` has a default and is left out.
		expect(result.variables).toEqual({ term: "" });
		expect(result.text).not.toContain("ranking:");
	});

	it("puts the caret inside the new selection set", () => {
		const result = inserted(
			insertField(schema, "", 0, {
				parentTypeName: "Query",
				fieldName: "user",
				rootPath: [{ parentTypeName: "Query", fieldName: "user" }],
			})
		);
		const head = result.text.slice(0, result.cursor);
		expect(head.split("{").length).toBeGreaterThan(head.split("}").length);
	});
});

describe("insertField - into the document the cursor is in", () => {
	const doc = `query Existing {\n  user(id: "1") {\n    id\n  }\n}\n`;

	it("adds a sibling field to the selection set holding the cursor", () => {
		const cursor = doc.indexOf("id\n  }");
		const result = inserted(
			insertField(schema, doc, cursor, {
				parentTypeName: "User",
				fieldName: "name",
				rootPath: [
					{ parentTypeName: "Query", fieldName: "user" },
					{ parentTypeName: "User", fieldName: "name" },
				],
			})
		);

		expect(result.placement).toBe("cursor");
		// Only the remaining suffix is written - `user` is not duplicated.
		expect(result.text.match(/user\(/g)).toHaveLength(1);
		expect(result.text).toContain("name");
		expectValid(result.text);
	});

	it("declares the variables it introduces on the operation it edited", () => {
		const cursor = doc.indexOf("id\n  }");
		const result = inserted(
			insertField(schema, doc, cursor, {
				parentTypeName: "User",
				fieldName: "posts",
				rootPath: [
					{ parentTypeName: "Query", fieldName: "user" },
					{ parentTypeName: "User", fieldName: "posts" },
				],
			})
		);
		// `posts(first: Int = 10, filter: PostFilter)` has no required argument,
		// so nothing is declared and the operation keeps its shape.
		expect(result.variables).toEqual({});
		expectValid(result.text);
	});

	it("promotes a shorthand operation so its new variable can be declared", () => {
		const shorthand = `{\n  search(term: "x") {\n    __typename\n  }\n}\n`;
		const cursor = shorthand.indexOf("__typename");
		const result = inserted(
			insertField(schema, shorthand, cursor, {
				parentTypeName: "Query",
				fieldName: "user",
				rootPath: [{ parentTypeName: "Query", fieldName: "user" }],
			})
		);

		expect(result.text).toContain("query ($id: ID!)");
		expectValid(result.text);
	});

	it("does not reuse a variable name the operation already declares", () => {
		const withVar = `query Existing($id: ID!) {\n  user(id: $id) {\n    id\n  }\n}\n`;
		const cursor = withVar.indexOf("user(");
		const result = inserted(
			insertField(schema, withVar, cursor, {
				parentTypeName: "Query",
				fieldName: "node",
				rootPath: [{ parentTypeName: "Query", fieldName: "node" }],
			})
		);

		expect(result.text).toContain("$id2: ID!");
		expect(Object.keys(result.variables)).toEqual(["id2"]);
		expectValid(result.text);
	});
});

describe("insertField - a leaf the set already selects", () => {
	const doc = `query Existing {\n  user(id: "1") {\n    id\n    handle\n  }\n}\n`;
	const inUserSet = doc.indexOf("handle");
	const handleRow = {
		parentTypeName: "User",
		fieldName: "handle",
		rootPath: [
			{ parentTypeName: "Query", fieldName: "user" },
			{ parentTypeName: "User", fieldName: "handle" },
		],
	};

	it("reports where it already is rather than writing it twice", () => {
		const result = insertField(schema, doc, inUserSet, handleRow);

		// Mutation check: drop the `presentLeaf` branch in `insertField` and this
		// is a `DocumentInsertion` whose text carries `handle` on two lines.
		expect(isAlreadyPresent(result)).toBe(true);
		const present = result as InsertAlreadyPresent;
		expect(present.label).toBe("handle");
		expect(doc.slice(present.start, present.end)).toBe("handle");
	});

	it("still inserts a leaf the set does not have", () => {
		const result = inserted(
			insertField(schema, doc, inUserSet, {
				parentTypeName: "User",
				fieldName: "name",
				rootPath: [
					{ parentTypeName: "Query", fieldName: "user" },
					{ parentTypeName: "User", fieldName: "name" },
				],
			})
		);
		expect(result.text).toContain("name");
		expectValid(result.text);
	});

	it("leaves an aliased selection out of it - that is a different response key", () => {
		const aliased = `query Existing {\n  user(id: "1") {\n    id\n    shown: handle\n  }\n}\n`;
		const result = insertField(schema, aliased, aliased.indexOf("shown"), handleRow);

		expect(isAlreadyPresent(result)).toBe(false);
		expect(inserted(result).text.match(/handle/g)).toHaveLength(2);
	});

	it("says nothing about a leaf that takes an argument, which can honestly repeat", () => {
		// `deletePost(id: ID!): Boolean` is a leaf, but a second call with another
		// id is a different call - not the duplicate line this branch exists for.
		const mutation = `mutation Existing($id: ID!) {\n  deletePost(id: $id)\n}\n`;
		const result = insertField(schema, mutation, mutation.indexOf("deletePost"), {
			parentTypeName: "Mutation",
			fieldName: "deletePost",
			rootPath: [{ parentTypeName: "Mutation", fieldName: "deletePost" }],
		});

		expect(isAlreadyPresent(result)).toBe(false);
		expect(inserted(result).text.match(/deletePost/g)).toHaveLength(2);
	});

	it("says nothing about an object field, whose second copy brings its own selection", () => {
		const outer = doc.indexOf("user(");
		const result = insertField(schema, doc, outer, {
			parentTypeName: "Query",
			fieldName: "user",
			rootPath: [{ parentTypeName: "Query", fieldName: "user" }],
		});

		expect(isAlreadyPresent(result)).toBe(false);
	});
});

describe("insertField - when the cursor is in the wrong place", () => {
	it("falls back to an enclosing set when the innermost one is incompatible", () => {
		const doc = `query Existing {\n  user(id: "1") {\n    id\n  }\n}\n`;
		// Cursor inside `User`, inserting a `Query` field: the enclosing Query
		// selection set is where it belongs.
		const cursor = doc.indexOf("id\n  }");
		const result = inserted(
			insertField(schema, doc, cursor, {
				parentTypeName: "Query",
				fieldName: "search",
				rootPath: [{ parentTypeName: "Query", fieldName: "search" }],
			})
		);

		expect(result.placement).toBe("ancestor");
		expectValid(result.text);
	});

	it("appends a new operation when the document does not parse", () => {
		const broken = "query Broken { user(id: ";
		const result = inserted(
			insertField(schema, broken, broken.length, {
				parentTypeName: "Query",
				fieldName: "search",
				rootPath: [{ parentTypeName: "Query", fieldName: "search" }],
			})
		);

		expect(result.placement).toBe("new-operation");
		// The broken text is kept verbatim - an insertion is not a reason to
		// delete what the user was typing.
		expect(result.text.startsWith(broken)).toBe(true);
	});

	it("names the appended operation around one the document already uses", () => {
		const doc = `query Search {\n  __typename\n}\n`;
		const result = inserted(
			insertField(schema, doc, 0, {
				parentTypeName: "Query",
				fieldName: "search",
				rootPath: [{ parentTypeName: "Query", fieldName: "search" }],
			})
		);

		expect(result.text).toContain("query Search2(");
		expectValid(result.text);
	});

	it("refuses a path-less row with nowhere to go, and says why", () => {
		const doc = `query Existing {\n  search(term: "x") {\n    __typename\n  }\n}\n`;
		const result = insertField(schema, doc, doc.indexOf("__typename"), {
			parentTypeName: "User",
			fieldName: "handle",
			rootPath: null,
		});

		expect(isRefusal(result)).toBe(true);
		if (isRefusal(result)) expect(result.reason).toContain("User");
	});

	it("accepts a path-less row when the cursor is already in that type", () => {
		const doc = `query Existing {\n  user(id: "1") {\n    id\n  }\n}\n`;
		const result = inserted(
			insertField(schema, doc, doc.indexOf("id\n  }"), {
				parentTypeName: "User",
				fieldName: "handle",
				rootPath: null,
			})
		);

		expect(result.text).toContain("handle");
		expectValid(result.text);
	});
});

describe("insertField - a document holding {{variables}}", () => {
	it("still finds the selection set, rather than treating the query as broken", () => {
		const doc = `query Existing {\n  user(id: "{{userId}}") {\n    id\n  }\n}\n`;
		const result = inserted(
			insertField(schema, doc, doc.indexOf("id\n  }"), {
				parentTypeName: "User",
				fieldName: "name",
				rootPath: [
					{ parentTypeName: "Query", fieldName: "user" },
					{ parentTypeName: "User", fieldName: "name" },
				],
			})
		);

		expect(result.placement).toBe("cursor");
		// The token survives the round trip untouched.
		expect(result.text).toContain("{{userId}}");
		expect(result.text).toContain("name");
	});
});

describe("insertField - a mutation", () => {
	it("writes a mutation operation, not a query", () => {
		const result = inserted(
			insertField(schema, "", 0, {
				parentTypeName: "Mutation",
				fieldName: "createPost",
				rootPath: [{ parentTypeName: "Mutation", fieldName: "createPost" }],
			})
		);

		expect(result.text.startsWith("mutation CreatePost(")).toBe(true);
		expect(result.variables).toEqual({ input: {} });
		expectValid(result.text);
	});
});

describe("insertFragment", () => {
	it("writes a fragment on the type with its scalar fields", () => {
		const result = inserted(insertFragment(schema, "", "Post"));

		expect(result.placement).toBe("fragment");
		expect(result.text).toContain("fragment PostFields on Post");
		expect(result.text).toContain("title");
		expect(parse(result.text)).toBeTruthy();
	});

	it("gives a union fragment __typename, since a union has no fields", () => {
		const result = inserted(insertFragment(schema, "", "SearchResult"));
		expect(result.text).toContain("__typename");
		expect(parse(result.text)).toBeTruthy();
	});

	it("does not collide with a fragment the document already defines", () => {
		const doc = `fragment PostFields on Post {\n  id\n}\n`;
		const result = inserted(insertFragment(schema, doc, "Post"));
		expect(result.text).toContain("fragment PostFields2 on Post");
	});

	it("refuses a type a fragment cannot be written on", () => {
		const result = insertFragment(schema, "", "Ranking");
		expect(isRefusal(result)).toBe(true);
	});
});

/**
 * The two kinds the search index gained: browsable in the tree, and now
 * findable by name. Neither is reachable from a root operation type, so both
 * arrive with a null `rootPath` - and the refusal has to be asserted rather
 * than assumed, because a search result is the one way into this module that
 * does not come from expanding a row.
 */
describe("insertionForNode - a row found by search", () => {
	const index = buildSearchIndex(schema);

	/** The node the search box would hand the pane for this name. */
	function searched(name: string): SchemaTreeNode {
		const found = searchSchema(index, name).find((m) => m.node.name === name);
		if (!found) throw new Error(`search did not find ${name}`);
		return found.node;
	}

	/** The same row reached the way a user browses to it: Types -> owner -> row. */
	function browsed(typeName: string, name: string): SchemaTreeNode {
		const types = schemaBranches(schema).find((b) => b.branch === "types");
		if (!types) throw new Error("no types branch");
		const owner = childNodes(schema, types).find((t) => t.name === typeName);
		if (!owner) throw new Error(`no type ${typeName}`);
		const found = childNodes(schema, owner).find((c) => c.name === name);
		if (!found) throw new Error(`no ${name} on ${typeName}`);
		return found;
	}

	it("refuses an enum value out loud, naming it", () => {
		const result = insertionForNode(schema, searched("RELEVANCE"), "", 0);
		expect(result && isRefusal(result)).toBe(true);
		if (result && isRefusal(result)) {
			expect(result.reason).toContain("RELEVANCE");
			expect(result.reason).toContain("part of an argument");
		}
	});

	it("refuses an input-object field out loud, naming it", () => {
		const result = insertionForNode(schema, searched("authorId"), "", 0);
		expect(result && isRefusal(result)).toBe(true);
		if (result && isRefusal(result)) expect(result.reason).toContain("authorId");
	});

	it("refuses with the same words the Types branch gets, from either route", () => {
		/*
		 * The contract this issue turns on: a search result must not be a second
		 * way in with its own answer. If the search node ever gained a rootPath,
		 * this row would insert instead of refusing and these would diverge.
		 */
		for (const [owner, name] of [
			["Ranking", "RELEVANCE"],
			["PostFilter", "authorId"],
		]) {
			const fromSearch = insertionForNode(schema, searched(name), "", 0);
			const fromTree = insertionForNode(schema, browsed(owner, name), "", 0);
			expect(fromSearch).toEqual(fromTree);
		}
	});

	it("still inserts a root field found by search, so the refusal is not blanket", () => {
		const result = inserted(insertionForNode(schema, searched("search"), "", 0)!);
		expect(result.text).toContain("query Search");
		expectValid(result.text);
	});
});

describe("mergeVariables", () => {
	it("writes the object into an empty pane", () => {
		const { text, pending } = mergeVariables("", { id: "" });
		expect(JSON.parse(text)).toEqual({ id: "" });
		expect(pending).toEqual([]);
	});

	it("merges into strict JSON without replacing a value already there", () => {
		const { text, pending } = mergeVariables('{"id": "42"}', { id: "", term: "" });
		expect(JSON.parse(text)).toEqual({ id: "42", term: "" });
		expect(pending).toEqual([]);
	});

	it("never touches a templated pane, and reports what it could not write", () => {
		const draft = '{"id": {{userId}}}';
		const { text, pending } = mergeVariables(draft, { term: "" });
		expect(text).toBe(draft);
		expect(pending).toEqual(["term"]);
	});

	it("never touches text that is mid-edit and not yet JSON", () => {
		const draft = '{"id": ';
		const { text, pending } = mergeVariables(draft, { term: "" });
		expect(text).toBe(draft);
		expect(pending).toEqual(["term"]);
	});

	it("leaves a JSON array alone - the pane must hold an object", () => {
		const { text, pending } = mergeVariables("[1, 2]", { term: "" });
		expect(text).toBe("[1, 2]");
		expect(pending).toEqual(["term"]);
	});

	it("does nothing at all when there are no variables to write", () => {
		const draft = '{"id": {{userId}}}';
		expect(mergeVariables(draft, {})).toEqual({ text: draft, pending: [] });
	});
});
