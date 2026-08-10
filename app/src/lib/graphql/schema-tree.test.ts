/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { buildSchema } from "graphql";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import {
	branchRootTypeName,
	buildSearchIndex,
	childNodes,
	schemaBranches,
	searchSchema,
	splitAtMatch,
	type SchemaTreeNode,
} from "./schema-tree";

const schema = fixtureSchema();

/** The one branch row with this id, failing loudly when it is not there. */
function branch(id: string): SchemaTreeNode {
	const found = schemaBranches(schema).find((b) => b.branch === id);
	if (!found) throw new Error(`no ${id} branch`);
	return found;
}

function childNamed(node: SchemaTreeNode, name: string): SchemaTreeNode {
	const found = childNodes(schema, node).find((c) => c.name === name);
	if (!found) throw new Error(`no child ${name} of ${node.name}`);
	return found;
}

describe("schemaBranches", () => {
	it("lists the operation branches the schema actually has, then Types", () => {
		expect(schemaBranches(schema).map((b) => b.branch)).toEqual([
			"query",
			"mutation",
			"subscription",
			"types",
		]);
	});

	it("says out loud that subscriptions cannot be run here", () => {
		expect(branch("subscription").name).toContain("not executable");
	});

	it("omits a branch the schema does not define", () => {
		const queryOnly = buildSchema("type Query { ping: String }");
		expect(schemaBranches(queryOnly).map((b) => b.branch)).toEqual(["query", "types"]);
	});

	it("maps a branch to its root type name", () => {
		expect(branchRootTypeName(schema, "mutation")).toBe("Mutation");
		expect(branchRootTypeName(schema, "types")).toBeNull();
	});
});

describe("childNodes", () => {
	it("lists a root type's fields with their argument signatures", () => {
		const search = childNamed(branch("query"), "search");
		expect(search.signature).toBe(
			"(term: String!, ranking: Ranking = RELEVANCE): [SearchResult!]!"
		);
	});

	it("prints an enum default unquoted, as GraphQL would take it back", () => {
		// `JSON.stringify` would render this `"RELEVANCE"`, which is not an enum
		// value and would not parse if the user copied it.
		expect(childNamed(branch("query"), "search").signature).toContain("= RELEVANCE");
	});

	it("carries the description and the deprecation reason", () => {
		expect(childNamed(branch("query"), "search").description).toBe(
			"Search across users and posts."
		);
		expect(childNamed(branch("query"), "legacySearch").deprecationReason).toBe("Use search.");
	});

	it("builds a root path one step per level, so insertion knows the route", () => {
		const user = childNamed(branch("query"), "user");
		const posts = childNamed(user, "posts");
		const title = childNamed(posts, "title");

		expect(title.rootPath).toEqual([
			{ parentTypeName: "Query", fieldName: "user" },
			{ parentTypeName: "User", fieldName: "posts" },
			{ parentTypeName: "Post", fieldName: "title" },
		]);
	});

	it("gives rows under Types no root path - browsing a type is not a route", () => {
		const post = childNamed(branch("types"), "Post");
		expect(post.rootPath).toBeNull();
		expect(childNamed(post, "title").rootPath).toBeNull();
	});

	it("expands an enum into its values, deprecations included", () => {
		const ranking = childNamed(branch("types"), "Ranking");
		const values = childNodes(schema, ranking);
		expect(values.map((v) => v.name)).toEqual(["RELEVANCE", "RECENCY", "LEGACY"]);
		expect(values[2].deprecationReason).toBe("Use RELEVANCE.");
	});

	it("expands an input object into its input fields", () => {
		const filter = childNamed(branch("types"), "PostFilter");
		expect(filter.signature).toBe("input");
		expect(childNodes(schema, filter).map((f) => f.name)).toEqual([
			"authorId",
			"ranking",
			"tags",
		]);
	});

	it("expands a union into its members", () => {
		const union = childNamed(branch("types"), "SearchResult");
		expect(childNodes(schema, union).map((m) => m.name)).toEqual(["User", "Post"]);
	});

	it("expands an interface into its fields", () => {
		const node = childNamed(branch("types"), "Node");
		expect(node.signature).toBe("interface");
		expect(childNodes(schema, node).map((f) => f.name)).toEqual(["id"]);
	});

	it("treats a scalar as a leaf", () => {
		const post = childNamed(branch("types"), "Post");
		const title = childNamed(post, "title");
		expect(title.expandable).toBe(false);
		expect(childNodes(schema, title)).toEqual([]);
	});

	it("keeps the root operation types out of the Types branch", () => {
		const names = childNodes(schema, branch("types")).map((t) => t.name);
		expect(names).not.toContain("Query");
		expect(names).not.toContain("Mutation");
		expect(names).toContain("Post");
	});

	it("hides the introspection machinery", () => {
		const names = childNodes(schema, branch("types")).map((t) => t.name);
		expect(names.filter((n) => n.startsWith("__"))).toEqual([]);
	});

	it("gives every row a unique id, so a cycle can be expanded twice", () => {
		const user = childNamed(branch("query"), "user");
		const posts = childNamed(user, "posts");
		const author = childNamed(posts, "author");
		const authorPosts = childNamed(author, "posts");

		// User -> posts -> author -> posts is the same field twice; the rows are
		// distinct, which is what keeps the expansion set from collapsing them.
		expect(authorPosts.id).not.toBe(posts.id);
	});
});

describe("searchSchema", () => {
	const index = buildSearchIndex(schema);

	it("finds a type and a field by name", () => {
		const names = searchSchema(index, "post").map((m) => m.node.name);
		expect(names).toContain("Post");
		expect(names).toContain("posts");
	});

	it("ranks a name match above a signature-only match", () => {
		const results = searchSchema(index, "Ranking");
		expect(results[0].node.name).toBe("Ranking");
		// `Query.search` mentions Ranking only in its argument list.
		const search = results.find((m) => m.node.name === "search");
		expect(search?.matchStart).toBe(-1);
	});

	it("reports where the term matched, for highlighting", () => {
		const legacy = searchSchema(index, "search").find((m) => m.node.name === "legacySearch");
		expect(legacy?.matchStart).toBe(6);
	});

	it("gives a root field found by search a one-step path, so it inserts", () => {
		const search = searchSchema(index, "search").find((m) => m.node.name === "search");
		expect(search?.node.rootPath).toEqual([{ parentTypeName: "Query", fieldName: "search" }]);
	});

	it("gives a non-root field no path, the same as the Types branch does", () => {
		const handle = searchSchema(index, "handle").find((m) => m.node.name === "handle");
		expect(handle?.node.rootPath).toBeNull();
	});

	it("is empty for a blank term rather than listing the schema", () => {
		expect(searchSchema(index, "   ")).toEqual([]);
	});

	it("is case insensitive", () => {
		expect(searchSchema(index, "CREATEPOST").map((m) => m.node.name)).toContain("createPost");
	});

	it("bounds what it returns", () => {
		expect(searchSchema(index, "e", 3)).toHaveLength(3);
	});

	it("finds a row by a word that appears only in its description", () => {
		// "Search across users and posts." - `across` is in no name and no
		// signature anywhere in the fixture, so before descriptions were indexed
		// this returned nothing while the pane was displaying the sentence.
		const found = searchSchema(index, "across");
		expect(found.map((m) => m.node.name)).toEqual(["search"]);
		expect(found[0].matchStart).toBe(-1);
		expect(found[0].descriptionStart).toBe(7);
	});

	it("reports where the description matched, for highlighting", () => {
		// "How search results are ordered." on the Ranking enum.
		const ranking = searchSchema(index, "search").find((m) => m.node.name === "Ranking");
		expect(ranking?.descriptionStart).toBe(4);
	});

	it("reports both offsets when the name and the description each match", () => {
		const search = searchSchema(index, "search").find((m) => m.node.name === "search");
		expect(search?.matchStart).toBe(0);
		expect(search?.descriptionStart).toBe(0);
	});

	it("leaves the offset at -1 for a node with no description at all", () => {
		const post = searchSchema(index, "post").find((m) => m.node.name === "Post");
		expect(post?.descriptionStart).toBe(-1);
	});

	it("ranks name above signature above description", () => {
		/*
		 * A purpose-built schema rather than the fixture: `zebra` reaches each
		 * tier exactly once, so the order proves the tiers rather than the
		 * type map's iteration order. Collapse description into the signature
		 * tier and `Documented` - declared first - overtakes `striped`.
		 */
		const tiered = buildSchema(`
			"""Mentions zebra in prose."""
			type Documented { id: ID }
			type Zebra { id: ID }
			type Query {
				striped: Zebra
				zebra: Int
			}
		`);
		const names = searchSchema(buildSearchIndex(tiered), "zebra").map((m) => m.node.name);

		expect(names).toEqual(expect.arrayContaining(["Zebra", "striped", "Documented"]));
		expect(names.indexOf("striped")).toBeGreaterThan(names.indexOf("Zebra"));
		expect(names.indexOf("Documented")).toBeGreaterThan(names.indexOf("striped"));
	});

	it("does not let a description match crowd out the tiers above it", () => {
		// `e` is in most descriptions; the first results must still be names.
		const first = searchSchema(index, "e", 5);
		expect(first.every((m) => m.matchStart >= 0)).toBe(true);
	});

	it("finds an enum value, which is browsable in the tree and was unfindable", () => {
		// `RELEVANCE` is a value of the `Ranking` enum. Expanding Types ->
		// Ranking shows it; before it was indexed, typing its name answered
		// "Nothing matches" for a row the pane draws one click later.
		const found = searchSchema(index, "RELEVANCE").find((m) => m.node.name === "RELEVANCE");
		expect(found?.node.kind).toBe("enum-value");
		expect(found?.node.ownerTypeName).toBe("Ranking");
		expect(found?.matchStart).toBe(0);
	});

	it("finds an input-object field, the other kind the index skipped", () => {
		const found = searchSchema(index, "authorId").find((m) => m.node.name === "authorId");
		expect(found?.node.kind).toBe("input-field");
		expect(found?.node.ownerTypeName).toBe("PostFilter");
		expect(found?.node.signature).toBe(": ID");
	});

	it("indexes an input field of every input object, not just the first", () => {
		// `title` is only on `CreatePostInput`; `tags` is on both input objects,
		// so a loop that stopped at one type would show one row here.
		expect(searchSchema(index, "title").map((m) => m.node.ownerTypeName)).toContain(
			"CreatePostInput"
		);
		const tags = searchSchema(index, "tags").filter((m) => m.node.kind === "input-field");
		expect(tags.map((m) => m.node.ownerTypeName).sort()).toEqual([
			"CreatePostInput",
			"PostFilter",
		]);
	});

	it("gives both new kinds a null root path - neither is a route from a root", () => {
		const enumValue = searchSchema(index, "RECENCY").find((m) => m.node.name === "RECENCY");
		const inputField = searchSchema(index, "authorId").find((m) => m.node.name === "authorId");

		expect(enumValue?.node.rootPath).toBeNull();
		expect(inputField?.node.rootPath).toBeNull();
	});

	it("carries a deprecated enum value's reason through the index", () => {
		const legacy = searchSchema(index, "LEGACY").find((m) => m.node.kind === "enum-value");
		expect(legacy?.node.deprecationReason).toBe("Use RELEVANCE.");
	});

	it("gives every indexed row a unique id, so the results can be keyed", () => {
		const ids = buildSearchIndex(schema).entries.map((e) => e.node.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("ranks the closest name match first, whatever order the schema declares", () => {
		/*
		 * The regression the leaf kinds forced. 60 enums of `POST_*` values and
		 * 30 input objects of `post*` fields are declared *before* the `Post`
		 * type, and together they are 330 name matches - more than the limit.
		 * In declaration order the limit cut before `Post` was ever reached, so
		 * searching `post` returned 200 rows and neither the type nor the field
		 * the user meant. Remove the sort and this reddens.
		 */
		const parts: string[] = [];
		for (let i = 0; i < 60; i++) {
			parts.push(`enum Kind${i} { POST_CREATED, POST_UPDATED, POST_DELETED, POST_ARCHIVED }`);
		}
		for (let i = 0; i < 30; i++) {
			parts.push(`input In${i} { postId: ID, postBody: String, postTags: [String!] }`);
		}
		parts.push("type Post { id: ID! }");
		parts.push("type Query { post: Post }");

		const crowded = searchSchema(buildSearchIndex(buildSchema(parts.join("\n"))), "post");
		expect(crowded).toHaveLength(200);
		expect(
			crowded
				.slice(0, 2)
				.map((m) => m.node.name)
				.sort()
		).toEqual(["Post", "post"]);
	});

	it("puts a shorter name above a longer one that matches at the same offset", () => {
		// Both match at 0; `posts` is the closer answer to `post` than
		// `postArchivedAt` is, because less of it is left over.
		const ordered = buildSchema(`
			type Query { postArchivedAt: String, posts: [String!] }
		`);
		const names = searchSchema(buildSearchIndex(ordered), "post").map((m) => m.node.name);
		expect(names.indexOf("posts")).toBeLessThan(names.indexOf("postArchivedAt"));
	});

	it("still ranks a later-declared prefix match above an earlier substring one", () => {
		const ordered = buildSchema(`
			type Query { legacySearch: String, search: String }
		`);
		const names = searchSchema(buildSearchIndex(ordered), "search").map((m) => m.node.name);
		expect(names.indexOf("search")).toBeLessThan(names.indexOf("legacySearch"));
	});
});

describe("splitAtMatch", () => {
	it("cuts a match out of the middle", () => {
		expect(splitAtMatch("legacySearch", 6, 6)).toEqual({
			before: "legacy",
			match: "Search",
			after: "",
		});
	});

	it("cuts a match at the start", () => {
		expect(splitAtMatch("posts", 0, 4)).toEqual({ before: "", match: "post", after: "s" });
	});

	it("cuts a match at the end", () => {
		expect(splitAtMatch("createPost", 6, 4)).toEqual({
			before: "create",
			match: "Post",
			after: "",
		});
	});

	it("keeps the name whole for a signature-only match", () => {
		// -1 is what `searchSchema` reports when the term is only in the
		// signature; the row must draw exactly as an unsearched one does.
		expect(splitAtMatch("search", -1, 7)).toEqual({
			before: "search",
			match: "",
			after: "",
		});
	});

	it("keeps the name whole for an empty term", () => {
		expect(splitAtMatch("search", 0, 0)).toEqual({ before: "search", match: "", after: "" });
	});

	it("stops the match at the end of the name rather than past it", () => {
		expect(splitAtMatch("post", 2, 40)).toEqual({ before: "po", match: "st", after: "" });
	});

	it("keeps the name whole when the offset is past its end", () => {
		expect(splitAtMatch("post", 9, 2)).toEqual({ before: "post", match: "", after: "" });
	});

	it("splits on code units, so an astral character survives the cut", () => {
		// GraphQL names are ASCII by spec, but the branch rows are prose
		// ("Subscription (not executable)") and nothing stops a server from
		// describing itself in any script. A surrogate pair split down the
		// middle would render two replacement characters.
		const name = "🎯target";
		const start = name.indexOf("target");
		expect(splitAtMatch(name, start, 6)).toEqual({
			before: "🎯",
			match: "target",
			after: "",
		});
		expect(splitAtMatch("héllo", 1, 4)).toEqual({ before: "h", match: "éllo", after: "" });
	});

	it("reassembles into the original name, whatever the cut", () => {
		const name = "legacySearch";
		for (let start = 0; start < name.length; start++) {
			for (let length = 1; length <= name.length; length++) {
				const { before, match, after } = splitAtMatch(name, start, length);
				expect(before + match + after).toBe(name);
			}
		}
	});
});
