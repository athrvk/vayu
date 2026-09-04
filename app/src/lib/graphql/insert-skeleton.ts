/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning a row of the schema explorer into an edit of the query document.
 *
 * **The contract is that the document still parses afterwards *and* can be
 * run.** A document that parses is not necessarily one the endpoint will
 * accept: a lone `fragment PostFields on Post { … }` is valid GraphQL and holds
 * no operation, so pressing Send on it gets nothing back. A click has to leave
 * behind something the user can run, which is why a type row inserts the query
 * that reaches it and falls back to a fragment only when the document already
 * carries an operation for that fragment to live beside.
 *
 * Everything awkward in here follows from the parses half of it:
 *
 * - A field is inserted into the selection set the cursor is in *only* when
 *   that set's type is the one that owns the field. No inline-fragment
 *   guessing on an interface or union, because "probably compatible" is how an
 *   invalid document gets written on the user's behalf. A cursor *inside* an
 *   inline fragment is a different matter: the fragment states its type, so the
 *   set is read at that type rather than at the interface or union above it -
 *   reading what the document says is not guessing.
 * - A field whose arguments become `$variables` forces those variables to be
 *   *declared*, so inserting into an existing operation edits that operation's
 *   variable definitions too. A `$id` nobody declared is a document the server
 *   rejects, and it would have been produced by a click rather than typed.
 * - An object-typed field is given its scalar fields rather than the empty
 *   `{ }` the issue sketched. An empty selection set is a syntax error, so the
 *   sketch and the contract disagreed; the contract wins, and the cursor still
 *   lands inside the braces where the sketch wanted it.
 *
 * **A path, not a search.** Inserting `Post.title` needs to know how a `Post`
 * is reached, and the schema graph has many answers (or none). The explorer
 * already knows the one the user opened - it is the rows they expanded - so a
 * field row carries its `rootPath` and this module never searches the graph. A
 * row with no path (browsed under Types) can still be inserted where the cursor
 * already sits in a compatible set; anywhere else it is refused out loud, which
 * is the honest end of "never silently produces an invalid document".
 *
 * The document is parsed through `maskGraphqlTemplates`, so a query holding
 * `{{variables}}` is analysed rather than treated as broken. The mask is
 * length-preserving, which is what makes the AST's offsets usable against the
 * real text.
 */

import {
	Kind,
	doTypesOverlap,
	getNamedType,
	isCompositeType,
	isEnumType,
	isInterfaceType,
	isNonNullType,
	isObjectType,
	isScalarType,
	isUnionType,
	parse,
	type FieldNode,
	type GraphQLArgument,
	type GraphQLCompositeType,
	type GraphQLField,
	type GraphQLNamedType,
	type GraphQLSchema,
	type InlineFragmentNode,
	type OperationDefinitionNode,
	type SelectionSetNode,
} from "graphql";
import { maskGraphqlTemplates } from "./templates";
import { rootPathsToType, type FieldStep, type SchemaTreeNode } from "./schema-tree";

/** One indent level. Matches `CodeEditor`'s `tabSize: 2`. */
const INDENT = "  ";

/**
 * Where the caret goes, carried inside the generated text until the offsets are
 * final. A NUL cannot be typed into the editor, so it can never collide with
 * the user's own document.
 */
const CARET = "\u0000";

export interface InsertRequest {
	/** The type that owns the field, and the field's name. */
	parentTypeName: string;
	fieldName: string;
	/**
	 * The route from a root operation type to this field, or null when the row
	 * was not reached from one. A path is what allows a new operation to be
	 * appended; without one, only the cursor's current selection set will do.
	 */
	rootPath: FieldStep[] | null;
}

/** A field insertion that also writes one of the field's arguments onto it. */
export interface ArgumentInsertRequest extends InsertRequest {
	/** The argument to write, by the name the schema declares it under. */
	argumentName: string;
}

export type InsertPlacement =
	/** Into the selection set the cursor was already in. */
	| "cursor"
	/** Into an enclosing selection set further out than the cursor's. */
	| "ancestor"
	/** As a new operation appended to the document. */
	| "new-operation"
	/** As a new fragment definition appended to the document. */
	| "fragment"
	/** Onto the argument list of a field the document already selects. */
	| "argument";

export interface DocumentInsertion {
	/** The whole document after the edit. */
	text: string;
	/** Where the caret should land, as an offset into `text`. */
	cursor: number;
	/**
	 * The variables the insertion declared, with a placeholder value each. Keys
	 * are variable names without the `$`.
	 */
	variables: Record<string, unknown>;
	placement: InsertPlacement;
	/** What was inserted, for the live-region announcement. */
	label: string;
}

/** Why an insertion could not be made. Always shown, never swallowed. */
export interface InsertRefusal {
	refused: true;
	reason: string;
}

/**
 * The leaf is already in the selection set the insertion would have written it
 * into, so there is nothing to write.
 *
 * A *value* rather than a silent return, for the same reason a refusal is one:
 * the caller has to say what happened. Duplicate fields are valid GraphQL - they
 * merge - so this is not the "never produce an invalid document" contract, it is
 * the second click on a row adding a line the user cannot tell from the first.
 * The offsets are the existing field's name, so the caller can show it instead.
 */
export interface InsertAlreadyPresent {
	alreadyPresent: true;
	/** Offset of the existing field's name in the document. */
	start: number;
	/** Offset one past the end of that name. */
	end: number;
	/** What is already there, for the live-region announcement. */
	label: string;
}

export type InsertResult = DocumentInsertion | InsertRefusal | InsertAlreadyPresent;

export function isRefusal(result: InsertResult): result is InsertRefusal {
	return "refused" in result;
}

export function isAlreadyPresent(result: InsertResult): result is InsertAlreadyPresent {
	return "alreadyPresent" in result;
}

/* -------------------------------------------------------------------------- */
/* Document analysis                                                           */
/* -------------------------------------------------------------------------- */

/** One enclosing selection set, with the type its selections are read against. */
interface EnclosingSet {
	typeName: string;
	selectionSet: SelectionSetNode;
	operation: OperationDefinitionNode;
}

/**
 * The selection sets containing `cursor`, outermost first.
 *
 * Empty when the document does not parse, when the cursor is outside every
 * operation, or when a field along the way is not in the schema - all of which
 * mean the same thing to the caller: there is no context to insert into.
 *
 * An inline fragment is one of the sets, at the type it narrows to. Skipping it
 * reported the interface or union the field above declares, so a cursor inside
 * `... on Post { }` looked like a cursor in a `Node` set that owns nothing the
 * user clicked - and the insertion fell all the way out to a second copy of the
 * route (#1346).
 */
function enclosingSets(
	schema: GraphQLSchema,
	text: string,
	cursor: number
): { chain: EnclosingSet[]; operations: OperationDefinitionNode[] } | null {
	let doc;
	try {
		doc = parse(maskGraphqlTemplates(text).masked);
	} catch {
		return null;
	}
	const operations = doc.definitions.filter(
		(d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION
	);

	for (const operation of operations) {
		const rootType = rootTypeFor(schema, operation);
		if (!rootType) continue;
		if (!contains(operation.selectionSet, cursor)) continue;
		const chain: EnclosingSet[] = [];
		let typeName = rootType.name;
		let set: SelectionSetNode | null = operation.selectionSet;
		while (set) {
			chain.push({ typeName, selectionSet: set, operation });
			const next = descend(schema, set, typeName, cursor);
			if (!next) break;
			typeName = next.typeName;
			set = next.selectionSet;
		}
		return { chain, operations };
	}
	return { chain: [], operations };
}

/**
 * One step inwards from `set` towards the cursor, or null when the cursor is in
 * `set` itself - or behind something this cannot read the type of.
 *
 * The two selections that hold a nested set are a field and an inline fragment,
 * and they answer the same question differently: a field's set is read at the
 * field's type, a fragment's at the type it names. A fragment with no type
 * condition (`... @include(if: $x) { }`) is legal and narrows nothing, so the
 * type carries over unchanged.
 *
 * Stopping (rather than descending blind) where the schema does not have the
 * field or the type condition is the same rule the chain has always followed:
 * the sets above are still honest context, and the sets below are read against
 * a type nothing can be checked against.
 */
function descend(
	schema: GraphQLSchema,
	set: SelectionSetNode,
	typeName: string,
	cursor: number
): { typeName: string; selectionSet: SelectionSetNode } | null {
	const next = set.selections.find(
		(s): s is FieldNode | InlineFragmentNode =>
			(s.kind === Kind.FIELD || s.kind === Kind.INLINE_FRAGMENT) &&
			!!s.selectionSet &&
			contains(s.selectionSet, cursor)
	);
	if (!next) return null;

	if (next.kind === Kind.INLINE_FRAGMENT) {
		const condition = next.typeCondition?.name.value;
		if (!condition) return { typeName, selectionSet: next.selectionSet };
		if (!isCompositeType(schema.getType(condition))) return null;
		return { typeName: condition, selectionSet: next.selectionSet };
	}

	const owner = schema.getType(typeName);
	const field =
		isObjectType(owner) || isInterfaceType(owner) ? owner.getFields()[next.name.value] : undefined;
	if (!field || !next.selectionSet) return null;
	return { typeName: getNamedType(field.type).name, selectionSet: next.selectionSet };
}

function rootTypeFor(schema: GraphQLSchema, operation: OperationDefinitionNode) {
	if (operation.operation === "query") return schema.getQueryType();
	if (operation.operation === "mutation") return schema.getMutationType();
	return schema.getSubscriptionType();
}

/** True when `offset` sits within the node's braces, endpoints included. */
function contains(node: { loc?: { start: number; end: number } }, offset: number): boolean {
	return !!node.loc && offset >= node.loc.start && offset <= node.loc.end;
}

/* -------------------------------------------------------------------------- */
/* Variable naming and placeholder values                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hands out variable names that collide with nothing already declared.
 *
 * A second `$id` in one operation is a validation error, and two fields wanting
 * an `id` is the ordinary case (`user(id:)` then `post(id:)`), so the second
 * becomes `$id2`.
 */
class VariableNamer {
	private readonly taken: Set<string>;
	readonly declarations: { name: string; type: string }[] = [];
	readonly values: Record<string, unknown> = {};

	constructor(taken: Iterable<string>) {
		this.taken = new Set(taken);
	}

	claim(preferred: string, type: string, placeholder: unknown): string {
		let name = preferred;
		for (let n = 2; this.taken.has(name); n++) name = `${preferred}${n}`;
		this.taken.add(name);
		this.declarations.push({ name, type });
		this.values[name] = placeholder;
		return name;
	}
}

/**
 * A starting value for a variable of this type.
 *
 * Deliberately a value of the right shape rather than `null`: the pane's JSON
 * schema (`variables-schema.ts`) validates what is there, and a null under a
 * non-null variable is an error the user did not make yet. An enum takes its
 * first value because any of them parses and none is more correct.
 */
export function placeholderFor(type: GraphQLNamedType, isList: boolean): unknown {
	if (isList) return [];
	if (isEnumType(type)) return type.getValues()[0]?.name ?? null;
	if (isScalarType(type)) {
		if (type.name === "Int" || type.name === "Float") return 0;
		if (type.name === "Boolean") return false;
		return "";
	}
	return {};
}

/* -------------------------------------------------------------------------- */
/* Selection rendering                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Render `steps` as a nested selection, innermost step carrying the caret.
 *
 * Indentation is **relative**: the result starts at column zero and whoever
 * places it shifts every line by the same prefix. Rendering absolute
 * indentation here instead meant the placer's own prefix was applied on top of
 * it, and every nested level came out doubled.
 *
 * Returns null when a step names something the schema does not have, which
 * happens when the pane's tree is a refresh behind the schema it is reading.
 */
function renderSteps(
	schema: GraphQLSchema,
	steps: FieldStep[],
	namer: VariableNamer
): string | null {
	const [step, ...rest] = steps;
	const owner = schema.getType(step.parentTypeName);
	if (!isObjectType(owner) && !isInterfaceType(owner)) return null;
	const field: GraphQLField<unknown, unknown> | undefined = owner.getFields()[step.fieldName];
	if (!field) return null;

	const head = `${field.name}${renderArguments(field, namer)}`;

	let body: string | null;
	if (rest.length > 0) {
		body = renderSteps(schema, rest, namer);
		if (body === null) return null;
	} else {
		/*
		 * The narrowing decides what to select, not just how to wrap it: the
		 * step wants `Post`'s scalars, and the field's own type is the `Node`
		 * they are not on.
		 */
		const target = step.narrowTo ? schema.getType(step.narrowTo) : getNamedType(field.type);
		if (!target) return null;
		const leaves = leafSelection(target);
		if (!leaves) return `${head}${CARET}`;
		body = `${leaves}${CARET}`;
	}

	/*
	 * An inline fragment, and only where the route the user opened named one -
	 * this is not the "probably compatible" guessing the header refuses, it is
	 * the narrowing without which the selection would not be legal at all.
	 */
	if (step.narrowTo) body = `... on ${step.narrowTo} {\n${indentBlock(body)}\n}`;
	return `${head} {\n${indentBlock(body)}\n}`;
}

/** Shift every line of `block` one level in. */
function indentBlock(block: string): string {
	return INDENT + block.split("\n").join("\n" + INDENT);
}

/**
 * Required arguments as `$variables`, optional ones omitted.
 *
 * "Required" means non-null with no default: an argument the schema defaults is
 * one the server fills in, and writing it out as a variable the user must now
 * supply turns a convenience into a chore.
 */
function renderArguments(field: GraphQLField<unknown, unknown>, namer: VariableNamer): string {
	const required = field.args.filter(
		(a) => isNonNullType(a.type) && a.defaultValue === undefined
	);
	if (required.length === 0) return "";
	const parts = required.map((arg) => {
		const named = getNamedType(arg.type);
		const isList = arg.type.toString().includes("[");
		const name = namer.claim(arg.name, arg.type.toString(), placeholderFor(named, isList));
		return `${arg.name}: $${name}`;
	});
	return `(${parts.join(", ")})`;
}

/**
 * What to select inside an object-typed field: its scalar leaves.
 *
 * `null` for a field that needs no selection set at all (a scalar or enum).
 * `__typename` when there is nothing scalar to take - a union has no fields of
 * its own, and an object of nothing but object fields would otherwise get an
 * empty set, which does not parse.
 */
function leafSelection(type: GraphQLNamedType): string | null {
	if (isScalarType(type) || isEnumType(type)) return null;
	if (isObjectType(type) || isInterfaceType(type)) {
		const scalars = Object.values(type.getFields())
			.filter((f) => {
				const named = getNamedType(f.type);
				return (
					(isScalarType(named) || isEnumType(named)) &&
					!f.args.some((a) => isNonNullType(a.type) && a.defaultValue === undefined)
				);
			})
			/*
			 * A deprecated field is one the schema is asking clients to stop
			 * using. Selecting it by default writes the migration the server
			 * author is trying to end into every new operation - it is browsable
			 * in the tree, struck through, which is where it belongs.
			 */
			.filter((f) => !f.deprecationReason)
			.map((f) => f.name);
		return scalars.length > 0 ? scalars.join("\n") : "__typename";
	}
	if (isUnionType(type)) return "__typename";
	return "__typename";
}

/* -------------------------------------------------------------------------- */
/* Edits                                                                       */
/* -------------------------------------------------------------------------- */

interface Edit {
	start: number;
	end: number;
	text: string;
}

/**
 * Apply edits to `text` and report where the caret marker ended up.
 *
 * Applied last-first so that an earlier edit's offsets are still the offsets it
 * was computed against - the reason a variable definition and a selection can
 * be planned independently and committed together.
 */
function applyEdits(text: string, edits: Edit[]): { text: string; cursor: number } {
	let out = text;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
	}
	const cursor = out.indexOf(CARET);
	return { text: out.split(CARET).join(""), cursor: cursor === -1 ? out.length : cursor };
}

/**
 * The document with a blank line at the end, ready to be appended to.
 *
 * Additive only: it never trims what is already there. Trimming looks tidier
 * and deletes characters the user just typed - a mid-edit `user(id: ` ends in a
 * space, and the caret is sitting on it.
 */
function withBlankLine(text: string): string {
	if (!text.trim()) return "";
	if (text.endsWith("\n\n")) return text;
	return text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
}

/** The indentation of the line `offset` sits on. */
function indentAt(text: string, offset: number): string {
	const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

/**
 * An edit putting `body` as the last selection of `set`.
 *
 * The whitespace between the last selection and the closing brace is rewritten
 * rather than added to, so a one-line `{ id }` becomes a block instead of
 * growing a selection wedged against the brace.
 */
function insertIntoSet(text: string, set: SelectionSetNode, body: string): Edit {
	const brace = set.loc!.end - 1;
	const openIndent = indentAt(text, set.loc!.start);
	const childIndent = openIndent + INDENT;
	let end = brace;
	while (end > 0 && /\s/.test(text[end - 1])) end--;
	const indented = body.split("\n").join("\n" + childIndent);
	return {
		start: end,
		end: brace,
		text: `\n${childIndent}${indented}\n${openIndent}`,
	};
}

/**
 * An edit adding variable definitions to an operation that may have none, and
 * may not even have a keyword to hang them off.
 *
 * The shorthand form (`{ user { id } }`) is the awkward case: it cannot carry
 * variables at all, so it is promoted to `query (...)` in the same edit. Left
 * alone it would have produced a document using variables it had no way to
 * declare.
 */
function declareVariables(
	text: string,
	operation: OperationDefinitionNode,
	declarations: { name: string; type: string }[]
): Edit | null {
	if (declarations.length === 0) return null;
	const defs = declarations.map((d) => `$${d.name}: ${d.type}`).join(", ");

	if (operation.variableDefinitions && operation.variableDefinitions.length > 0) {
		const last = operation.variableDefinitions[operation.variableDefinitions.length - 1];
		const close = text.indexOf(")", last.loc!.end);
		if (close === -1) return null;
		return { start: close, end: close, text: `, ${defs}` };
	}

	// No parentheses yet: hang them off the name, or off the keyword.
	const anchor = operation.name?.loc?.end;
	if (anchor !== undefined) return { start: anchor, end: anchor, text: `(${defs})` };

	const keywordEnd = operation.loc!.start + operation.operation.length;
	const isShorthand = text.slice(operation.loc!.start, keywordEnd) !== operation.operation;
	if (isShorthand) {
		return {
			start: operation.loc!.start,
			end: operation.loc!.start,
			text: `${operation.operation} (${defs}) `,
		};
	}
	return { start: keywordEnd, end: keywordEnd, text: ` (${defs})` };
}

/**
 * The selection `set` already holds for a bare leaf field, or null.
 *
 * Narrow on purpose, and the narrowing is the design. A field with required
 * arguments can honestly appear twice with different values; an object-typed
 * field re-inserted brings a selection set of its own, which is a different
 * line. Only a scalar or enum taking no required argument produces a duplicate
 * the user cannot tell apart from what is already there. An *aliased* selection
 * is a different key in the response, so it does not count as the field being
 * present either.
 */
function presentLeaf(
	schema: GraphQLSchema,
	enclosing: EnclosingSet,
	step: FieldStep
): FieldNode | null {
	const owner = schema.getType(enclosing.typeName);
	if (!isObjectType(owner) && !isInterfaceType(owner)) return null;
	const field: GraphQLField<unknown, unknown> | undefined = owner.getFields()[step.fieldName];
	if (!field) return null;
	if (field.args.some((a) => isNonNullType(a.type) && a.defaultValue === undefined)) return null;
	if (leafSelection(getNamedType(field.type)) !== null) return null;

	return (
		enclosing.selectionSet.selections.find(
			(s): s is FieldNode =>
				s.kind === Kind.FIELD && !s.alias && s.name.value === step.fieldName
		) ?? null
	);
}

/** Variable names already declared by an operation, without the `$`. */
function declaredNames(operation: OperationDefinitionNode): string[] {
	return (operation.variableDefinitions ?? []).map((d) => d.variable.name.value);
}

/* -------------------------------------------------------------------------- */
/* The two public insertions                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Insert a field at (or around) the cursor.
 *
 * Placement, in the order it is tried: the innermost enclosing selection set
 * whose type owns a step of the path, then any enclosing set further out, then
 * a new operation - and for a row with no root path, a refusal instead of the
 * last of those.
 */
export function insertField(
	schema: GraphQLSchema,
	text: string,
	cursor: number,
	request: InsertRequest
): InsertResult {
	const fullPath = request.rootPath ?? [
		{ parentTypeName: request.parentTypeName, fieldName: request.fieldName },
	];
	if (fullPath.length === 0) return { refused: true, reason: "This row cannot be inserted." };

	const analysis = enclosingSets(schema, text, cursor);
	const chain = analysis?.chain ?? [];

	// Deepest enclosing set first: inserting the shortest remaining suffix is
	// both the smallest edit and the one closest to where the user is looking.
	for (let depth = chain.length - 1; depth >= 0; depth--) {
		const enclosing = chain[depth];
		let stepIndex = -1;
		for (let i = fullPath.length - 1; i >= 0; i--) {
			if (fullPath[i].parentTypeName === enclosing.typeName) {
				stepIndex = i;
				break;
			}
		}
		if (stepIndex === -1) continue;

		/*
		 * The suffix is a single leaf and that leaf is already selected here:
		 * inserting it again would add a line the user cannot tell from the one
		 * they already have. Report where it is instead of writing it twice.
		 */
		const suffix = fullPath.slice(stepIndex);
		if (suffix.length === 1) {
			const present = presentLeaf(schema, enclosing, suffix[0]);
			if (present) {
				return {
					alreadyPresent: true,
					start: present.name.loc!.start,
					end: present.name.loc!.end,
					label: present.name.value,
				};
			}
		}

		const namer = new VariableNamer(declaredNames(enclosing.operation));
		const body = renderSteps(schema, fullPath.slice(stepIndex), namer);
		if (body === null) break;

		const edits: Edit[] = [insertIntoSet(text, enclosing.selectionSet, body)];
		const declaration = declareVariables(text, enclosing.operation, namer.declarations);
		if (declaration) edits.push(declaration);

		const applied = applyEdits(text, edits);
		return {
			...applied,
			variables: namer.values,
			placement: depth === chain.length - 1 ? "cursor" : "ancestor",
			label: request.fieldName,
		};
	}

	if (!request.rootPath) {
		return {
			refused: true,
			reason: `Nothing here selects a ${request.parentTypeName}. Put the cursor inside one, or insert this from a Query or Mutation field.`,
		};
	}

	return appendOperation(schema, text, fullPath, analysis?.operations ?? [], request.fieldName);
}

/**
 * Write one of a field's arguments onto that field, as a variable.
 *
 * An argument is not a selection: it is written *onto* a field, so this needs
 * the field to be in the document first. When it is not, the field is inserted
 * by the ordinary rules and the argument goes onto what that wrote - which is
 * what a user clicking `first` under `posts` is asking for, having no interest
 * in doing the two steps themselves.
 *
 * The value is a `$variable` rather than a literal for the reason a required
 * argument already is one: the pane merges a placeholder of the right shape into
 * the Variables editor, where it can be typed over, and a literal written into
 * the query would have to be found and edited in place instead.
 */
export function insertArgument(
	schema: GraphQLSchema,
	text: string,
	cursor: number,
	request: ArgumentInsertRequest
): InsertResult {
	const argument = declaredArgument(schema, request);
	if (!argument) {
		return {
			refused: true,
			reason: `${request.fieldName} no longer takes an argument called ${request.argumentName}.`,
		};
	}

	const selected = selectedField(schema, text, cursor, request);
	if (selected) return writeArgument(text, selected, argument);

	const inserted = insertField(schema, text, cursor, request);
	if (isRefusal(inserted) || isAlreadyPresent(inserted)) return inserted;

	const written = selectedField(schema, inserted.text, inserted.cursor, request);
	/*
	 * The field is in the document now, so what is left is the argument - unless
	 * writing the field already wrote it, which is the ordinary case for a
	 * required one (`search(term: $term)`). Either way the field insertion is the
	 * answer to report: it is the edit that happened, and the argument the user
	 * clicked is on it.
	 */
	if (!written) return inserted;
	const withArgument = writeArgument(inserted.text, written, argument);
	if (isRefusal(withArgument) || isAlreadyPresent(withArgument)) return inserted;
	return {
		...withArgument,
		variables: { ...inserted.variables, ...withArgument.variables },
		placement: inserted.placement,
	};
}

/** The argument the schema declares under that name, or null. */
function declaredArgument(
	schema: GraphQLSchema,
	request: ArgumentInsertRequest
): GraphQLArgument | null {
	const owner = schema.getType(request.parentTypeName);
	if (!isObjectType(owner) && !isInterfaceType(owner)) return null;
	const field: GraphQLField<unknown, unknown> | undefined = owner.getFields()[request.fieldName];
	if (!field) return null;
	return field.args.find((a) => a.name === request.argumentName) ?? null;
}

/**
 * The selection of `request`'s field the argument would land on, or null.
 *
 * The innermost enclosing set whose type owns the field wins, which is the rule
 * `insertField` places by - so the argument lands on the selection the user is
 * looking at rather than on a same-named field in another operation. An *alias*
 * counts here, unlike in `presentLeaf`: `latest: posts` is still the `posts` the
 * argument row belongs to, and the question is which selection to write onto
 * rather than whether one is a duplicate of another.
 *
 * Which is why the *cursor* breaks the tie between two of them. `latest: posts`
 * and `older: posts` are both that field in one set, and the first in document
 * order is not the one the user has their cursor inside - editing that one is a
 * line changing on screen somewhere the user was not looking.
 */
function selectedField(
	schema: GraphQLSchema,
	text: string,
	cursor: number,
	request: InsertRequest
): { field: FieldNode; operation: OperationDefinitionNode } | null {
	const chain = enclosingSets(schema, text, cursor)?.chain ?? [];
	for (let depth = chain.length - 1; depth >= 0; depth--) {
		const enclosing = chain[depth];
		if (enclosing.typeName !== request.parentTypeName) continue;
		const named = enclosing.selectionSet.selections.filter(
			(s): s is FieldNode => s.kind === Kind.FIELD && s.name.value === request.fieldName
		);
		const field = named.find((s) => contains(s, cursor)) ?? named[0];
		if (field) return { field, operation: enclosing.operation };
	}
	return null;
}

/** The argument onto that selection, declared on the operation that gains it. */
function writeArgument(
	text: string,
	target: { field: FieldNode; operation: OperationDefinitionNode },
	argument: GraphQLArgument
): InsertResult {
	const { field, operation } = target;
	const label = `${argument.name} on ${field.name.value}`;

	const existing = (field.arguments ?? []).find((a) => a.name.value === argument.name);
	if (existing) {
		return {
			alreadyPresent: true,
			start: existing.name.loc!.start,
			end: existing.name.loc!.end,
			label,
		};
	}

	const namer = new VariableNamer(declaredNames(operation));
	const type = argument.type.toString();
	const variable = namer.claim(
		argument.name,
		type,
		placeholderFor(getNamedType(argument.type), type.includes("["))
	);

	const edits: Edit[] = [argumentEdit(field, `${argument.name}: $${variable}${CARET}`)];
	const declaration = declareVariables(text, operation, namer.declarations);
	if (declaration) edits.push(declaration);

	return {
		...applyEdits(text, edits),
		variables: namer.values,
		placement: "argument",
		label,
	};
}

/**
 * An edit adding `argument` to a field's list, opening one when it has none.
 *
 * The caret rides inside `argument`, so it lands on what was just written rather
 * than at the end of the document - which is where `applyEdits` puts it for an
 * edit carrying no marker.
 */
function argumentEdit(field: FieldNode, argument: string): Edit {
	const args = field.arguments ?? [];
	if (args.length === 0) {
		const at = field.name.loc!.end;
		return { start: at, end: at, text: `(${argument})` };
	}
	/*
	 * Straight after the last argument, rather than in front of the closing
	 * paren found by searching for one: a `)` inside a comment in the argument
	 * list (`search(term: $term # (see)`) is found first, and the argument would
	 * be written into the comment - added to nothing, silently. This is also the
	 * tidier edit on a list spread over several lines.
	 */
	const at = args[args.length - 1].loc!.end;
	return { start: at, end: at, text: `, ${argument}` };
}

/** A whole new operation, named after the field so it can never be anonymous. */
function appendOperation(
	schema: GraphQLSchema,
	text: string,
	path: FieldStep[],
	operations: OperationDefinitionNode[],
	fieldName: string
): InsertResult {
	const rootName = path[0].parentTypeName;
	const kind =
		schema.getMutationType()?.name === rootName
			? "mutation"
			: schema.getSubscriptionType()?.name === rootName
				? "subscription"
				: "query";

	const namer = new VariableNamer([]);
	const body = renderSteps(schema, path, namer);
	if (body === null) return { refused: true, reason: "This field is no longer in the schema." };

	/*
	 * Named, always. An anonymous operation beside a named one is invalid, and
	 * the document this is appended to may already have names - or gain them the
	 * next time this runs. A name is never wrong; omitting one sometimes is.
	 */
	const taken = new Set(operations.map((op) => op.name?.value).filter(Boolean) as string[]);
	const base = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}${n}`;

	const defs =
		namer.declarations.length > 0
			? `(${namer.declarations.map((d) => `$${d.name}: ${d.type}`).join(", ")})`
			: "";
	const operation = `${kind} ${name}${defs} {\n${indentBlock(body)}\n}`;
	const applied = applyEdits(withBlankLine(text) + operation + "\n", []);
	return {
		...applied,
		variables: namer.values,
		placement: "new-operation",
		label: `${kind} ${name}`,
	};
}

/**
 * A fragment definition on `typeName`, **and the spread that uses it**.
 *
 * The two are one edit because a fragment nothing spreads is not merely
 * useless, it is invalid: `Fragment "X" is never used` is a validation rule
 * every spec-conformant server enforces, and it rejects the *whole* request -
 * including the operation the user already had and did not touch. Appending a
 * definition on its own therefore breaks a working document, which is the
 * opposite of what a click should do.
 *
 * So the spread decides where a fragment can go at all: the cursor has to be in
 * a selection set the fragment applies to. Anywhere else is refused, which is
 * the same honest end as every other placement this module cannot make.
 */
/**
 * The selection set a fragment on `type` can be spread into, innermost first.
 *
 * **Compatibility, not equality.** A fragment on a concrete type belongs
 * inside a selection of the interface it implements or the union it joins -
 * `fragment PostFields on Post` spread into a `Query.node: Node` selection is
 * the case named fragments exist for, and an equality test refuses it while
 * the user is looking straight at the set it goes in.
 *
 * The predicate is `doTypesOverlap`, the one `PossibleFragmentSpreadsRule`
 * validates with, so this cannot write a spread the server then rejects - the
 * failure a hand-rolled subtype walk would eventually produce. An exact match
 * still wins over an overlapping one: it is the set the user is in, not merely
 * one the spread is legal in.
 */
function spreadHost(
	schema: GraphQLSchema,
	type: GraphQLCompositeType,
	chain: EnclosingSet[]
): EnclosingSet | null {
	let overlapping: EnclosingSet | null = null;
	for (let depth = chain.length - 1; depth >= 0; depth--) {
		const host = chain[depth];
		if (host.typeName === type.name) return host;
		const hostType = schema.getType(host.typeName);
		if (!overlapping && isCompositeType(hostType) && doTypesOverlap(schema, type, hostType)) {
			overlapping = host;
		}
	}
	return overlapping;
}

export function insertFragment(
	schema: GraphQLSchema,
	text: string,
	cursor: number,
	typeName: string
): InsertResult {
	const type = schema.getType(typeName);
	if (!isObjectType(type) && !isInterfaceType(type) && !isUnionType(type)) {
		return {
			refused: true,
			reason: `A fragment needs an object, interface or union type. ${typeName} is neither.`,
		};
	}

	const host = spreadHost(schema, type, enclosingSets(schema, text, cursor)?.chain ?? []);
	if (!host) {
		return {
			refused: true,
			reason: `Nothing here can hold a fragment on ${typeName}. Put the cursor inside a selection that can - a fragment nothing spreads is rejected with the rest of the document.`,
		};
	}

	let doc;
	try {
		doc = parse(maskGraphqlTemplates(text).masked);
	} catch {
		doc = null;
	}
	const taken = new Set(
		(doc?.definitions ?? [])
			.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
			.map((d) => (d.kind === Kind.FRAGMENT_DEFINITION ? d.name.value : ""))
	);
	let name = `${typeName}Fields`;
	for (let n = 2; taken.has(name); n++) name = `${typeName}Fields${n}`;

	const body = leafSelection(type) ?? "__typename";
	const definition = `fragment ${name} on ${typeName} {\n${indentBlock(`${body}${CARET}`)}\n}`;
	/*
	 * The definition goes after everything, the spread where the cursor is, and
	 * `applyEdits` commits them last-first so the spread's offsets are still the
	 * ones it was computed against.
	 */
	const gap = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
	const applied = applyEdits(text, [
		insertIntoSet(text, host.selectionSet, `...${name}`),
		{ start: text.length, end: text.length, text: `${gap}${definition}\n` },
	]);
	return { ...applied, variables: {}, placement: "fragment", label: `fragment ${name}` };
}

/* -------------------------------------------------------------------------- */
/* The variables pane                                                          */
/* -------------------------------------------------------------------------- */

export interface VariablesMerge {
	/** The pane's new text, or the old text unchanged when nothing was written. */
	text: string;
	/** Variable names the pane does not hold a value for. Drives the badge. */
	pending: string[];
}

/**
 * Fold new variables into the Variables pane, or refuse to touch it.
 *
 * **Never replace, and never touch text that is not strict JSON.** A pane
 * holding `{"id": {{userId}}}` is a working template that `JSON.parse` rejects;
 * rewriting it would delete the user's draft to make room for a placeholder.
 * Existing keys keep their values for the same reason - a value that is already
 * there is one the user chose, and an insertion is not a reason to reconsider
 * it. What is left over is reported as `pending`, which is what the badge says
 * out loud instead.
 */
export function mergeVariables(text: string, incoming: Record<string, unknown>): VariablesMerge {
	const names = Object.keys(incoming);
	if (names.length === 0) return { text, pending: [] };

	const trimmed = text.trim();
	if (!trimmed) return { text: JSON.stringify(incoming, null, 2), pending: [] };

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { text, pending: names };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { text, pending: names };
	}

	const existing = parsed as Record<string, unknown>;
	const merged = { ...existing };
	for (const [name, value] of Object.entries(incoming)) {
		if (!(name in merged)) merged[name] = value;
	}
	return { text: JSON.stringify(merged, null, 2), pending: [] };
}

/* -------------------------------------------------------------------------- */
/* The explorer row that asked for it                                          */
/* -------------------------------------------------------------------------- */

/**
 * What activating an explorer row should do to the document.
 *
 * A separate function because it is the whole decision - which of the two
 * insertions applies, and which rows have no insertion at all - and because a
 * refusal has to be a *value* the caller announces rather than a silent return.
 * It lives here rather than in the pane so the decision is testable without a
 * Monaco editor in the room, and so the pane holds no insertion rules of its own.
 */
export function insertionForNode(
	schema: GraphQLSchema,
	node: SchemaTreeNode,
	query: string,
	cursor: number
): InsertResult | null {
	// A branch, a "Returned by" heading and an "Arguments" heading are
	// containers. Activating one is the toggle, which the row already handles;
	// there is nothing to write.
	if (node.kind === "branch" || node.kind === "returned-by" || node.kind === "arguments") {
		return null;
	}

	if (node.kind === "input-field" || node.kind === "enum-value") {
		return {
			refused: true,
			reason: `${node.name} is part of an argument, not a selection. Insert the field that takes it, then fill the value in.`,
		};
	}

	if (node.kind === "type") return insertTypeSelection(schema, query, cursor, node.name);

	if (node.branch === "subscription") {
		// Named for the field, even when the row is one of its arguments: what
		// cannot be run is the subscription, not the argument.
		const subject = node.argumentOwner?.fieldName ?? node.name;
		return {
			refused: true,
			reason: `Subscriptions cannot be run here. Vayu sends one request and reads one response, so ${subject} is shown for reference only.`,
		};
	}

	if (node.kind === "argument") {
		const owner = node.argumentOwner;
		// Only a row built by `childNodes` reaches here, and that one always
		// carries its field. A row that does not is not an argument of anything.
		if (!owner) return { refused: true, reason: `${node.name} belongs to no field.` };
		const field = { ...owner, rootPath: owner.rootPath };
		return insertArgument(schema, query, cursor, {
			...field,
			rootPath: rootedPath(schema, field),
			argumentName: node.name,
		});
	}

	const field = {
		parentTypeName: node.ownerTypeName ?? "",
		fieldName: node.name,
		rootPath: node.rootPath,
	};
	return insertField(schema, query, cursor, { ...field, rootPath: rootedPath(schema, field) });
}

/**
 * The route to a field, borrowing one to its owner when the row has none.
 *
 * A field found by search under a non-root type carries no path - `Post.title`
 * says nothing about how a `Post` is reached - and until now that made the
 * commonest search result un-insertable: clicking it produced a refusal
 * whenever the cursor was not already inside a `Post`. It is only un-insertable
 * if nothing is allowed to say how a `Post` is reached, and the schema does say:
 * `rootPathsToType` reads the root fields that answer with one. Borrowing the
 * best of those and appending this field is the same path the user would have
 * built by expanding the tree, arrived at without the expanding.
 *
 * Takes the request rather than the row, because an argument row names its
 * field in `argumentOwner` and its own `name` is the argument's: reading a field
 * out of the row would build a step for a field that does not exist.
 *
 * Still null when nothing returns the owner type, which is the honest answer and
 * the case `insertField` refuses out loud.
 */
function rootedPath(schema: GraphQLSchema, request: InsertRequest): FieldStep[] | null {
	if (request.rootPath) return request.rootPath;
	if (!request.parentTypeName) return null;
	const [best] = rootPathsToType(schema, request.parentTypeName);
	if (!best) return null;
	return [...best, { parentTypeName: request.parentTypeName, fieldName: request.fieldName }];
}

/**
 * What activating a *type* row writes.
 *
 * A type row used to write a fragment unconditionally, which on an empty
 * document left `fragment PostFields on Post { … }` and nothing else: a
 * document that parses, holds no operation, and cannot be sent. A user clicking
 * a type in a schema browser is asking "give me one of these", and the answer
 * to that is the query that returns one.
 *
 * So: the best route from a root field, when the schema has one. Otherwise a
 * fragment, which `insertFragment` writes only where its spread can go and
 * refuses everywhere else. Never a fragment alone.
 */
function insertTypeSelection(
	schema: GraphQLSchema,
	text: string,
	cursor: number,
	typeName: string
): InsertResult {
	const [best] = rootPathsToType(schema, typeName);
	if (!best) return insertFragment(schema, text, cursor, typeName);

	const last = best[best.length - 1];
	return insertField(schema, text, cursor, {
		parentTypeName: last.parentTypeName,
		fieldName: last.fieldName,
		rootPath: best,
	});
}
