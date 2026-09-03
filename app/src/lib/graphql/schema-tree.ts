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
 *
 * **One route into the graph is materialised too: which root fields return a
 * given type.** It is the answer to the question a type row cannot otherwise
 * answer - "how do I ask for one of these?" - and it is what turns a `Post` row
 * from a dead end into `mutation { createPost { … } }`. It stops at the root
 * operation types on purpose: a one-hop answer is one the user can check at a
 * glance, whereas a search through the whole graph would offer routes nobody
 * chose and would be back to guessing, which is the thing `rootPath` exists to
 * avoid. A type nothing returns says so instead of being given a route.
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
	/**
	 * The concrete type this step's result must be narrowed to, when the field
	 * declares an interface or a union and the route wants one of its members.
	 *
	 * `Query.node: Node` reaches a `Post`, and the only way to select `title`
	 * through it is `node(id:) { ... on Post { title } }`. Absent on a step whose
	 * field already returns what the route wanted, which is most of them.
	 */
	narrowTo?: string;
}

export type SchemaNodeKind =
	| "branch"
	| "field"
	| "type"
	| "input-field"
	| "enum-value"
	/**
	 * The "Returned by" container under a type row. A container like a branch:
	 * it holds the root fields that answer with this type, and writes nothing
	 * itself.
	 */
	| "returned-by"
	/**
	 * The "Arguments" container under a field row that takes some. A container
	 * like "Returned by", and above the return type's own fields: the arguments
	 * belong to the row you opened, its fields to the type that row answers with.
	 */
	| "arguments"
	/** One argument under that container. */
	| "argument";

/** One argument of a field, as the schema declares it. */
export interface SchemaArgument {
	name: string;
	/** The type as GraphQL spells it, e.g. `Int` or `[String!]`. */
	type: string;
	/** The default as GraphQL would print it, or null when there is none. */
	defaultValue: string | null;
}

/**
 * The field an argument belongs to.
 *
 * An argument is not a selection - it is written *onto* a field - so inserting
 * one needs to know which field, and by which route. Carried on the row rather
 * than recovered from it: an argument row's own `name` is the argument's, and
 * reading a field out of it is exactly the misroute this exists to prevent.
 */
export interface ArgumentOwner {
	parentTypeName: string;
	fieldName: string;
	/** The route to the field, or null when the field was not reached from a root. */
	rootPath: FieldStep[] | null;
}

export interface SchemaTreeNode {
	/** Unique within the tree: the expansion key, and the React key. */
	id: string;
	kind: SchemaNodeKind;
	/** The name shown on the row. */
	name: string;
	/**
	 * Arguments and result type as GraphQL spells them, e.g.
	 * `(first: Int = 10): [Post!]!`. Empty for rows that have no signature.
	 *
	 * The whole signature, still - the row draws `returnType` instead, and this
	 * is what the search index reads and what the row shows on hover. Folding the
	 * arguments out of it would silently drop the middle tier of the search.
	 */
	signature: string;
	/**
	 * The result type as GraphQL spells it (`[Post!]!`), narrowed where the route
	 * narrows (`Node → Post`). Empty on a row that answers with nothing: a
	 * branch, a container, a type row, an enum value.
	 *
	 * What the row draws, because it is the short half of the signature and the
	 * half a reader browsing is after. An argument list is unbounded, and drawn
	 * inline it pushes the result type off the right edge of a 34% pane.
	 */
	returnType: string;
	/**
	 * The arguments this field takes, in declaration order. Empty on every other
	 * kind. The row says how many there are and lists them as children.
	 */
	args: SchemaArgument[];
	/** The field an argument row belongs to, or null on every other row. */
	argumentOwner: ArgumentOwner | null;
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

/*
 * Row ids, in one place.
 *
 * An id is both the expansion key and the address `treeLocationOf` reconstructs
 * to walk a search result back to its place in the tree. Spelled out at each
 * construction site, the two would be one edit away from disagreeing - and the
 * failure is a Reveal that silently expands nothing.
 */
const branchNodeId = (branch: SchemaBranchId): string => `branch:${branch}`;
const typeNodeId = (parentId: string, typeName: string): string => `${parentId}/type:${typeName}`;
const memberNodeId = (parentId: string, ownerTypeName: string, name: string): string =>
	`${parentId}/${ownerTypeName}.${name}`;
const returnedByNodeId = (typeRowId: string): string => `${typeRowId}/returned-by`;
const argumentsNodeId = (fieldRowId: string): string => `${fieldRowId}/arguments`;

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
		id: branchNodeId(branch),
		kind: "branch" as const,
		name: BRANCH_LABEL[branch],
		signature: "",
		returnType: "",
		args: [],
		argumentOwner: null,
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

/** A root operation field a named type can be reached through. */
export interface RootFieldRef {
	branch: SchemaBranchId;
	parentTypeName: string;
	fieldName: string;
	deprecated: boolean;
	/**
	 * The type the route narrows to, or null when the field returns it outright.
	 *
	 * Set for a field declaring an interface or union that the wanted type is a
	 * member of - the route exists, and every selection along it has to say
	 * `... on <that type>`.
	 */
	narrowTo: string | null;
}

/**
 * Which root fields answer with which type, built once per schema.
 *
 * **Query and Mutation only.** A subscription is browsable here and cannot be
 * run (the engine sends one request and reads one response), so offering one as
 * the route to a type would hand the user an operation this app refuses to send.
 *
 * **Only types a selection can be written against are keyed.** A scalar is
 * returned by half the schema and selecting one is not a thing the user does; a
 * `String` row listing 200 root fields would be noise, and inserting "the
 * shortest route to a String" is not a query anybody wanted. This is also what
 * keeps the type-row rules and the tree's own children in step: both ask this
 * one function, so neither can offer a route the other refuses.
 */
const returnedByCache = new WeakMap<GraphQLSchema, Map<string, RootFieldRef[]>>();

function returnedByIndex(schema: GraphQLSchema): Map<string, RootFieldRef[]> {
	const cached = returnedByCache.get(schema);
	if (cached) return cached;

	const index = new Map<string, RootFieldRef[]>();
	const add = (typeName: string, ref: RootFieldRef) => {
		const refs = index.get(typeName) ?? [];
		refs.push(ref);
		index.set(typeName, refs);
	};

	for (const branch of ["query", "mutation"] as const) {
		const rootName = branchRootTypeName(schema, branch);
		const root = rootName ? schema.getType(rootName) : null;
		if (!isObjectType(root)) continue;
		for (const field of Object.values(root.getFields())) {
			const named = getNamedType(field.type);
			if (!isObjectType(named) && !isInterfaceType(named) && !isUnionType(named)) continue;
			const ref = {
				branch,
				parentTypeName: root.name,
				fieldName: field.name,
				deprecated: field.deprecationReason != null,
				narrowTo: null,
			};
			add(named.name, ref);
			/*
			 * Still one hop. A field declaring `Node` reaches a `Post` on every
			 * real request, and keying only the declared type is what left a
			 * Relay-shaped schema - one `node` field, every concrete type behind
			 * it - with no route to anything at all.
			 */
			if (isInterfaceType(named) || isUnionType(named)) {
				for (const member of schema.getPossibleTypes(named)) {
					add(member.name, { ...ref, narrowTo: member.name });
				}
			}
		}
	}
	/*
	 * A route that returns the type outright beats one that narrows to it, so a
	 * schema declaring both keeps the answer it had before narrowing existed.
	 * Then a deprecated root field, which is a route the schema is asking
	 * clients to stop using, goes last and is never the one a click takes.
	 * `sort` is stable, so within each group the declaration order survives.
	 */
	for (const refs of index.values()) {
		refs.sort(
			(a, b) =>
				Number(a.narrowTo !== null) - Number(b.narrowTo !== null) ||
				Number(a.deprecated) - Number(b.deprecated)
		);
	}

	returnedByCache.set(schema, index);
	return index;
}

/** The root fields whose result type is `typeName`, best route first. */
export function rootFieldsReturning(schema: GraphQLSchema, typeName: string): RootFieldRef[] {
	return returnedByIndex(schema).get(typeName) ?? [];
}

/**
 * The routes from a root operation type to `typeName`, best first.
 *
 * Every route is one step long by construction, which is what makes "the
 * shortest" a fact rather than a heuristic.
 */
export function rootPathsToType(schema: GraphQLSchema, typeName: string): FieldStep[][] {
	return rootFieldsReturning(schema, typeName).map((ref) => [rootStep(ref)]);
}

/** A route's one step, carrying its narrowing only when it has one. */
function rootStep(ref: RootFieldRef): FieldStep {
	const step: FieldStep = { parentTypeName: ref.parentTypeName, fieldName: ref.fieldName };
	return ref.narrowTo ? { ...step, narrowTo: ref.narrowTo } : step;
}

/** The rows one level under `node`, or an empty list when it has none. */
export function childNodes(schema: GraphQLSchema, node: SchemaTreeNode): SchemaTreeNode[] {
	if (node.kind === "branch") return branchChildren(schema, node);
	if (node.kind === "returned-by") return returnedByChildren(schema, node);
	if (node.kind === "arguments") return argumentChildren(schema, node);

	const members = typeMembers(schema, node);

	/*
	 * A field's arguments come before the fields of what it returns, because
	 * that is the order they are written in: `posts(first: 10) { title }`. The
	 * container is asked for before the type is even resolved, so a field whose
	 * result type left the schema still lists what it takes.
	 */
	if (node.kind === "field") {
		return node.args.length > 0 ? [argumentsNode(node), ...members] : members;
	}

	// Only a *type* row asks how it is reached. The same named type under a
	// field row was reached by that field, which is the row above it.
	if (node.kind !== "type" || !node.typeName) return members;
	const returnedBy = rootFieldsReturning(schema, node.typeName);
	return returnedBy.length > 0 ? [returnedByNode(node), ...members] : members;
}

/** The rows for what `node`'s type declares, or none when it has no type left. */
function typeMembers(schema: GraphQLSchema, node: SchemaTreeNode): SchemaTreeNode[] {
	if (!node.typeName) return [];
	const type = schema.getType(node.typeName);
	if (!type) return [];
	return memberNodes(schema, node, type);
}

function branchChildren(schema: GraphQLSchema, node: SchemaTreeNode): SchemaTreeNode[] {
	if (node.branch === "types") {
		return namedTypes(schema).map((type) => typeNode(schema, node.id, type));
	}
	const rootName = branchRootTypeName(schema, node.branch);
	const root = rootName ? schema.getType(rootName) : null;
	if (!isObjectType(root)) return [];
	return Object.values(root.getFields()).map((field) =>
		fieldNode(node.id, root.name, field, node.branch, [])
	);
}

/**
 * The root fields under a "Returned by" container.
 *
 * They carry a one-step `rootPath`, so activating one inserts the operation
 * that reaches the type - the same row, and the same insertion, the user would
 * have found by opening Query themselves.
 */
function returnedByChildren(schema: GraphQLSchema, node: SchemaTreeNode): SchemaTreeNode[] {
	if (!node.typeName) return [];
	return rootFieldsReturning(schema, node.typeName).flatMap((ref) => {
		const owner = schema.getType(ref.parentTypeName);
		if (!isObjectType(owner)) return [];
		const field = owner.getFields()[ref.fieldName];
		if (!field) return [];

		const row = fieldNode(node.id, owner.name, field, ref.branch, []);
		if (!ref.narrowTo) return [row];
		/*
		 * A narrowed route says so on the row, and leads to the type that was
		 * asked for rather than the interface the field declares - otherwise
		 * `node` under `Post` reads as returning a `Node` and expands into
		 * `Node`'s one field, neither of which is what the row is offering.
		 */
		return [
			{
				...row,
				signature: `${row.signature} → ${ref.narrowTo}`,
				returnType: `${row.returnType} → ${ref.narrowTo}`,
				typeName: ref.narrowTo,
				// The arguments are still the field's, so a row that takes some
				// still opens - the narrowing changes what it answers with, not
				// what it asks for.
				expandable: hasChildren(schema.getType(ref.narrowTo)!) || row.args.length > 0,
				rootPath: [rootStep(ref)],
			},
		];
	});
}

/**
 * The arguments of the field an "Arguments" container hangs under.
 *
 * Read back off the schema rather than off the container's own `args`: the row
 * carries what to *show*, and a row can outlive the schema it was built from by
 * a refresh. Asking the schema means an argument that is gone lists nothing
 * instead of offering an insertion that would not be legal.
 */
function argumentChildren(schema: GraphQLSchema, node: SchemaTreeNode): SchemaTreeNode[] {
	const owner = node.argumentOwner;
	if (!owner) return [];
	const parent = schema.getType(owner.parentTypeName);
	if (!isObjectType(parent) && !isInterfaceType(parent)) return [];
	const field = parent.getFields()[owner.fieldName];
	if (!field) return [];
	return field.args.map((arg) => argumentNode(node.id, arg, owner, node.branch));
}

/** The "Arguments" container under a field row, carrying the field's identity. */
function argumentsNode(fieldRow: SchemaTreeNode): SchemaTreeNode {
	return {
		id: argumentsNodeId(fieldRow.id),
		kind: "arguments",
		name: "Arguments",
		signature: "",
		returnType: "",
		/*
		 * Empty, though the field's are right there: a container writes nothing
		 * and answers with nothing, and a row carrying arguments is a row that
		 * draws their count - which on this one would repeat the count already
		 * on the field a line above it. Its children read the schema.
		 */
		args: [],
		argumentOwner: {
			parentTypeName: fieldRow.ownerTypeName ?? "",
			fieldName: fieldRow.name,
			rootPath: fieldRow.rootPath,
		},
		typeName: null,
		ownerTypeName: fieldRow.ownerTypeName,
		description: null,
		deprecationReason: null,
		branch: fieldRow.branch,
		expandable: true,
		rootPath: null,
	};
}

/**
 * One argument row.
 *
 * Expandable when its type has members of its own, which is what makes an input
 * object worth clicking: `filter: PostFilter` opens into the fields the value
 * has to hold. Its `rootPath` is null - the route on the row is the field's, and
 * it lives in `argumentOwner` where nothing will mistake it for a selection.
 */
function argumentNode(
	parentId: string,
	arg: GraphQLArgument,
	owner: ArgumentOwner,
	branch: SchemaBranchId
): SchemaTreeNode {
	const named = getNamedType(arg.type);
	const value = schemaArgument(arg);
	return {
		id: memberNodeId(parentId, owner.fieldName, arg.name),
		kind: "argument",
		name: arg.name,
		signature: typeSuffix(value),
		returnType: value.type,
		args: [],
		argumentOwner: owner,
		typeName: named.name,
		ownerTypeName: owner.parentTypeName,
		description: arg.description ?? null,
		deprecationReason: arg.deprecationReason ?? null,
		branch,
		expandable: hasChildren(named),
		rootPath: null,
	};
}

function memberNodes(
	schema: GraphQLSchema,
	node: SchemaTreeNode,
	type: GraphQLNamedType
): SchemaTreeNode[] {
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
		return type.getTypes().map((member) => typeNode(schema, node.id, member, node.branch));
	}
	return [];
}

function returnedByNode(typeRow: SchemaTreeNode): SchemaTreeNode {
	return {
		id: returnedByNodeId(typeRow.id),
		kind: "returned-by",
		name: "Returned by",
		signature: "",
		returnType: "",
		args: [],
		argumentOwner: null,
		typeName: typeRow.typeName,
		ownerTypeName: null,
		description: null,
		deprecationReason: null,
		branch: typeRow.branch,
		expandable: true,
		rootPath: null,
	};
}

function fieldNode(
	parentId: string,
	ownerTypeName: string,
	field: GraphQLField<unknown, unknown>,
	branch: SchemaBranchId,
	parentPath: FieldStep[] | null
): SchemaTreeNode {
	const named = getNamedType(field.type);
	const args = field.args.map(schemaArgument);
	const returnType = field.type.toString();
	return {
		id: memberNodeId(parentId, ownerTypeName, field.name),
		kind: "field",
		name: field.name,
		signature: `${argsSignature(args)}: ${returnType}`,
		returnType,
		args,
		argumentOwner: null,
		typeName: named.name,
		ownerTypeName,
		description: field.description ?? null,
		deprecationReason: field.deprecationReason ?? null,
		branch,
		// A field that takes arguments opens even when it answers with a scalar:
		// the arguments are children, and a row that holds some and says it holds
		// none is the dead chevron the other way round.
		expandable: hasChildren(named) || args.length > 0,
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
		id: memberNodeId(parentId, owner.name, field.name),
		kind: "input-field",
		name: field.name,
		signature: `: ${field.type.toString()}${field.defaultValue === undefined ? "" : ` = ${JSON.stringify(field.defaultValue)}`}`,
		returnType: field.type.toString(),
		args: [],
		argumentOwner: null,
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
		id: memberNodeId(parentId, owner.name, name),
		kind: "enum-value",
		name,
		signature: "",
		returnType: "",
		args: [],
		argumentOwner: null,
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
	schema: GraphQLSchema,
	parentId: string,
	type: GraphQLNamedType,
	branch: SchemaBranchId = "types"
): SchemaTreeNode {
	return {
		id: typeNodeId(parentId, type.name),
		kind: "type",
		name: type.name,
		signature: typeKindLabel(type),
		returnType: "",
		args: [],
		argumentOwner: null,
		typeName: type.name,
		ownerTypeName: null,
		description: type.description ?? null,
		deprecationReason: null,
		branch,
		// A type with no fields of its own is still expandable when something
		// returns it: the "Returned by" container is a child like any other, and
		// a row that holds one and says it holds nothing is the dead chevron
		// pointing the other way.
		expandable: hasChildren(type) || rootFieldsReturning(schema, type.name).length > 0,
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

/** An argument in the shape the rows and the signature both read. */
function schemaArgument(arg: GraphQLArgument): SchemaArgument {
	return {
		name: arg.name,
		type: arg.type.toString(),
		defaultValue: arg.defaultValue === undefined ? null : formatDefault(arg.defaultValue),
	};
}

/** `: Int = 10`, the half of an argument that follows its name. */
function typeSuffix(arg: SchemaArgument): string {
	return `: ${arg.type}${arg.defaultValue === null ? "" : ` = ${arg.defaultValue}`}`;
}

/** `(a: Int = 1, b: String!)`, or `""` when the field takes no arguments. */
function argsSignature(args: readonly SchemaArgument[]): string {
	if (args.length === 0) return "";
	return `(${args.map((a) => `${a.name}${typeSuffix(a)}`).join(", ")})`;
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

/** Which of the three haystacks put a row in the results. */
export type SchemaMatchTier = "name" | "signature" | "description";

export interface SchemaSearchMatch {
	node: SchemaTreeNode;
	/**
	 * Which haystack the row was found through - not merely which offsets are
	 * set. Both offsets are reported whatever the tier, so a name match whose
	 * description happens to mention the term also carries a `descriptionStart`;
	 * the two questions "where do I mark it" and "why is this row here" have
	 * different answers, and reading the second off the first is what drew a
	 * 1,100-character description above the results a user was reading.
	 */
	tier: SchemaMatchTier;
	/** Where the term matched in `node.name`, for highlighting. -1 for no match. */
	matchStart: number;
	/** Where the term matched in `node.description`, for highlighting. -1 for no match. */
	descriptionStart: number;
}

export interface SchemaSearchIndex {
	entries: IndexEntry[];
}

/**
 * Every row the tree can show, flattened once.
 *
 * Fields are indexed under the type that owns them, and a field reachable from a
 * root operation type carries its one-step path - so searching for `search` and
 * pressing Enter inserts a working operation, exactly as expanding Query and
 * clicking it would. A field on a non-root type has no path, and inserting it
 * from the results is refused the same way it is from the Types branch.
 *
 * **Every kind `childNodes` can produce is indexed, including the two leaf kinds
 * that lead nowhere.** An enum value and an input-object field are rows the user
 * can reach by expanding, so a search that skips them contradicts the reason
 * this index exists at all - it would answer "Nothing matches" for a name the
 * pane will happily show one click later. Both are named in a schema the way a
 * field is (`RELEVANCE`, `authorId`) and are exactly what someone filling in an
 * argument is looking for.
 *
 * Both carry a null `rootPath`, because neither is reachable from a root
 * operation type - and `insertionForNode` refuses both by kind, so a search hit
 * lands on the same refusal a Types-branch row does rather than guessing a
 * route through the graph.
 *
 * **Arguments are the one kind `childNodes` produces that is not indexed**, and
 * the exception is what the rule above is for rather than a hole in it: an
 * argument is already searchable through the field that takes it, whose whole
 * signature is the middle tier here - typing `first` lists `User.posts`, the row
 * the argument hangs under. Indexed as itself it would be a second `first` row
 * with no address (`treeLocationOf` cannot place one) naming a type that does
 * not declare it, which is a worse answer than the field.
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
		if (!branch) entries.push(entry(typeNode(schema, "search", type)));
		// A root operation type is always an object type, so the branches below
		// are mutually exclusive with `branch` being set.
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
		} else if (isInputObjectType(type)) {
			for (const field of Object.values(type.getFields())) {
				entries.push(entry(inputFieldNode(`search:${type.name}`, type, field)));
			}
		} else if (isEnumType(type)) {
			for (const value of type.getValues()) {
				entries.push(entry(enumValueNode(`search:${type.name}`, type, value.name, value)));
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
 * name *and* description mention the term marks both - and the tier is reported
 * beside them, because "mark it here" and "this is why the row is here" are
 * different questions and only the second decides how much of a description the
 * pane owes the reader.
 *
 * **Inside the name tier, the closest match wins** - earliest offset first, and
 * among equal offsets the shortest name. An exact match needs no special case:
 * it is the degenerate one of offset 0 and no characters left over. Without it
 * the tier is in type-map declaration order and the `limit` cuts it arbitrarily,
 * which stopped being survivable once enum values and input fields joined the
 * index: on a schema declaring 60 enums of `POST_*` values before the `Post`
 * type, `post` returned 200 leaf rows and neither `Post` nor `Query.post`. The
 * other two tiers keep declaration order, having no offset into the name to sort
 * on and no measured overflow.
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
		const found = { node: item.node, matchStart, descriptionStart };

		if (matchStart >= 0) byName.push({ ...found, tier: "name" });
		else if (item.signature.includes(needle)) bySignature.push({ ...found, tier: "signature" });
		else if (descriptionStart >= 0) byDescription.push({ ...found, tier: "description" });
	}

	/*
	 * The whole index is scanned before this, rather than stopping at `limit`
	 * name matches: a better match than the first 200 is routinely declared
	 * after them, which is the bug above. The scan is two `indexOf` calls per
	 * entry over an index built once per schema, so it is a keystroke's worth of
	 * work on a schema of any size the pane can render.
	 */
	byName.sort((a, b) => a.matchStart - b.matchStart || a.node.name.length - b.node.name.length);

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

/** Matches that share a branch, under the heading the tree uses for it. */
export interface SchemaSearchGroup {
	branch: SchemaBranchId;
	label: string;
	matches: SchemaSearchMatch[];
}

/** The order the tree shows its branches in, so results read the same way. */
const GROUP_ORDER: readonly SchemaBranchId[] = ["query", "mutation", "subscription", "types"];

/**
 * Search matches under the same headings the tree uses.
 *
 * **A flat list of names is unreadable on a real schema.** Three types can
 * declare a field called `accessScopes`, and flattened they are three identical
 * rows: nothing on screen says which one is reachable from Query, and the user
 * cannot pick. Grouping restores the half of the address the tree carried in its
 * shape - the branch - and the row itself restores the other half by naming its
 * owner.
 *
 * Ranking is *within* a group, not across: the order `searchSchema` decided is
 * preserved as the partition is made, so the closest name match is still the
 * first row of its group and a description match is still last in its own.
 */
export function groupSearchMatches(matches: SchemaSearchMatch[]): SchemaSearchGroup[] {
	const byBranch = new Map<SchemaBranchId, SchemaSearchMatch[]>();
	for (const match of matches) {
		const group = byBranch.get(match.node.branch);
		if (group) group.push(match);
		else byBranch.set(match.node.branch, [match]);
	}
	return GROUP_ORDER.filter((branch) => byBranch.has(branch)).map((branch) => ({
		branch,
		label: BRANCH_LABEL[branch],
		matches: byBranch.get(branch)!,
	}));
}

/** Where a row sits in the tree: what to open, and the row to land on. */
export interface TreeLocation {
	/** Ids to expand, outermost first. */
	expand: string[];
	/** The row's id once everything above it is open. */
	id: string;
}

/**
 * Where a search result lives in the tree, so the pane can go there.
 *
 * A search row is built with an index-local id (`search:Post/Post.title`) and
 * cannot be found in the tree under it. Its address is recoverable, though: a
 * field of a root type hangs off that root's branch, and everything else hangs
 * off its owning type under Types - which is exactly the id `childNodes` builds
 * for it. Reconstructing rather than storing keeps one definition of where a row
 * lives; the ids come from the same builders the tree uses, so the two cannot
 * drift.
 *
 * Null for the rows that are not in the tree as themselves: a branch is already
 * the destination, a "Returned by" container exists only under an expanded type
 * row, and so do the "Arguments" container and its rows. An argument is also the
 * one row whose `ownerTypeName` names the type of the *field* it belongs to
 * rather than of itself, so the address below would be a field that does not
 * exist - the misroute this guard is here to refuse rather than compute.
 */
export function treeLocationOf(node: SchemaTreeNode): TreeLocation | null {
	const typesBranch = branchNodeId("types");

	if (
		node.kind === "branch" ||
		node.kind === "returned-by" ||
		node.kind === "arguments" ||
		node.kind === "argument"
	) {
		return null;
	}
	if (node.kind === "type") {
		return { expand: [typesBranch], id: typeNodeId(typesBranch, node.name) };
	}
	if (!node.ownerTypeName) return null;
	if (node.branch !== "types") {
		const branch = branchNodeId(node.branch);
		return { expand: [branch], id: memberNodeId(branch, node.ownerTypeName, node.name) };
	}
	const owner = typeNodeId(typesBranch, node.ownerTypeName);
	return {
		expand: [typesBranch, owner],
		id: memberNodeId(owner, node.ownerTypeName, node.name),
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
