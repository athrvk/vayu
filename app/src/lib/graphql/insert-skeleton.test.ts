/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { buildSchema, parse, validate, type GraphQLSchema } from "graphql";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import {
	insertArgument,
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
	rootPathsToType,
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

describe("a cursor inside an inline fragment", () => {
	/**
	 * The Relay-shaped case: `Query.node: Node` is the only route to a `Post`, so
	 * the document the app itself writes narrows with `... on Post` - and until
	 * the chain descended through it, a cursor in there was read at `Node`.
	 */
	const inFragment = `query E($id: ID!) {\n  node(id: $id) {\n    ... on Post {\n      id\n    }\n  }\n}\n`;
	const insideFragment = inFragment.indexOf("id\n    }");

	/** The route the explorer hands over for a `Post` field reached via `node`. */
	function postStep(fieldName: string) {
		const viaNode = rootPathsToType(schema, "Post").find((p) => p[0].fieldName === "node")!;
		return {
			parentTypeName: "Query",
			fieldName: "node",
			rootPath: [...viaNode, { parentTypeName: "Post", fieldName: fieldName }],
		};
	}

	it("adds the field beside the one in the fragment, not a second copy of the route", () => {
		/*
		 * Mutation check: stop `descend` at an inline fragment and this reddens
		 * with two `node(` selections and a `$id2` to fill in - the whole route
		 * written again beside the one the user is looking at.
		 */
		const result = inserted(insertField(schema, inFragment, insideFragment, postStep("title")));

		expect(result.placement).toBe("cursor");
		expect(result.text.match(/node\(/g)).toHaveLength(1);
		expect(result.variables).toEqual({});
		expect(result.text).toContain("... on Post {\n      id\n      title\n    }");
		expectValid(result.text);
	});

	it("still walks outward for a field the fragment's type does not own", () => {
		// `Query.search` is not on `Post`: the narrowed set is the wrong host and
		// the enclosing Query set is the right one.
		const result = inserted(
			insertField(schema, inFragment, insideFragment, {
				parentTypeName: "Query",
				fieldName: "search",
				rootPath: [{ parentTypeName: "Query", fieldName: "search" }],
			})
		);

		expect(result.placement).toBe("ancestor");
		// The route the document already has is not written again: one `node(`,
		// the `$id` it declared, and only the new field's own variable beside it.
		expect(result.variables).toEqual({ term: "" });
		expect(result.text.match(/node\(/g)).toHaveLength(1);
		expect(result.text).not.toContain("$id2");
		expectValid(result.text);
	});

	it("keeps the enclosing type when the fragment narrows nothing", () => {
		/*
		 * `... @include(if:)` is a legal fragment with no type condition. It does
		 * not narrow, so the set is still read at `User` - reading a missing type
		 * condition as a narrowing would be the guessing this module refuses.
		 */
		const doc = `query E($id: ID!, $flag: Boolean!) {\n  user(id: $id) {\n    ... @include(if: $flag) {\n      id\n    }\n  }\n}\n`;
		const result = inserted(
			insertField(schema, doc, doc.indexOf("id\n    }"), {
				parentTypeName: "User",
				fieldName: "handle",
				rootPath: [
					{ parentTypeName: "Query", fieldName: "user" },
					{ parentTypeName: "User", fieldName: "handle" },
				],
			})
		);

		expect(result.placement).toBe("cursor");
		expect(result.text).toContain("... @include(if: $flag) {\n      id\n      handle\n    }");
		expectValid(result.text);
	});

	it("writes an argument onto the selection inside the fragment", () => {
		// The argument row (#1322) reaches the document through the same chain, so
		// it lands on the `posts` in the fragment rather than inserting a route.
		const doc = `query E($id: ID!) {\n  node(id: $id) {\n    ... on User {\n      posts {\n        id\n      }\n    }\n  }\n}\n`;
		const result = inserted(
			insertArgument(schema, doc, doc.indexOf("posts {"), {
				parentTypeName: "User",
				fieldName: "posts",
				argumentName: "first",
				rootPath: null,
			})
		);

		expect(result.placement).toBe("argument");
		expect(result.text).toContain("posts(first: $first)");
		expect(result.text.match(/node\(/g)).toHaveLength(1);
		expectValid(result.text);
	});

	it("spreads a fragment into the narrowed set, not the interface set above it", () => {
		/*
		 * `spreadHost` prefers an exact type match over a merely overlapping one,
		 * and the exact one is the `... on Post` the cursor is in. Mutation check:
		 * stop the descent and the spread lands in the `Node` set instead, which
		 * is legal and is not where the user was looking.
		 */
		const result = inserted(insertFragment(schema, inFragment, insideFragment, "Post"));

		expect(result.text).toContain("fragment PostFields on Post");
		// Inside the narrowed braces, beside `id` - not after them, in the `Node`
		// set, which is where an overlap-only host puts it.
		expect(result.text).toContain("... on Post {\n      id\n      ...PostFields\n    }");
		expectValid(result.text);
	});

	it("finds a host for a fragment the narrowed set only overlaps, rather than refusing", () => {
		/*
		 * A fragment on `Node` is legal inside `... on Post` - `doTypesOverlap`
		 * says so - so there is a host and the click is answered.
		 *
		 * Where it lands is `spreadHost`'s existing tie-break, untouched here: an
		 * exact type match wins over an overlapping one, and the exact `Node` set
		 * is the one *outside* the fragment, so that is where the spread goes.
		 * Preferring the nearer set would be a change to that rule rather than to
		 * the chain this fix repairs (#1350).
		 */
		const result = inserted(insertFragment(schema, inFragment, insideFragment, "Node"));

		expect(result.text).toContain("fragment NodeFields on Node");
		expect(result.text.match(/node\(/g)).toHaveLength(1);
		expect(result.text).toContain("...NodeFields");
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
	/** A document whose innermost selection set is a `Post`, cursor inside it. */
	const inPost = `mutation Draft($input: CreatePostInput!) {\n  createPost(input: $input) {\n    id\n  }\n}\n`;
	const postCursor = inPost.indexOf("id\n  }");

	it("writes a fragment on the type with its scalar fields", () => {
		const result = inserted(insertFragment(schema, inPost, postCursor, "Post"));

		expect(result.placement).toBe("fragment");
		expect(result.text).toContain("fragment PostFields on Post");
		expect(result.text).toContain("title");
		expectValid(result.text);
	});

	it("spreads the fragment it wrote, since an unused one fails validation", () => {
		/*
		 * `Fragment "X" is never used` rejects the whole request, the operation
		 * the user already had included. Mutation check: drop the spread edit and
		 * `expectValid` reddens with exactly that message while the document
		 * still parses - which is why parsing was never the test to run here.
		 */
		const result = inserted(insertFragment(schema, inPost, postCursor, "Post"));

		expect(result.text).toContain("...PostFields");
		expectValid(result.text);
	});

	it("gives a union fragment __typename, since a union has no fields", () => {
		const doc = `query Draft {\n  search(term: "x") {\n    __typename\n  }\n}\n`;
		const result = inserted(
			insertFragment(schema, doc, doc.indexOf("__typename"), "SearchResult")
		);

		expect(result.text).toContain("fragment SearchResultFields on SearchResult");
		expect(result.text).toContain("__typename");
		expectValid(result.text);
	});

	it("does not collide with a fragment the document already defines", () => {
		const doc = `${inPost}\nfragment PostFields on Post {\n  id\n}\n`;
		const result = inserted(insertFragment(schema, doc, doc.indexOf("id\n  }"), "Post"));
		expect(result.text).toContain("fragment PostFields2 on Post");
		expect(result.text).toContain("...PostFields2");
	});

	it("spreads into an interface selection, the case fragments exist for", () => {
		/*
		 * `fragment PostFields on Post` belongs inside a `Query.node: Node`
		 * selection - Post implements Node - and an equality test on the host
		 * refuses it while the user is looking straight at the set it goes in.
		 * Mutation check: require `host.typeName === typeName` and this refuses.
		 */
		const doc = `query Existing {\n  node(id: "1") {\n    id\n  }\n}\n`;
		const result = inserted(insertFragment(schema, doc, doc.indexOf("id\n  }"), "Post"));

		expect(result.text).toContain("...PostFields");
		expect(result.text).toContain("fragment PostFields on Post");
		expectValid(result.text);
	});

	it("spreads into a union selection the type is a member of", () => {
		const doc = `query Existing {\n  search(term: "x") {\n    __typename\n  }\n}\n`;
		const result = inserted(insertFragment(schema, doc, doc.indexOf("__typename"), "User"));

		expect(result.text).toContain("...UserFields");
		expectValid(result.text);
	});

	it("prefers the set that is exactly the type over one it merely overlaps", () => {
		// Both are on the chain: the User set inside the Node set. The one the
		// user is in wins over the one the spread is only legal in.
		const doc = `query Existing {\n  user(id: "1") {\n    id\n  }\n  node(id: "2") {\n    id\n  }\n}\n`;
		const result = inserted(insertFragment(schema, doc, doc.indexOf("id\n  }"), "User"));

		// The spread landed in `user`, not in `node`.
		const spreadAt = result.text.indexOf("...UserFields");
		expect(spreadAt).toBeGreaterThan(-1);
		expect(spreadAt).toBeLessThan(result.text.indexOf("node(id:"));
		expectValid(result.text);
	});

	it("refuses when nothing on screen selects the type, rather than orphaning it", () => {
		const doc = `query Draft {\n  ping: __typename\n}\n`;
		const result = insertFragment(schema, doc, doc.length - 1, "Post");

		expect(isRefusal(result)).toBe(true);
		if (isRefusal(result)) expect(result.reason).toContain("Post");
	});

	it("refuses a type a fragment cannot be written on", () => {
		const result = insertFragment(schema, inPost, postCursor, "Ranking");
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

	it("reaches a non-root field through the route that returns its owner", () => {
		/*
		 * `User.handle` is the commonest search result there is - a field on a
		 * type the user has not opened - and clicking it used to refuse whenever
		 * the cursor was not already inside a `User`. `Query.user` returns one,
		 * so the route exists and the click can take it.
		 */
		const result = inserted(insertionForNode(schema, searched("handle"), "", 0)!);

		expect(result.text).toContain("user(id: $id)");
		expect(result.text).toContain("handle");
		expectValid(result.text);
	});

	it("takes the same route from the Types branch as from the search box", () => {
		const fromSearch = insertionForNode(schema, searched("handle"), "", 0);
		const fromTree = insertionForNode(schema, browsed("User", "handle"), "", 0);
		expect(fromSearch).toEqual(fromTree);
	});

	it("still refuses a field nothing can reach, rather than inventing a route", () => {
		// `Orphan` is returned by no root field, so `Orphan.tag` has no route and
		// the refusal is the honest answer.
		const orphaned = buildSchema(`
			type Orphan { tag: String }
			type Query { ping: String }
		`);
		const tag = searchSchema(buildSearchIndex(orphaned), "tag").find(
			(m) => m.node.name === "tag"
		)!;
		const result = insertionForNode(orphaned, tag.node, "", 0);

		expect(result && isRefusal(result)).toBe(true);
		if (result && isRefusal(result)) expect(result.reason).toContain("Orphan");
	});
});

/**
 * A type row's whole job: answer "give me one of these" with something the user
 * can press Send on. It used to answer with a fragment, which on an empty
 * document is a file that parses and cannot be run.
 */
describe("insertionForNode - a type row", () => {
	/** The Types-branch row for a named type. */
	function typeRow(target: GraphQLSchema, name: string): SchemaTreeNode {
		const types = schemaBranches(target).find((b) => b.branch === "types");
		if (!types) throw new Error("no types branch");
		const found = childNodes(target, types).find((t) => t.name === name);
		if (!found) throw new Error(`no type ${name}`);
		return found;
	}

	it("inserts the query that returns the type, not a fragment", () => {
		const result = inserted(insertionForNode(schema, typeRow(schema, "User"), "", 0)!);

		expect(result.text).toContain("user(id: $id)");
		expect(result.text).not.toContain("fragment");
		expectValid(result.text);
	});

	it("uses a mutation when that is what returns the type", () => {
		const result = inserted(insertionForNode(schema, typeRow(schema, "Post"), "", 0)!);
		expect(result.text).toContain("mutation");
		expect(result.text).toContain("createPost(input: $input)");
		expectValid(result.text);
	});

	it("does not route through a deprecated root field when another exists", () => {
		// `Query.legacySearch` is deprecated; `Query.search` returns the same
		// union and is the route a click should take.
		const result = inserted(insertionForNode(schema, typeRow(schema, "SearchResult"), "", 0)!);
		expect(result.text).toContain("search(term: $term)");
		expect(result.text).not.toContain("legacySearch");
	});

	it("writes a fragment where its spread can go, and validates as a whole", () => {
		/*
		 * `Inner` is reachable only through `Outer`, so no root field returns it
		 * and there is no query to write - but a document can still be sitting
		 * inside one, which is exactly where a fragment on it belongs.
		 */
		const nested = buildSchema(`
			type Inner { tag: String }
			type Outer { inner: Inner }
			type Query { outer: Outer }
		`);
		const doc = `query Existing {\n  outer {\n    inner {\n      tag\n    }\n  }\n}\n`;
		const result = inserted(
			insertionForNode(nested, typeRow(nested, "Inner"), doc, doc.indexOf("tag"))!
		);

		expect(result.text).toContain("fragment InnerFields on Inner");
		expect(result.text).toContain("...InnerFields");
		expect(validate(nested, parse(result.text)).map((e) => e.message)).toEqual([]);
	});

	it("refuses rather than leaving a fragment with nothing to spread it", () => {
		const orphaned = buildSchema(`
			type Orphan { tag: String }
			type Query { ping: String }
		`);
		const result = insertionForNode(orphaned, typeRow(orphaned, "Orphan"), "", 0);

		expect(result && isRefusal(result)).toBe(true);
		if (result && isRefusal(result)) {
			expect(result.reason).toContain("Orphan");
			expect(result.reason).toContain("Put the cursor inside a selection");
		}
	});

	it("narrows with an inline fragment when the route runs through an interface", () => {
		/*
		 * `Query.node: Node` is the only way to reach some types on a Relay-shaped
		 * schema, and `title` is not on `Node` - so the selection is only legal
		 * inside `... on Post`. Mutation check: drop the narrowing from
		 * `renderSteps` and `expectValid` reddens with "Cannot query field title
		 * on type Node".
		 */
		const viaNode = rootPathsToType(schema, "Post").find((p) => p[0].fieldName === "node")!;
		const result = inserted(
			insertField(schema, "", 0, {
				parentTypeName: "Query",
				fieldName: "node",
				rootPath: [...viaNode, { parentTypeName: "Post", fieldName: "title" }],
			})
		);

		expect(result.text).toContain("... on Post");
		expect(result.text).toContain("title");
		expectValid(result.text);
	});

	it("selects the narrowed type's own fields, not the interface's", () => {
		// The step wants Post's scalars; the field's declared type is the Node
		// they are not on.
		const viaNode = rootPathsToType(schema, "Post").find((p) => p[0].fieldName === "node")!;
		const result = inserted(
			insertField(schema, "", 0, {
				parentTypeName: "Query",
				fieldName: "node",
				rootPath: viaNode,
			})
		);

		expect(result.text).toContain("... on Post");
		expect(result.text).toContain("body");
		expectValid(result.text);
	});

	it("keeps the reason a fragment is impossible at all", () => {
		// An enum can be neither queried for nor fragmented on; the wording that
		// says which is the fragment module's, and it survives the new routing.
		const result = insertionForNode(schema, typeRow(schema, "Ranking"), "", 0);
		expect(result && isRefusal(result)).toBe(true);
		if (result && isRefusal(result)) expect(result.reason).toContain("object, interface");
	});

	it("never leaves the document without an operation, over every type row", () => {
		const types = schemaBranches(schema).find((b) => b.branch === "types")!;
		const rows = childNodes(schema, types);
		// A guard that scanned nothing would pass forever.
		expect(rows.length).toBeGreaterThan(4);

		for (const row of rows) {
			const result = insertionForNode(schema, row, "", 0);
			if (!result || isRefusal(result) || isAlreadyPresent(result)) continue;
			const operations = parse(result.text).definitions.filter(
				(d) => d.kind === "OperationDefinition"
			);
			expect({ type: row.name, operations: operations.length }).toEqual({
				type: row.name,
				operations: 1,
			});
			expectValid(result.text);
		}
	});
});

/**
 * An argument row activates into an edit of the field that takes it.
 *
 * The row exists because an argument list drawn inline cost the result type its
 * width; making the rows *insertable* is what turns the text that was clipped
 * into the thing the user wanted from it.
 */
describe("insertionForNode - an argument row", () => {
	/** The Arguments row under a field, reached the way a user opens to it. */
	function argumentRow(path: string[], argument: string): SchemaTreeNode {
		const root = schemaBranches(schema).find((b) => b.branch === path[0]);
		if (!root) throw new Error(`no ${path[0]} branch`);
		let node: SchemaTreeNode = root;
		for (const step of path.slice(1)) {
			const next: SchemaTreeNode | undefined = childNodes(schema, node).find(
				(c) => c.name === step
			);
			if (!next) throw new Error(`no ${step} under ${node.name}`);
			node = next;
		}
		const args = childNodes(schema, node).find((c) => c.kind === "arguments");
		if (!args) throw new Error(`${node.name} takes no arguments`);
		const found = childNodes(schema, args).find((c) => c.name === argument);
		if (!found) throw new Error(`no argument ${argument}`);
		return found;
	}

	it("writes the argument onto the selection the document already has", () => {
		const doc = `query Existing {\n  user(id: "1") {\n    posts {\n      id\n    }\n  }\n}\n`;
		const result = inserted(
			insertionForNode(
				schema,
				argumentRow(["query", "user", "posts"], "first"),
				doc,
				doc.indexOf("id\n    }")
			)!
		);

		expect(result.text).toContain("posts(first: $first)");
		expect(result.text).toContain("query Existing($first: Int)");
		expect(result.variables).toEqual({ first: 0 });
		expect(result.placement).toBe("argument");
		expectValid(result.text);
	});

	it("leaves the caret on what it just wrote", () => {
		// Without a marker of its own the edit would report the end of the
		// document, which is where `applyEdits` puts an unmarked insertion.
		const doc = `query Existing {\n  user(id: "1") {\n    posts {\n      id\n    }\n  }\n}\n`;
		const result = inserted(
			insertionForNode(
				schema,
				argumentRow(["query", "user", "posts"], "first"),
				doc,
				doc.indexOf("id\n    }")
			)!
		);

		expect(result.text.slice(0, result.cursor)).toMatch(/first: \$first$/);
	});

	it("appends to an argument list the field already carries", () => {
		const doc = `query Existing {\n  search(term: $term) {\n    __typename\n  }\n}\n`;
		const result = inserted(
			insertionForNode(
				schema,
				argumentRow(["query", "search"], "ranking"),
				doc,
				doc.indexOf("__typename")
			)!
		);

		expect(result.text).toContain("search(term: $term, ranking: $ranking)");
		// An enum takes its first value: any of them parses and none is more
		// correct than another.
		expect(result.variables).toEqual({ ranking: "RELEVANCE" });
	});

	it("writes onto the occurrence the cursor is in, not the first of that name", () => {
		/*
		 * Two aliases of one field in one selection set. Mutation check: take the
		 * first match in document order instead of the one holding the cursor and
		 * this reddens - the edit lands on `latest`, a line the user was not
		 * looking at, and `older` is untouched.
		 */
		const doc = `query E {\n  user(id: "1") {\n    latest: posts {\n      id\n    }\n    older: posts {\n      title\n    }\n  }\n}\n`;
		const result = inserted(
			insertionForNode(
				schema,
				argumentRow(["query", "user", "posts"], "first"),
				doc,
				doc.indexOf("title")
			)!
		);

		expect(result.text).toContain("older: posts(first: $first)");
		expect(result.text).toContain("latest: posts {");
		expectValid(result.text);
	});

	it("writes past a comment in the argument list rather than into it", () => {
		/*
		 * Mutation check: place the edit in front of the `)` found by searching
		 * the text, and the `)` inside this comment is found first - the argument
		 * lands in the comment, added to nothing, and this reddens.
		 */
		const doc = `query E($term: String!) {\n  search(term: $term # (see)\n  ) {\n    __typename\n  }\n}\n`;
		const result = inserted(
			insertionForNode(
				schema,
				argumentRow(["query", "search"], "ranking"),
				doc,
				doc.indexOf("__typename")
			)!
		);

		expect(result.text).toContain("term: $term, ranking: $ranking");
		expectValid(result.text);
	});

	it("writes the field first when the document does not have it", () => {
		/*
		 * The row is under `posts`, and a user clicking `first` is not asking to
		 * do the two steps themselves. Mutation check: return a refusal instead of
		 * inserting the field, and the assertion on `posts(first: $first)` reddens.
		 */
		const result = inserted(
			insertionForNode(schema, argumentRow(["query", "user", "posts"], "first"), "", 0)!
		);

		expect(result.text).toContain("posts(first: $first)");
		expect(result.variables).toEqual({ id: "", first: 0 });
		expect(result.placement).toBe("new-operation");
		expectValid(result.text);
	});

	it("does not write a required argument twice when the field insertion wrote it", () => {
		// `search(term:)` is required, so inserting the field already writes it.
		const result = inserted(
			insertionForNode(schema, argumentRow(["query", "search"], "term"), "", 0)!
		);

		expect(result.text.match(/term: \$term/g)).toHaveLength(1);
		expectValid(result.text);
	});

	it("reports an argument the selection already carries instead of writing a second", () => {
		const doc = `query Existing {\n  search(term: $term, ranking: RELEVANCE) {\n    __typename\n  }\n}\n`;
		const result = insertionForNode(
			schema,
			argumentRow(["query", "search"], "ranking"),
			doc,
			doc.indexOf("__typename")
		);

		expect(result && isAlreadyPresent(result)).toBe(true);
		if (result && isAlreadyPresent(result)) {
			expect(doc.slice(result.start, result.end)).toBe("ranking");
			expect(result.label).toBe("ranking on search");
		}
	});

	it("inserts nothing for the Arguments heading itself", () => {
		const posts = childNodes(
			schema,
			childNodes(
				schema,
				schemaBranches(schema).find((b) => b.branch === "query")!
			).find((c) => c.name === "user")!
		).find((c) => c.name === "posts")!;
		const heading = childNodes(schema, posts).find((c) => c.kind === "arguments")!;

		// A container's activation is its toggle, which the row handles.
		expect(insertionForNode(schema, heading, "", 0)).toBeNull();
	});

	it("refuses an argument the schema no longer declares", () => {
		const result = insertArgument(schema, "", 0, {
			parentTypeName: "User",
			fieldName: "posts",
			rootPath: null,
			argumentName: "gone",
		});

		expect(isRefusal(result)).toBe(true);
		if (isRefusal(result)) expect(result.reason).toContain("gone");
	});

	it("names the subscription, not the argument, when it refuses one", () => {
		const live = buildSchema(`
			type Post { id: ID! }
			type Query { ping: String }
			type Subscription { postAdded(room: ID!): Post }
		`);
		const branch = schemaBranches(live).find((b) => b.branch === "subscription")!;
		const field = childNodes(live, branch).find((c) => c.name === "postAdded")!;
		const args = childNodes(live, field).find((c) => c.kind === "arguments")!;
		const room = childNodes(live, args).find((c) => c.name === "room")!;

		const result = insertionForNode(live, room, "", 0);
		expect(result && isRefusal(result)).toBe(true);
		// What cannot be run is the subscription, not the argument.
		if (result && isRefusal(result)) expect(result.reason).toContain("postAdded");
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
