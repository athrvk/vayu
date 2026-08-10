/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The schema explorer's tree model, and the index its search box reads.
 *
 * **Children are computed on demand, not built into a tree up front.** A schema
 * is a graph, not a tree: `User.posts` leads to `Post`, whose `author` leads
 * back to `User`. Eagerly materialising that either recurses forever or needs a
 * visited-set whose pruning decides for the user which branch they may open.
 * Asking the schema for one row's children when that row expands has neither
 * problem, and it is also what keeps a GitHub-scale schema off the critical
 * path - nothing is walked that nobody opened.
 *
 * **A field row carries the path it was reached by** (`rootPath`), which is the
 * one thing the insertion module cannot recover on its own. `Post.title` says
 * nothing about how to reach a `Post` from `Query`; `[Query.user, User.posts,
 * Post.title]` says exactly that, and it is free here because expanding rows is
 * how the user built it. Rows under the Types branch have no such path -
 * browsing `Post` directly is not a route from any root - and they say so with
 * a null, which is what makes the explorer refuse to insert them loudly rather
 * than guess a path through the graph.
 *
 * The search index *is* materialised, because a search has to see rows nobody
 * expanded. It is one pass over the type map with no traversal, so it is bounded
 * by the schema's size rather than by its shape.
 */

import {
	getNamedType,
	isEnumType,
	isInputObjectType,
	isInterfaceType,
	isObjectType,
	isScalarType,
	isUnionType,
	type GraphQLArgument,
	type GraphQLEnumType,
	type GraphQLField,
	type GraphQLInputField,
	type GraphQLInputObjectType,
	type GraphQLNamedType,
	type GraphQLSchema,
} from "graphql";

/** The four top-level rows. `types` is every named type the schema defines. */
export type SchemaBranchId = "query" | "mutation" | "subscription" | "types";

/**
 * One step of the route from a root operation type down to a field: the type
 * that owns the field, and the field's name. A list of these is a selection
 * path, which is all the insertion module needs to build (or extend) a document.
 */
export interface FieldStep {
	parentTypeName: string;
	fieldName: string;
}

export type SchemaNodeKind = "branch" | "field" | "type" | "input-field" | "enum-value";

export interface SchemaTreeNode {
	/** Unique within the tree: the expansion key, and the React key. */
	id: string;
	kind: SchemaNodeKind;
	/** The name shown on the row. */
	name: string;
	/**
	 * Arguments and result type as GraphQL spells them, e.g.
	 * `(first: Int = 10): [Post!]!`. Empty for rows that have no signature.
	 */
	signature: string;
	/** The named type this row leads to, or null when the row is a leaf. */
	typeName: string | null;
	/**
	 * The type that declares this field, or null for a row that is not a field.
	 * The insertion module needs it for a row with no `rootPath`: it is the only
	 * thing that says which selection set the field would be legal in.
	 */
	ownerTypeName: string | null;
	description: string | null;
	deprecationReason: string | null;
	branch: SchemaBranchId;
	expandable: boolean;
	/**
	 * The route from a root operation type to this field, or null when the row
	 * was not reached from one. Null for branch rows, type rows, input fields,
	 * enum values, and everything under the Types branch.
	 */
	rootPath: FieldStep[] | null;
}

/** The root operation type a branch stands for, or null for the Types branch. */
export function branchRootTypeName(schema: GraphQLSchema, branch: SchemaBranchId): string | null {
	if (branch === "query") return schema.getQueryType()?.name ?? null;
	if (branch === "mutation") return schema.getMutationType()?.name ?? null;
	if (branch === "subscription") return schema.getSubscriptionType()?.name ?? null;
	return null;
}

const BRANCH_LABEL: Record<SchemaBranchId, string> = {
	query: "Query",
	mutation: "Mutation",
	/*
	 * Named for what it is rather than for what it holds. The engine's transport
	 * is a single HTTP exchange, so a subscription can be read here and cannot be
	 * run - hiding the branch would be the friendlier lie, and a user comparing
	 * Vayu against a schema they know would conclude the explorer had missed
	 * something.
	 */
	subscription: "Subscription (not executable)",
	types: "Types",
};

/**
 * The top-level rows, in reading order.
 *
 * A schema with no mutations has no Mutation branch - an empty branch invites
 * the user to open it and learn nothing.
 */
export function schemaBranches(schema: GraphQLSchema): SchemaTreeNode[] {
	const branches: SchemaBranchId[] = [];
	if (schema.getQueryType()) branches.push("query");
	if (schema.getMutationType()) branches.push("mutation");
	if (schema.getSubscriptionType()) branches.push("subscription");
	if (namedTypes(schema).length > 0) branches.push("types");

	return branches.map((branch) => ({
		id: `branch:${branch}`,
		kind: "branch" as const,
		name: BRANCH_LABEL[branch],
		signature: "",
		typeName: branchRootTypeName(schema, branch),
		ownerTypeName: null,
		description: null,
		deprecationReason: null,
		branch,
		expandable: true,
		rootPath: null,
	}));
}

/**
 * Every type the schema declares that the user wrote.
 *
 * Introspection types (`__Schema`, `__Type`, …) are the machinery behind the
 * pane the user is looking at, and the root operation types appear under their
 * own branches already.
 */
function namedTypes(schema: GraphQLSchema): GraphQLNamedType[] {
	const roots = new Set(
		[schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
			.filter((t) => t !== null && t !== undefined)
			.map((t) => t.name)
	);
	return Object.values(schema.getTypeMap())
		.filter((t) => !t.name.startsWith("__") && !roots.has(t.name))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The rows one level under `node`, or an empty list when it has none. */
export function childNodes(schema: GraphQLSchema, node: SchemaTreeNode): SchemaTreeNode[] {
	if (node.kind === "branch") {
		if (node.branch === "types") {
			return namedTypes(schema).map((type) => typeNode(node.id, type));
		}
		const rootName = branchRootTypeName(schema, node.branch);
		const root = rootName ? schema.getType(rootName) : null;
		if (!isObjectType(root)) return [];
		return Object.values(root.getFields()).map((field) =>
			fieldNode(node.id, root.name, field, node.branch, [])
		);
	}

	if (!node.typeName) return [];
	const type = schema.getType(node.typeName);
	if (!type) return [];

	if (isObjectType(type) || isInterfaceType(type)) {
		return Object.values(type.getFields()).map((field) =>
			fieldNode(node.id, type.name, field, node.branch, node.rootPath)
		);
	}
	if (isInputObjectType(type)) {
		return Object.values(type.getFields()).map((field) => inputFieldNode(node.id, type, field));
	}
	if (isEnumType(type)) {
		return type.getValues().map((value) => enumValueNode(node.id, type, value.name, value));
	}
	if (isUnionType(type)) {
		return type.getTypes().map((member) => typeNode(node.id, member, node.branch));
	}
	return [];
}

function fieldNode(
	parentId: string,
	ownerTypeName: string,
	field: GraphQLField<unknown, unknown>,
	branch: SchemaBranchId,
	parentPath: FieldStep[] | null
): SchemaTreeNode {
	const named = getNamedType(field.type);
	return {
		id: `${parentId}/${ownerTypeName}.${field.name}`,
		kind: "field",
		name: field.name,
		signature: `${argsSignature(field.args)}: ${field.type.toString()}`,
		typeName: named.name,
		ownerTypeName,
		description: field.description ?? null,
		deprecationReason: field.deprecationReason ?? null,
		branch,
		expandable: hasChildren(named),
		rootPath: parentPath
			? [...parentPath, { parentTypeName: ownerTypeName, fieldName: field.name }]
			: null,
	};
}

function inputFieldNode(
	parentId: string,
	owner: GraphQLInputObjectType,
	field: GraphQLInputField
): SchemaTreeNode {
	const named = getNamedType(field.type);
	return {
		id: `${parentId}/${owner.name}.${field.name}`,
		kind: "input-field",
		name: field.name,
		signature: `: ${field.type.toString()}${field.defaultValue === undefined ? "" : ` = ${JSON.stringify(field.defaultValue)}`}`,
		typeName: named.name,
		ownerTypeName: owner.name,
		description: field.description ?? null,
		deprecationReason: field.deprecationReason ?? null,
		branch: "types",
		expandable: hasChildren(named),
		rootPath: null,
	};
}

function enumValueNode(
	parentId: string,
	owner: GraphQLEnumType,
	name: string,
	value: { description?: string | null; deprecationReason?: string | null }
): SchemaTreeNode {
	return {
		id: `${parentId}/${owner.name}.${name}`,
		kind: "enum-value",
		name,
		signature: "",
		typeName: null,
		ownerTypeName: owner.name,
		description: value.description ?? null,
		deprecationReason: value.deprecationReason ?? null,
		branch: "types",
		expandable: false,
		rootPath: null,
	};
}

function typeNode(
	parentId: string,
	type: GraphQLNamedType,
	branch: SchemaBranchId = "types"
): SchemaTreeNode {
	return {
		id: `${parentId}/type:${type.name}`,
		kind: "type",
		name: type.name,
		signature: typeKindLabel(type),
		typeName: type.name,
		ownerTypeName: null,
		description: type.description ?? null,
		deprecationReason: null,
		branch,
		expandable: hasChildren(type),
		rootPath: null,
	};
}

export function typeKindLabel(type: GraphQLNamedType): string {
	if (isObjectType(type)) return "type";
	if (isInterfaceType(type)) return "interface";
	if (isUnionType(type)) return "union";
	if (isEnumType(type)) return "enum";
	if (isInputObjectType(type)) return "input";
	if (isScalarType(type)) return "scalar";
	return "";
}

function hasChildren(type: GraphQLNamedType): boolean {
	if (isObjectType(type) || isInterfaceType(type))
		return Object.keys(type.getFields()).length > 0;
	if (isInputObjectType(type)) return Object.keys(type.getFields()).length > 0;
	if (isEnumType(type)) return type.getValues().length > 0;
	if (isUnionType(type)) return type.getTypes().length > 0;
	return false;
}

/** `(a: Int = 1, b: String!)`, or `""` when the field takes no arguments. */
function argsSignature(args: readonly GraphQLArgument[]): string {
	if (args.length === 0) return "";
	const parts = args.map((a) => {
		const suffix = a.defaultValue === undefined ? "" : ` = ${formatDefault(a.defaultValue)}`;
		return `${a.name}: ${a.type.toString()}${suffix}`;
	});
	return `(${parts.join(", ")})`;
}

/**
 * A default value as GraphQL would print it.
 *
 * Enum defaults are the reason this is not `JSON.stringify`: the schema holds
 * `RELEVANCE` as the string `"RELEVANCE"`, and quoting it in a signature shows
 * the user something that would not parse if they typed it back.
 */
function formatDefault(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

/**
 * One row of the search index: a node, plus each field it matches on,
 * lowercased.
 *
 * Three fields rather than one concatenated haystack, because the ranking turns
 * on *which* of them matched - and folding case here rather than inside the
 * loop keeps a keystroke from re-lowercasing the whole schema.
 */
interface IndexEntry {
	node: SchemaTreeNode;
	name: string;
	signature: string;
	description: string;
}

export interface SchemaSearchMatch {
	node: SchemaTreeNode;
	/** Where the term matched in `node.name`, for highlighting. -1 for no match. */
	matchStart: number;
	/** Where the term matched in `node.description`, for highlighting. -1 for no match. */
	descriptionStart: number;
}

export interface SchemaSearchIndex {
	entries: IndexEntry[];
}

/**
 * Every field and type in the schema, flattened once.
 *
 * Fields are indexed under the type that owns them, and a field reachable from a
 * root operation type carries its one-step path - so searching for `search` and
 * pressing Enter inserts a working operation, exactly as expanding Query and
 * clicking it would. A field on a non-root type has no path, and inserting it
 * from the results is refused the same way it is from the Types branch.
 */
export function buildSearchIndex(schema: GraphQLSchema): SchemaSearchIndex {
	const entries: IndexEntry[] = [];
	const rootBranch = new Map<string, SchemaBranchId>();
	for (const branch of ["query", "mutation", "subscription"] as const) {
		const name = branchRootTypeName(schema, branch);
		if (name) rootBranch.set(name, branch);
	}

	for (const type of Object.values(schema.getTypeMap())) {
		if (type.name.startsWith("__")) continue;
		const branch = rootBranch.get(type.name);
		if (!branch) entries.push(entry(typeNode("search", type)));
		if (isObjectType(type) || isInterfaceType(type)) {
			for (const field of Object.values(type.getFields())) {
				entries.push(
					entry(
						fieldNode(
							`search:${type.name}`,
							type.name,
							field,
							branch ?? "types",
							branch ? [] : null
						)
					)
				);
			}
		}
	}
	return { entries };
}

function entry(node: SchemaTreeNode): IndexEntry {
	return {
		node,
		name: node.name.toLowerCase(),
		signature: node.signature.toLowerCase(),
		description: (node.description ?? "").toLowerCase(),
	};
}

/**
 * The index rows matching `term`, in three tiers: name, then signature, then
 * description.
 *
 * A signature match is kept but ranked below a name match: searching `Post`
 * should list the `Post` type and `Query.post` before every field that happens
 * to return one, and without the split the type is buried under its own users.
 *
 * **Descriptions are a third tier rather than more haystack.** They are prose -
 * whole sentences on a documented schema - so a common word (`the`, `id`,
 * `user`) matches most of the schema through them. Folded into the signature
 * tier that flood would drown the type matches that tier exists to surface;
 * ranked below it, a description hit is the last thing offered rather than the
 * first, which is the order a user reading a flat list expects. The pane still
 * has to say *why* such a row is in the list, since its name is unmarked - that
 * is what `descriptionStart` is for.
 *
 * Both offsets are reported whatever tier the row landed in, so a row whose
 * name *and* description mention the term marks both.
 */
export function searchSchema(
	index: SchemaSearchIndex,
	term: string,
	limit = 200
): SchemaSearchMatch[] {
	const needle = term.trim().toLowerCase();
	if (!needle) return [];

	const byName: SchemaSearchMatch[] = [];
	const bySignature: SchemaSearchMatch[] = [];
	const byDescription: SchemaSearchMatch[] = [];
	for (const item of index.entries) {
		const matchStart = item.name.indexOf(needle);
		const descriptionStart = item.description.indexOf(needle);
		const match = { node: item.node, matchStart, descriptionStart };

		if (matchStart >= 0) byName.push(match);
		else if (item.signature.includes(needle)) bySignature.push(match);
		else if (descriptionStart >= 0) byDescription.push(match);

		if (byName.length >= limit) break;
	}
	return [...byName, ...bySignature, ...byDescription].slice(0, limit);
}

/** A name cut into the part before the search match, the match, and the rest. */
export interface NameSegments {
	before: string;
	match: string;
	after: string;
}

/**
 * Split a name around the match `searchSchema` located in it.
 *
 * Lives beside the search rather than in the row that draws it: this is index
 * arithmetic, where an off-by-one silently mangles a name, and here it is
 * testable without a DOM.
 *
 * A `matchStart` of -1 - a signature-only match, or a row that is not a search
 * result at all - returns the name whole, which is what leaves those rows
 * drawing exactly as they did before highlighting existed. `end` is clamped
 * because the caller owns the term's length and the match's: a term longer than
 * the tail of the name must yield the tail, not an empty slice.
 */
export function splitAtMatch(name: string, matchStart: number, length: number): NameSegments {
	if (matchStart < 0 || matchStart >= name.length || length <= 0) {
		return { before: name, match: "", after: "" };
	}
	const end = Math.min(matchStart + length, name.length);
	return {
		before: name.slice(0, matchStart),
		match: name.slice(matchStart, end),
		after: name.slice(end),
	};
}

/** A row in the flattened tree: a node, and how deep it sits. */
export interface SchemaTreeRow {
	node: SchemaTreeNode;
	depth: number;
}

/**
 * The rows a user can see, in the order they see them.
 *
 * Children are asked for one expanded row at a time, so a schema nobody has
 * expanded costs one call for its branches - which is what keeps a
 * GitHub-scale schema off the render path.
 */
export function visibleRows(
	schema: GraphQLSchema,
	expanded: ReadonlySet<string>,
	depth = 0,
	nodes?: SchemaTreeNode[]
): SchemaTreeRow[] {
	const level = nodes ?? schemaBranches(schema);
	const rows: SchemaTreeRow[] = [];
	for (const node of level) {
		rows.push({ node, depth });
		if (node.expandable && expanded.has(node.id)) {
			rows.push(...visibleRows(schema, expanded, depth + 1, childNodes(schema, node)));
		}
	}
	return rows;
}
