/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Core Domain Types

/**
 * HTTP protocol to negotiate. Declared in `@/constants/request` (derived from
 * the `HTTP_VERSIONS` list, the single source of truth also consumed by the
 * Settings tab picker) and re-exported here, same pattern as `ColorScheme` in
 * `types/ui.ts`, so `Request.httpVersion` below can reference it.
 */
import type { HttpVersion } from "@/constants/request";
export type { HttpVersion };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type BodyMode =
	| "none"
	| "json"
	| "text"
	| "graphql"
	| "jsonrpc"
	| "xml"
	| "form-data"
	| "x-www-form-urlencoded";

export type AuthMode =
	| "none"
	| "noauth"
	| "inherit"
	| "bearer"
	| "basic"
	| "apikey"
	| "oauth2"
	| "digest"
	| "aws"
	| "ntlm";

/**
 * A single key-value entry (headers, params, form fields).
 * `enabled: false` rows are preserved in storage and excluded only at HTTP-execution time.
 * Duplicates are allowed (useful for multiple `Accept` headers etc.).
 */
export interface KeyValueEntry {
	key: string;
	value: string;
	enabled: boolean;
	description?: string;
}

/**
 * Variable value with enabled flag and optional type hint.
 * Note: `secret` is a UI masking hint - values are NOT encrypted at rest.
 * Note: `type` affects UI rendering and validation only; values are always stored as strings.
 */
export interface VariableValue {
	value: string;
	enabled: boolean;
	secret?: boolean;
	type?: "string" | "number" | "boolean" | "json";
	createdAt?: number;
}

/**
 * One part of a `form-data` body: typed text, or a file read from disk when the
 * request is sent.
 *
 * A file part names a path in `src` instead of carrying bytes in `value` - the
 * engine opens it at send time, so nothing here (and nothing in storage) holds
 * the contents. `fileName` and `contentType` override what the part declares
 * about itself; absent means the engine lets libcurl derive them from the path.
 *
 * `unresolved` marks a path this app never chose: an import carries the path
 * from whoever exported the collection, and that path usually does not exist on
 * this machine. It is what the editor's warning reads, and it is cleared the
 * moment the user picks a file. `x-www-form-urlencoded` has no file form, so a
 * file part is only ever valid under `form-data`.
 */
export interface FormFieldEntry extends KeyValueEntry {
	type?: "text" | "file";
	src?: string;
	fileName?: string;
	contentType?: string;
	unresolved?: boolean;
}

/**
 * Request body as a discriminated union.
 * `body_type` on the domain `Request` is a denormalized mirror of `body.mode`.
 */
export type RequestBody =
	| { mode: "none" }
	| { mode: "json" | "text" | "graphql" | "jsonrpc" | "xml"; content: string }
	| { mode: "form-data"; fields: FormFieldEntry[] }
	| { mode: "x-www-form-urlencoded"; fields: KeyValueEntry[] };

/**
 * Auth configuration for requests.
 * `inherit` resolves by walking the parent collection chain at execution time.
 * Collections never use `inherit` - they are always the auth source.
 */
export type OAuth2GrantType = "authorization_code" | "client_credentials" | "password";

/**
 * OAuth 2.0 configuration. Every string field may contain {{variables}},
 * resolved app-side before the config is sent to the engine. `state` is
 * intentionally absent - it is always generated per authorization attempt.
 */
export interface OAuth2Config {
	grantType: OAuth2GrantType;
	authorizationUrl?: string; // authorization_code only
	accessTokenUrl: string;
	refreshTokenUrl?: string; // defaults to accessTokenUrl
	callbackUrl?: string; // authorization_code; empty = auto loopback
	clientId: string;
	clientSecret?: string;
	credentialsPlacement?: "basic_auth_header" | "body"; // default basic_auth_header
	username?: string; // password grant
	password?: string; // password grant
	pkce?: boolean; // default true (authorization_code)
	scope?: string;
	audience?: string;
	resource?: string;
	tokenPlacement?: "header" | "query"; // default header
	headerPrefix?: string; // default "Bearer"
	queryParamName?: string; // default "access_token"
	autoFetchToken?: boolean; // default true
	autoRefreshToken?: boolean; // default true
	useEmbeddedBrowser?: boolean; // default false
	credentialsId?: string; // default "default"
}

/**
 * `none` vs `noauth` - the distinction the inheritance walk turns on.
 *
 * On a collection, `none` means "nothing configured here": the walk steps past
 * it and a descendant `inherit` keeps climbing. `noauth` means "configured to
 * send nothing", which *terminates* the walk - descendants inherit no
 * credentials. Postman draws the same line (a folder set to No Auth blocks
 * inheritance; a folder left on Inherit does not), and collapsing the two is how
 * an imported No Auth folder used to leak its parent's bearer token (issue
 * #195). `resolveAuthSource` in `modules/request-builder/utils/auth-resolution.ts`
 * is the one place that reads the difference, mirrored for MCP in
 * `electron/mcp/resolve.ts`.
 *
 * On a *request* the two coincide - a request's own auth is never walked, so
 * `none` already means send nothing - which is why only the collection editor
 * offers `noauth`.
 */
export type RequestAuth =
	| { mode: "none" | "noauth" | "inherit" }
	| { mode: "bearer"; token: string }
	| { mode: "basic"; username: string; password: string }
	| { mode: "apikey"; key: string; value: string; in: "header" | "query" }
	| { mode: "oauth2"; config: OAuth2Config }
	| { mode: "digest" | "aws" | "ntlm"; config: Record<string, unknown> };

/**
 * The data contract a collection declares (issue #599): which columns a run's
 * data file is expected to carry, so `{{data.*}}` and `pm.iterationData` have
 * something to be checked against at authoring time.
 *
 * The *schema* is collection state and rides the engine row. The file itself is
 * machine state and lives in `data-file-store`; its **rows** are persisted
 * nowhere at all - they are user data of unknown sensitivity, and that rule is
 * older than this field.
 *
 * `{}` - every field absent - is how "declares no contract" is spelled, which
 * is also what the engine stores by default.
 */
export interface CollectionDataSchema {
	/** Declared column names, in the order the file listed them. */
	columns?: string[];
	/** When the contract was declared, epoch ms. */
	declaredAt?: number;
	/** The file the columns were read from, for the "is this still it?" case. */
	fileName?: string;
}

/**
 * The OpenAPI document a collection is bound to (issue #637, phase 1 of #625).
 *
 * The document itself is a top-level engine resource (`/specs`) rather than a
 * column here: several collections may bind the same spec, so the binding names
 * it by id and nothing about the document travels on the collection row.
 *
 * `specHash` records which *version* the collection was last synced to, which is
 * what makes drift detectable at all - a re-fetch that hashes the same is "up to
 * date", and a run of a bound collection is stamped with both values.
 *
 * `{}` - every field absent - is how "bound to nothing" is spelled, which is
 * also what the engine stores by default.
 */
export interface CollectionOpenApiBinding {
	/** The stored spec document's engine id. */
	specId?: string;
	/** Hex sha256 of the document the binding was last made against. */
	specHash?: string;
	/** When the binding was last made or re-synced, epoch ms. */
	syncedAt?: number;
}

/**
 * One row of the declared-operation index stored beside a spec document
 * (issue #629): an operation's identity plus the status patterns its `responses`
 * map declares.
 *
 * The index exists because **the engine does not parse OpenAPI** - the division
 * of labour #625 decided - and contract coverage still has to know which
 * operations a document declares and which responses each promises. So the side
 * that already parses the document writes it down, once, at the moment the
 * document is stored, and the engine counts against it without ever reading the
 * document itself.
 *
 * `responses` keeps the patterns verbatim and in document order: `"200"`, `"4XX"`
 * and `"default"` are three different promises, and expanding a range into codes
 * would report a contract the document never wrote.
 */
export interface DeclaredOperation {
	operationId?: string;
	method: string;
	path: string;
	responses: string[];
}

/**
 * One response schema a document declares, by status pattern and media type
 * (issue #628).
 *
 * `status` is the pattern verbatim - `"200"`, `"4XX"`, `"default"` - for the
 * same reason `DeclaredOperation.responses` keeps them that way. `schema` is
 * JSON Schema, translated out of OpenAPI's dialect when it was extracted (see
 * `services/importers/response-schemas.ts`), and may legally be `true` or
 * `false` as well as an object.
 */
export interface DeclaredResponseSchema {
	status: string;
	contentType: string;
	schema: unknown;
}

/**
 * The response schemas a document declares, as stored beside it on the engine
 * (issue #628).
 *
 * `refRoots` holds the document's `components` / `definitions` /
 * `x-vayu-bundled` subtrees **once**, and the schemas below keep their `$ref`s
 * as written; the engine merges the two to validate. Inlining instead would
 * copy a shared `Error` schema into every operation naming it, and a recursive
 * schema has no finite expansion at all.
 */
export interface ResponseSchemaIndex {
	refRoots?: Record<string, unknown>;
	operations: (SpecOperation & { responses: DeclaredResponseSchema[] })[];
}

/**
 * Why a response was not checked against its contract (issue #628).
 *
 * Codes rather than sentences: the engine decides *that* something could not be
 * checked, the app decides how to say so. An unbound collection produces no
 * verdict at all rather than one of these - "not judged against a contract" and
 * "judged and could not be read" are different answers.
 */
export type ValidationUncheckedReason =
	| "no_operation"
	| "no_index"
	| "hash_mismatch"
	| "never_stamped"
	| "operation_not_declared"
	| "no_schema_for_status"
	| "no_schema_for_content_type"
	| "no_response"
	| "body_not_json";

/** One thing wrong with a body, at a JSON Pointer inside it. */
export interface SchemaFailure {
	path: string;
	message: string;
}

/**
 * What checking one response against its declared schema found (issue #628).
 *
 * `checked: false` carries a `reason` and **no** `valid`: a response nothing
 * checked has no validity to report, and rendering one as a failure is the
 * confusion this shape exists to prevent.
 *
 * `unevaluatedKeywords` is the dialect disclosure - schema keywords the
 * validator could not evaluate, by name and count. Non-empty means part of the
 * contract went unread, so a `valid: true` beside it is narrower than it looks.
 */
export interface ResponseValidation {
	checked: boolean;
	valid?: boolean;
	reason?: ValidationUncheckedReason;
	failures?: SchemaFailure[];
	failuresTotal?: number;
	unevaluatedKeywords?: { keyword: string; count: number }[];
	matchedStatus?: string;
	matchedContentType?: string;
}

/**
 * One operation's row in a run report's coverage block (issue #629).
 *
 * `declaredHit` and `declaredMissed` partition the operation's declared status
 * patterns; `undeclaredSeen` holds the statuses that answered to none of them -
 * a 500 the document never mentions is a finding, not a miss. A status matches
 * the most specific pattern that covers it, so an operation declaring both
 * `200` and `2XX` that only ever answered 200 reports `2XX` as missed.
 */
export interface RunCoverageOperation {
	operationId?: string;
	method: string;
	path: string;
	/** Requests sent for this operation, transport failures included. */
	sent: number;
	statusesSeen: number[];
	declaredHit: string[];
	declaredMissed: string[];
	undeclaredSeen: number[];
	/** Sends that never got a response. Absent when there were none. */
	transportErrors?: number;
	/** Responses whose status fell outside 100-599. Absent when there were none. */
	otherStatusResponses?: number;
	/**
	 * Distinct statuses this operation answered with that appear in *neither*
	 * list above, dropped by the per-row cap. Absent when both lists are
	 * complete.
	 *
	 * Counted across the two lists together rather than per list (issue #786):
	 * `undeclaredSeen` repeats codes from `statusesSeen`, so a code past both
	 * caps would otherwise be counted twice, and a code the undeclared list
	 * still carries is not hidden at all.
	 */
	statusesTruncated?: number;
}

/**
 * A run's contract coverage (issue #629). See {@link RunReport.coverage} for
 * when it is present and what it is computed against.
 *
 * The four rollup numbers are deliberately plain: a CLI gate (#473) can
 * threshold on them without reshaping the block, the same way it would on
 * `thresholdValidation`'s counts.
 */
export interface RunCoverage {
	operationsTotal: number;
	operationsCovered: number;
	declaredResponsesTotal: number;
	declaredResponsesHit: number;
	declaredResponseCoveragePct: number;
	/** Distinct (operation, status) pairs the document declares nothing for. */
	undeclaredStatusesSeen: number;
	/** Uncovered operations first - they are the finding. */
	operations: RunCoverageOperation[];
	/** Sends that never got a response, across every operation. */
	transportErrors?: number;
	/** Requests sent against an identity the document does not declare. */
	undeclaredOperationRequests?: number;
}

/**
 * What checking a load run's **sampled** responses against its bound contract
 * found (issue #682). See {@link RunReport.schemaValidation} for when it is
 * present.
 *
 * The sibling of {@link RunCoverage}, and the opposite of it in the one way that
 * matters to a reader: coverage counts every send, this checks the bounded
 * reservoir the run stored. `sampled` is therefore not decoration - it is the
 * denominator that stops `failed: 0` being read as "no response failed" when it
 * means "no sampled response failed".
 *
 * `checked` is what a schema could speak about; `uncheckedReasons` accounts for
 * the rest by engine reason code, so `sampled - checked` is never an unexplained
 * gap. `unevaluated` counts checked responses whose schema carried a keyword the
 * draft-07 validator could not evaluate - they passed every check that *ran*,
 * which is a narrower claim than valid.
 */
export interface RunSchemaValidation {
	sampled: number;
	checked: number;
	valid: number;
	failed: number;
	unevaluated: number;
	/** Engine reason code -> how many samples it accounts for. */
	uncheckedReasons?: Partial<Record<ValidationUncheckedReason, number>>;
	unevaluatedKeywords?: { keyword: string; count: number }[];
	/** Bounded examples, capped engine-side across the whole run. */
	failures: { step?: string; status: number; path: string; message: string }[];
	/** Every failure found, the cap included - so "3 of 90" stays readable. */
	failuresTotal: number;
	/**
	 * Whether `sampled` is the whole population rather than a reservoir (issue
	 * #681).
	 *
	 * A collection run checks **every step it executed**, so its figures are
	 * exact and the block must not tell a reader they describe a sample. A load
	 * run omits this, and the sampled reading below is the default - the safer
	 * one to fall back to, since a report from an engine older than this field
	 * was sampled.
	 */
	exact?: boolean;
	/**
	 * Whether a schema failure was allowed to fail its step (collection runs).
	 *
	 * Set from the Run dialog and disclosed by `SampledSchemaValidation`
	 * (issue #720): the step list's failure count means a different thing
	 * depending on it, so the block that carries the tally says which run this
	 * was rather than leaving a reader to infer it.
	 */
	failOnSchemaError?: boolean;
}

/**
 * Which operation of a collection's bound spec a request *is* (issue #637).
 *
 * `path` is the **templated** path as the document writes it (`/pets/{petId}`),
 * never the concrete URL the request sends: it is the identity a re-fetched spec
 * is diffed against, and a URL carrying resolved variables would stop matching
 * the moment an environment changed. `operationId` is optional because an
 * OpenAPI operation may declare none.
 */
export interface SpecOperation {
	operationId?: string;
	method: string;
	path: string;
}

export interface Collection {
	id: string;
	name: string;
	description: string;
	parentId?: string;
	order: number;
	variables: Record<string, VariableValue>;
	auth: Exclude<RequestAuth, { mode: "inherit" }>; // Collections are auth sources, never inherit
	preRequestScript: string;
	postRequestScript: string;
	/**
	 * Optional the way `parentId` is: most collections declare no contract, and
	 * absent and `{}` are the same state to every reader. Use
	 * {@link hasDataContract} rather than hand-rolling the check - a collection
	 * that declared and then cleared one holds `{}`, not `undefined`.
	 *
	 * The transformer always produces a value, so a `Collection` off the wire
	 * carries one; the optionality is for the fixtures and partials that do not
	 * care, not a claim that the field can go missing in flight.
	 */
	dataSchema?: CollectionDataSchema;
	/**
	 * Optional for the same reason `dataSchema` is: most collections are bound to
	 * no spec, and absent and `{}` are the same state to every reader. Use
	 * {@link hasSpecBinding} rather than hand-rolling the check - a collection
	 * that was bound and then unbound holds `{}`, not `undefined`.
	 */
	openapi?: CollectionOpenApiBinding;
	createdAt: string;
	updatedAt: string;
}

/** Whether a collection declares a data contract at all. */
export function hasDataContract(schema: CollectionDataSchema | undefined): boolean {
	return !!schema?.columns && schema.columns.length > 0;
}

/**
 * Whether a collection is bound to a spec document.
 *
 * `specId` and not the object: unbinding stores `{}`, and a `syncedAt` with no
 * document to go with it is a half-written binding nothing can read.
 */
export function hasSpecBinding(binding: CollectionOpenApiBinding | undefined): boolean {
	return !!binding?.specId;
}

/**
 * The contract that answers for a request, and which collection declared it
 * (issue #600).
 *
 * A contract is declared on one collection but binds every request beneath it,
 * so "which columns are in scope here" is a *chain* answer, not a row read -
 * see `lib/data-contract.ts` for the walk and `docs/app/variable-resolution.md`
 * for the rule. The declaring collection travels with the columns because every
 * surface that shows them has to say where they came from: a token painted
 * amber in a sub-collection is only actionable if the tooltip names the
 * collection whose Data tab would fix it.
 */
export interface DataContractScope {
	/**
	 * The name of the collection that declared it - an ancestor, or the leaf.
	 *
	 * The name and not the id, because every consumer *shows* this: the token
	 * tooltip, the two completion lists.
	 */
	collectionName: string;
	/**
	 * The id of that collection (issue #601).
	 *
	 * Added the day something needed to reach the declaring collection rather
	 * than name it: Send-with-row looks up the data file `data-file-store`
	 * remembers, and that entry is keyed by the collection whose Data tab
	 * declared the contract - which under the chain rule is an ancestor as often
	 * as it is the request's own parent.
	 */
	collectionId: string;
	/** Declared column names, in the order the contract lists them. */
	columns: string[];
}

/** A row the sidebar places in a tree - a {@link Collection} or a {@link Request}. */
export interface OrderedTreeRow {
	order?: number;
	createdAt?: string;
	id?: string;
}

/**
 * The one ordering rule for collections and requests alike: `order` ascending,
 * ties by creation time, remaining ties by id.
 *
 * There used to be two comparators with two different tie rules - collections
 * tiebroke by id, requests by `createdAt` - while the engine tiebroke by
 * neither, leaving ties to a rowid that `INSERT OR REPLACE` reassigns on every
 * edit. So "run this folder" could execute in a different order than the
 * sidebar showed, and either order could change after an unrelated rename.
 *
 * The rule is now identical on both sides, pinned by
 * `engine/tests/fixtures/tree-order-conformance.json` (issue #360). Two details
 * are load-bearing rather than incidental:
 *
 *  - **`createdAt` before `id`.** Every request created before explicit orders
 *    existed sits at `order: 0`, so creation time is what the user has been
 *    seeing; making the id primary would visibly reshuffle their tree.
 *  - **`<` rather than `localeCompare`.** The engine's tiebreak is SQLite's
 *    BINARY collation, which is byte-wise; locale collation disagrees with it
 *    on case ("Row-A" vs "row-a"), and this comparator's job is to match the
 *    engine exactly.
 */
export function compareTreeOrder(a: OrderedTreeRow, b: OrderedTreeRow): number {
	const orderDiff = (a.order ?? 0) - (b.order ?? 0);
	if (orderDiff !== 0) return orderDiff;

	const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
	const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
	if (aTime !== bTime) return aTime - bTime;

	const aId = a.id ?? "";
	const bId = b.id ?? "";
	if (aId === bId) return 0;
	return aId < bId ? -1 : 1;
}

/**
 * One part of a script that runs for a request, and where it came from.
 *
 * The clients used to join the collection chain's scripts with the request's
 * own and send a single string, so a stored run could not say which part came
 * from where - and writing that string back to a request would put the
 * collection's script inside it permanently. The engine joins them now.
 *
 * `origin`/`id`/`name` are sent and persisted starting with this change, but
 * nothing in the app reads them back yet - that is intentional groundwork for
 * the run/history views (not yet built) to attribute a script failure to the
 * collection or request it came from. Do not read this as dead weight; it is
 * the next layer's job to add the reader.
 */
export interface ScriptPart {
	origin: "collection" | "request";
	id?: string;
	/** Collection name, for showing the user where a part came from. */
	name?: string;
	script: string;
}

export interface Request {
	id: string;
	collectionId: string;
	name: string;
	description: string;
	method: HttpMethod;
	url: string;
	params: KeyValueEntry[];
	headers: KeyValueEntry[];
	body: RequestBody;
	bodyType: BodyMode; // Denormalized mirror of body.mode - kept for queryability
	auth: RequestAuth;
	preRequestScript: string;
	postRequestScript: string;
	/** Follow 3xx `Location` responses. Engine default is `true`. */
	followRedirects: boolean;
	/** Redirect hops allowed when {@link followRedirects} is on. Engine default is 10. */
	maxRedirects: number;
	/**
	 * HTTP protocol to negotiate for this request. `"auto"` lets curl pick
	 * (ALPN over TLS, HTTP/1.1 otherwise) - see {@link HTTP_VERSIONS}. This is
	 * the *requested* protocol; the protocol actually negotiated for a given
	 * response is `ResponseState.httpVersion`, a different, display-string
	 * value space - do not unify them.
	 */
	httpVersion: HttpVersion;
	/**
	 * Verify the TLS certificate this endpoint presents. Engine default is
	 * `true`, and it is sent on every payload rather than elided at the default
	 * for exactly that reason: an omitted `false` verifies the certificate the
	 * user asked the engine not to check (issue #706).
	 *
	 * Per-request, not app-wide: it describes the one internal host with the
	 * self-signed certificate. Trusting an authority everywhere is the other
	 * control, Settings > Network & connectivity > Custom CA Certificates, and
	 * it is the one to reach for first.
	 */
	verifySSL: boolean;
	/**
	 * Consume this endpoint's response as a `text/event-stream` (issue #574).
	 * Stored on the request because it describes the *endpoint* rather than one
	 * send, so the builder's Event stream toggle survives a tab switch and a
	 * bulk import carries it. Always present: a request saved before the column
	 * existed reads back `false`, which is what it was.
	 */
	stream: boolean;
	/**
	 * Which operation of the collection's bound spec this request is (issue
	 * #637). Optional rather than always-present, unlike `stream`: the engine
	 * serializes `null` for a request that names none, and `undefined` is how
	 * every reader here spells that - `hasSpecBinding`'s counterpart at the
	 * request level is a plain presence check.
	 */
	specOperation?: SpecOperation;
	order: number;
	createdAt: string;
	updatedAt: string;
}

/**
 * A saved example response stored against a request (issue #481).
 *
 * What an importer found next to the request - Postman's saved responses, an
 * OpenAPI operation's documented ones - and, once the mock server lands, the
 * response it serves. Read-only in the app today: examples are created by
 * import, so the request builder lists them and nothing writes one.
 *
 * The engine's row carries `order` and timestamps too. They are absent here on
 * purpose: the list arrives already in `order`, and no surface displays either,
 * so typing them would claim readers this app does not have.
 */
export interface RequestExample {
	id: string;
	name: string;
	/** The HTTP status this example documents. */
	status: number;
	/** Response headers as recorded, duplicates and order intact. */
	headers: KeyValueEntry[];
	body: string;
	/** `""` when the source stated no media type - not a guess. */
	contentType: string;
	/**
	 * True when `body` is only the first slice of the response this was saved
	 * from (issue #659).
	 *
	 * Typed here because the panel paints a chip from it: a mock server serves
	 * the stored body verbatim, so an example nobody marked as partial is
	 * indistinguishable from a complete one. Absent on rows written before the
	 * engine had the column, which are all complete by construction.
	 */
	bodyTruncated?: boolean;
}

export interface Environment {
	id: string;
	name: string;
	description: string;
	variables: Record<string, VariableValue>;
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
}

/**
 * Global variables - singleton storage for app-wide variables
 */
export interface GlobalVariables {
	id: string; // Always "globals"
	variables: Record<string, VariableValue>;
	updatedAt: string;
}

/**
 * Variable scope for UI display and resolution priority.
 * Resolution priority: Environment > Collection (leaf-to-root) > Global
 */
export type VariableScope = "global" | "collection" | "environment";

/**
 * Resolved variable with its value, scope, and secret flag.
 * Note: The `secret` field is a UI hint for masking - values are NOT encrypted at rest.
 *
 * `value` is always the raw string form (used for `{{var}}` interpolation in
 * URLs / headers / body). `type` and `typedValue` expose the declared
 * conversion for consumers that want the cast JS value (scripts, autocomplete).
 */
export interface ResolvedVariable {
	value: string;
	scope: VariableScope;
	secret?: boolean;
	type?: VariableValue["type"];
	typedValue?: unknown;
	/**
	 * Which collection or environment this value came from. Absent for `global`,
	 * which is a singleton and has no name to give.
	 *
	 * These sat on `VariableInfo` for a long time, declared and never written by
	 * anything in `src/` - so the popover could say a variable came from "an
	 * environment" but not *which* one, in an app where having several is the
	 * point. Moved down to `ResolvedVariable` because the resolver is what knows,
	 * and it produces this type.
	 */
	sourceId?: string;
	sourceName?: string;
}

/**
 * One definition of a variable name, at one scope.
 *
 * The resolver flattens every scope into a single winner, which is all execution
 * needs and strictly less than the UI needs: "why is this the value?" cannot be
 * answered from the winner alone. Two cases in particular are invisible without
 * the losers - a name defined at several scopes, and a name whose highest-scope
 * definition is *disabled*, which is the most common reason a value is not the
 * one you expected.
 *
 * Disabled definitions are therefore kept here even though they never resolve.
 */
export interface VariableOrigin {
	scope: VariableScope;
	/** Absent for `global`, as on ResolvedVariable. */
	sourceId?: string;
	sourceName?: string;
	value: string;
	secret?: boolean;
	/** The declared conversion, carried so the winner can rebuild `typedValue`. */
	type?: VariableValue["type"];
	/** A disabled definition is listed but never wins. */
	enabled: boolean;
	/**
	 * The definition that actually resolves. Exactly one origin per name carries
	 * this, unless every definition is disabled, in which case none does.
	 *
	 * Explicit rather than "the last one", because precedence order and win order
	 * are not the same list once disabled definitions are included.
	 */
	winner: boolean;
}

/**
 * Extended variable info for autocomplete and quick view.
 */
export interface VariableInfo extends ResolvedVariable {
	name: string;
}

/**
 * Flat snapshot of the request + load-test parameters captured when a run
 * starts, persisted with the Run for history display. Known fields are typed;
 * the index signature permits additional engine-provided keys.
 */
export interface RunConfigSnapshot {
	url?: string;
	method?: string;
	mode?: string;
	duration?: string;
	targetRps?: number;
	concurrency?: number;
	iterations?: number;
	rampUpDuration?: string;
	startConcurrency?: number;
	comment?: string;
	/**
	 * Requested protocol the run executed with - `build_run_report_config` in
	 * `engine/src/http/routes/runs.cpp` normalizes an absent or explicit-`null`
	 * key to `"auto"` before this ever reaches the client, so it is always
	 * present in practice despite the optional `?`. Distinct from the
	 * *negotiated* protocol on a single exchange (`ResponseState.httpVersion`).
	 */
	httpVersion?: HttpVersion;
	[key: string]: unknown;
}

/**
 * How one step execution of a scenario run ended.
 *
 * `skipped` is a step the runner did not execute (flow control), and is never
 * a pass: it asserted nothing. The four exist from the first release of the
 * runner even though nothing produces `skipped` yet, so neither the wire shape
 * nor a summary that counts them has to widen later.
 */
export type StepOutcome = "passed" | "failed" | "skipped" | "errored";

/** The four outcomes as a value, in the order a run summary reads them. */
export const STEP_OUTCOMES: readonly StepOutcome[] = [
	"passed",
	"failed",
	"skipped",
	"errored",
] as const;

/**
 * One step execution as the live stream reports it - the `step` SSE event on
 * `GET /runs/:runId/live`, built by `build_step_payload`
 * (engine/src/core/scenario_runner.cpp). It carries no exchange: the stored
 * `results` row is what the response pane restores from once the run ends.
 */
export interface ScenarioStepEvent {
	/** 0-based pass over the plan. */
	iteration: number;
	/** 0-based position within the plan, stable for the run. */
	stepIndex: number;
	/** `requests.name` - the step's label, and the `setNextRequest` target. */
	name: string;
	outcome: StepOutcome;
	/** `0` when the step never reached a server. */
	statusCode: number;
	latencyMs: number;
	/**
	 * Which `data` row this iteration bound, absent for a run without a data
	 * set - on the same terms as the stored row's, so a step reads the same
	 * live and after a reload.
	 */
	dataRowIndex?: number;
	/**
	 * What the contract says about this step's response (issue #681), the same
	 * object the stored trace carries - so a step watched live and the same step
	 * read back from the report show one verdict, not two derivations of it.
	 *
	 * Absent for a step of an unbound collection and for one that sent nothing:
	 * a response nobody made was not judged against a contract.
	 */
	validation?: ResponseValidation;
}

/**
 * Why a streaming run's event stream ended (issue #573).
 *
 * Every stream ends by a rule that can name itself - the engine never reports
 * "the timeout happened to fire" - and the same six words reach the relay's
 * `complete` frame and the stored trace. `"completed"` is the only one that
 * means the *server* closed the stream; the rest are bounds this side applied,
 * which is why the Events tab says which one fired rather than just stopping.
 */
export type StreamEndReason =
	| "completed"
	| "stopped"
	| "maxStreamEvents"
	| "maxStreamDurationMs"
	| "idleTimeout"
	| "error";

/** Every {@link StreamEndReason}, for exhaustiveness checks and narrowing. */
export const STREAM_END_REASONS: readonly StreamEndReason[] = [
	"completed",
	"stopped",
	"maxStreamEvents",
	"maxStreamDurationMs",
	"idleTimeout",
	"error",
] as const;

/**
 * One event from a `text/event-stream` upstream, as both the live relay
 * (`GET /runs/:id/events`, `event: message`) and the stored trace carry it.
 *
 * `sourceId` is the **origin's** own `id:` field, not the relay frame id the
 * `lastEventId` resume takes - conflating the two would make one of the two
 * resumes silently wrong (see `docs/engine/api-reference.md`). An event larger
 * than `sseMaxEventBytes` arrives as a prefix with `dataTruncated` set and
 * `dataBytes` holding the size as sent, never silently cut.
 */
export interface StreamEvent {
	/** The origin's `event:` name, or `"message"` when it sent none. */
	event: string;
	/** The `data:` lines, joined with `\n`. */
	data: string;
	sourceId?: string;
	/** Engine-side arrival time, Unix ms. */
	receivedAt?: number;
	dataTruncated?: boolean;
	dataBytes?: number;
}

/**
 * The relay's `open` frame: what the stream connected to, published once as
 * soon as the response's header block arrives so even a late consumer learns
 * it.
 */
export interface StreamOpen {
	statusCode: number;
	statusText: string;
	headers: Record<string, string>;
}

/** The relay's `complete` frame, which closes every stream. */
export interface StreamComplete {
	runId: string;
	reason: StreamEndReason;
	/** Every event received, whatever was retained. */
	totalEvents: number;
}

/**
 * The `events` node a **streaming** design run adds to its stored trace - the
 * only node the other trace writers never carry.
 *
 * `eventsTruncated` is the engine's own comparison of `totalEvents` against
 * what it stored, not something derived here from a cap the reader would have
 * to know: a stream that ended under the cap and one whose tail was dropped
 * must stay distinguishable long after the cap has been changed.
 */
export interface RunResultStreamEvents {
	items: StreamEvent[];
	totalEvents: number;
	eventsTruncated: boolean;
	endReason: StreamEndReason;
}

/**
 * The `scripts` node a **streaming** design run adds to its stored trace
 * (issue #575) - the pre- and post-request scripts' output, keyed exactly as
 * the live `/execute` response body keys it.
 *
 * Every field is optional for the reason the engine builder makes it so: a key
 * is written only when it has something to say, so a run whose script logged
 * nothing and asserted nothing stores an absent node rather than three empty
 * lists.
 */
export interface RunResultScripts {
	testResults?: TestResult[];
	consoleLogs?: ConsoleLogEntry[];
	preScriptError?: string;
	postScriptError?: string;
}

/**
 * One HTTP exchange's trace, as the engine stores it. A design-mode trace
 * (`POST /request` -> `store_result`, execution.cpp) nests the request and
 * response; a load-test trace flattens timing and status onto the object
 * directly. Both writers omit fields freely, so everything here is optional.
 * Named once and shared by {@link RunResult} and {@link RunReport} rather
 * than declared inline in both places.
 */
export interface RunResultTrace {
	totalMs?: number;
	/** libcurl's transfer time; `queueWaitMs` is generator-side overhead. Both
	 * writers store them now, but rows persisted by older engines lack them. */
	wireMs?: number;
	queueWaitMs?: number;
	dnsMs?: number;
	connectMs?: number;
	tlsMs?: number;
	firstByteMs?: number;
	downloadMs?: number;
	isSlow?: boolean;
	thresholdMs?: number;
	request_number?: number;
	error_code?: number;
	/** `to_string(ErrorCode)` - the same words a live `errorCode` uses. */
	error_type?: string;
	/** The load-test writer's failure text (`load_strategy.cpp`). */
	message?: string;
	/** The design-mode writer's failure text (`store_result`, execution.cpp). */
	error_message?: string;
	/**
	 * Per-test validation failures from a load run's `validate_scripts`
	 * (`run_manager.cpp`), stored on the summary result row's trace. Each entry
	 * is a `"<test name>: <assertion>"` line (or a `Script error:` / `Exception:`
	 * line when the whole script threw). Written by the engine but rendered
	 * nowhere before issue #111.
	 */
	failures?: string[];
	totalFailed?: number;
	totalPassed?: number;
	headers?: Record<string, string>;
	body?: string;
	// Design-mode traces (`POST /request`) nest the exchange instead of
	// flattening it - see `store_result` in engine/src/http/routes/execution.cpp.
	request?: {
		method?: string;
		url?: string;
		headers?: Record<string, string>;
		body?: string;
		/** Set by `store_result` when the request body exceeded `maxTraceBodyBytes`. */
		bodyTruncated?: boolean;
		/** The request body's original byte length, present only when truncated. */
		bodyBytes?: number;
		/**
		 * The wire message the transfer actually sent - `build_result_trace`'s
		 * copy of the live response's `rawRequest` (issue #348), stored so a
		 * restored raw view shows the `Cookie` line the jar attached instead of
		 * rebuilding a session-less request from `headers`. Absent on rows
		 * written before that change and on a step that sent nothing, which is
		 * why `restore-response.ts`'s `sentSide` keeps `buildRawRequest` as its
		 * fallback. Values are **not redacted** - same contract as the live
		 * field (see `docs/engine/api-reference.md`).
		 *
		 * Its body half is capped at `maxTraceBodyBytes` like `body` is; the
		 * header block is never cut.
		 */
		rawRequest?: string;
		/**
		 * What the transfer actually issued - `build_result_trace`'s copy of the
		 * live response's `requestHeaders` (issue #664), which is `headers`
		 * minus the suppressed and value-less entries plus the two the engine
		 * derives at send time (the body-implied `Content-Type`, the default
		 * `User-Agent`).
		 *
		 * This is the map the response pane's "sent" disclosure means;
		 * `headers` beside it is the *composed* request and stays because
		 * `design-run-seed.ts` reseeds a request tab from it. Absent on rows
		 * written before the field and on a step that sent nothing, which is
		 * why `restore-response.ts`'s `sentSide` keeps `headers` as its
		 * fallback. Values are **not redacted** - same contract as
		 * `rawRequest`.
		 */
		sentHeaders?: Record<string, string>;
	};
	response?: {
		headers?: Record<string, string>;
		body?: unknown;
		/** Set by `store_result` when the response body exceeded `maxTraceBodyBytes`. */
		bodyTruncated?: boolean;
		/** The response body's original byte length, present only when truncated. */
		bodyBytes?: number;
		/**
		 * The protocol negotiated for this exchange, as stored by
		 * `build_result_trace` (`engine/src/http/routes/execution.cpp`) - same
		 * display-string value space as `ResponseState.httpVersion`
		 * (`app/src/modules/request-builder/types.ts`), not the request-side
		 * `HttpVersion` union. Read by `restore-response.ts`'s `sentSide` (onto
		 * the rebuilt raw request line) and `responseFromRunResult` (onto
		 * `ResponseState.httpVersion`, for the Raw tab's status line).
		 */
		httpVersion?: string;
		/**
		 * This exchange asked for HTTP/2 and negotiated something older - see
		 * {@link HttpResponse.httpVersionDowngraded}. Absent on a trace stored
		 * by an engine older than 0.15.0, which is why it is optional rather
		 * than defaulted to `false` at the type level.
		 */
		httpVersionDowngraded?: boolean;
	};
	/**
	 * Present on a **streaming** design run's trace only (issue #573), which is
	 * why it is optional here rather than on a stream-specific trace type: one
	 * `results` row shape serves every writer. Read by `restore-response.ts`,
	 * so reopening a finished stream from History shows its timeline again.
	 */
	events?: RunResultStreamEvents;
	/**
	 * What a design run's scripts produced (issue #575), under the same four key
	 * names the live `/execute` body uses - one engine object
	 * (`build_script_result_node`) fills both, so a restored Tests pane and a
	 * live one cannot disagree about what a failed assertion looks like.
	 *
	 * A streaming send has no alternative: it is answered `202` before its
	 * post-request script has run, so the trace is the only route its results
	 * take. A buffered send *also* stores the object it returns (issue #725) -
	 * before that it stored none of them, and a restored ordinary send showed
	 * the same empty Tests pane whether its assertions had passed or never run.
	 *
	 * Absent means the send ran no scripts, or predates #725 - never that
	 * nothing passed.
	 */
	scripts?: RunResultScripts;
	/**
	 * What checking this response against its declared schema found (issue
	 * #628), stored **verbatim** as the live `/execute` body carried it - one
	 * engine builder (`build_validation_payload`) fills both, so a restored
	 * verdict and a live one cannot disagree.
	 *
	 * Absent for a request whose collection binds no document, and for a
	 * streaming run: an event stream is not a document any response schema
	 * describes.
	 */
	validation?: ResponseValidation;
	/*
	 * Step identity, stamped onto a scenario run's per-step trace by
	 * `stamp_step_identity` (engine/src/core/scenario_runner.cpp) and read by
	 * `scenario-steps.ts` to say which step a stored row belongs to. Only a
	 * scenario run's rows carry them, which is why a row missing `stepIndex` is
	 * skipped by the step list rather than shown as step 0.
	 */
	/** 0-based pass over the plan. */
	iteration?: number;
	/** 0-based position within the plan, stable for the run. */
	stepIndex?: number;
	/** `requests.name` at plan time - the `setNextRequest` target. */
	stepName?: string;
	/** The stored request this step came from. */
	requestId?: string;
	outcome?: StepOutcome;
	/**
	 * Which `data` row this iteration bound, absent for a run without a data
	 * set. Present so the wrap is visible: with `iterations` above the row
	 * count, iteration 4 of a 3-row set reads row 1, and the iteration number
	 * alone cannot say that.
	 *
	 * A scenario **load** run writes it too (issue #449), on every retained
	 * result, and there it is the *only* record of the row: that executor stores
	 * no per-step `results` rows, so without it a failure is attributable to a
	 * step but never to a row. It arrives on a flat load trace rather than
	 * beside the `stepIndex` keys above, which is why it sits outside them.
	 */
	dataRowIndex?: number;
}

/**
 * The single exchange for a design run, attached by `GET /runs/:id` -
 * `attach_design_result` in engine/src/utils/json.cpp. Design runs only: a
 * design run has exactly one result, so the engine embeds it on the run
 * itself instead of requiring a second `/results` fetch.
 */
export interface RunResult {
	timestamp: number;
	statusCode: number;
	statusText: string;
	latencyMs: number;
	error?: string;
	trace?: RunResultTrace;
}

/**
 * What a collection run's list row says about the sequence that ran, from the
 * snapshot's scenario manifest (`add_scenario`,
 * `engine/src/http/routes/runs.cpp`). Present on `type: "scenario"` rows only -
 * its presence is what tells a row it is a collection run without a second
 * fetch.
 *
 * `stepCount` and not the manifest's `steps` array: the array carries a name, a
 * method and a URL per step, and shipping it on every list row would undo the
 * reason the compact summary exists. The array stays on `GET /runs/:id`, which
 * is what the run tab's context bar reads.
 */
export interface RunScenarioSummary {
	/** The collection that ran. The name is resolved app-side, from the tree. */
	collectionId?: string;
	/** Passes over the plan. */
	iterations?: number;
	/** Whether sub-collections were included. */
	recursive?: boolean;
	/** Steps in one pass - the plan's length, not the executions. */
	stepCount?: number;
}

/**
 * The compact per-row summary the paginated `GET /runs` list carries in place
 * of the full {@link RunConfigSnapshot}. Mirrors all ten keys
 * `build_run_summary` sends (`engine/src/http/routes/runs.cpp`); each is
 * omitted by the engine when absent from the stored snapshot, except
 * `httpVersion` which the engine always normalizes to a value (see
 * `add_http_version`, same file). The full snapshot is still available on
 * `GET /runs/:id`.
 *
 * `followRedirects` / `maxRedirects` are declared but **not rendered
 * anywhere yet** - this type mirrors the wire, so a field the engine sends is
 * declared whether or not a screen reads it, and a reader can trust that what
 * is missing here is missing from the payload too. If you are looking for
 * somewhere to surface them, the history sidebar row and the load test report
 * both already show `httpVersion` and would be the consistent home.
 */
export interface RunSummary {
	url?: string;
	method?: string;
	mode?: string;
	duration?: string;
	concurrency?: number;
	comment?: string;
	/** Requested protocol - see {@link RunConfigSnapshot.httpVersion}. */
	httpVersion?: HttpVersion;
	/** Sent by the engine, not yet rendered - see the note above. */
	followRedirects?: boolean;
	/** Sent by the engine, not yet rendered - see the note above. */
	maxRedirects?: number;
	/**
	 * A collection run's sequence, and nothing else's - see
	 * {@link RunScenarioSummary}. Read by the history row, which has no `url` to
	 * show for one.
	 */
	scenario?: RunScenarioSummary;
}

export interface Run {
	id: string;
	/**
	 * `scenario` is a collection run - one row per step. Its tab is
	 * `ScenarioRunView` (the step list), not the load-test report: a scenario
	 * run's `results[]` are step executions, so the load report's percentiles
	 * would describe a sequence as if it were one request repeated. The sidebar
	 * row is still the non-load shape, which `RunItem.run-types.test.tsx` pins.
	 */
	type: "load" | "design" | "scenario";
	status: "pending" | "running" | "completed" | "stopped" | "failed";
	startTime: number; // Unix timestamp in ms
	endTime: number;
	/**
	 * Present on list rows from the paginated `GET /runs`. The single-run
	 * `GET /runs/:id` returns {@link configSnapshot} instead.
	 */
	summary?: RunSummary;
	/** Full snapshot - present on `GET /runs/:id`, not on paginated list rows. */
	configSnapshot?: RunConfigSnapshot;
	requestId?: string | null;
	environmentId?: string | null;
	/** The exchange, present only for a design run once it has completed or failed. */
	result?: RunResult;
	/**
	 * What a **design run's** list row says about its exchange - see
	 * {@link RunResultSummary}. Never present on a load or collection run's row,
	 * and never on `GET /runs/:id`, which attaches the whole {@link result}.
	 */
	resultSummary?: RunResultSummary;
	/**
	 * Whether this run is pinned as a baseline - the known-good run later runs
	 * of the same request are measured against, and the one run the engine's
	 * retention never expires. Toggled through `PUT /runs/:id/baseline`.
	 *
	 * Optional because a run row from an engine older than this field has none;
	 * absent reads the same as `false` everywhere.
	 */
	baseline?: boolean;
}

/**
 * The outcome of a design run's single exchange, carried by its **list row**
 * from the paginated `GET /runs` (`get_runs_response`,
 * `engine/src/http/routes/runs.cpp`).
 *
 * Two numbers rather than the whole {@link RunResult}: that one carries the
 * exchange's `trace` - request and response bodies included - which is a
 * per-row cost a list cannot take. A row with no outcome recorded (a send still
 * in flight, or a result whose write failed) has **no `resultSummary` at all**,
 * which is not the same as `statusCode: 0` - the wire uses that for a request
 * that never reached a server.
 */
export interface RunResultSummary {
	statusCode: number;
	latencyMs: number;
}

/** The `{data, pagination}` envelope the paginated `GET /runs` returns. */
export interface RunListResponse {
	data: Run[];
	pagination: {
		total: number;
		limit: number;
		offset: number;
		hasMore: boolean;
		returned: number;
	};
}

/** Server-side filters for the paginated `GET /runs` list. */
export interface RunListParams {
	limit?: number;
	offset?: number;
	type?: Run["type"];
	status?: Run["status"];
	requestId?: string;
	/**
	 * Which collection's runs. Matched against a scenario run's stored
	 * `scenario.collectionId` as JSON, so only collection runs can match - a
	 * design or load run that merely mentions the id does not.
	 */
	collectionId?: string;
	q?: string;
	/**
	 * `true` lists only pinned baselines, `false` only unpinned runs. Unset
	 * lists both - so leave it unset rather than passing `false` to mean
	 * "either".
	 */
	baseline?: boolean;
}

/** Load-test execution strategy. Single source of truth for the mode union. */
export type LoadTestMode =
	| "constant_rps"
	| "constant_concurrency"
	| "iterations"
	| "ramp_up"
	| "capacity";

/**
 * Pass/fail budgets a run declares up front, so the engine can judge it rather
 * than only measure it. Keys are the engine's own metric names (they travel
 * verbatim on `POST /runs` and come back in `RunReport.thresholdValidation`),
 * which is why they are camelCase where the rest of `LoadTestConfig` is not.
 *
 * Every key is optional and at least one must be present - the engine rejects
 * an empty object rather than starting a run nothing will judge.
 */
export interface RunThresholds {
	latencyP50Ms?: number;
	latencyP95Ms?: number;
	latencyP99Ms?: number;
	/** Share of the run's requests allowed to fail, 0-100. */
	maxErrorRatePct?: number;
	minThroughputRps?: number;
}

/**
 * The server-vitals endpoint a run scrapes alongside its own metrics, so the
 * target's CPU or memory can be read on the same timeline as p99 and rps.
 *
 * Keys are the engine's own (`monitor` on `POST /runs`), which is why they are
 * camelCase where the rest of `LoadTestConfig` is not - the same reason
 * {@link RunThresholds} is. The engine rejects a block with no `series`, so the
 * whole object is omitted rather than sent empty when monitoring is off.
 */
export interface RunMonitorConfig {
	/** http(s) URL of a Prometheus `/metrics` or flat-JSON status endpoint. */
	url: string;
	/** Scrape cadence; the engine accepts 250-60000, defaulting to 1000. */
	intervalMs?: number;
	/** `prometheus` (text exposition) or `json` (flat object of numbers). */
	format?: "prometheus" | "json";
	/** Metric names to read out of the body - at least one, at most eight. */
	series: string[];
}

export interface LoadTestConfig {
	duration_seconds?: number;
	rps?: number;
	concurrency?: number;
	iterations?: number;
	mode: LoadTestMode;
	ramp_duration_seconds?: number;
	/** Ramp-Up only: connections at t=0, climbing to `concurrency`. */
	start_concurrency?: number;
	/**
	 * Sampling **period** for stored success traces - keep 1 in N, engine-side
	 * `counter % N`. Named for the unit on purpose: the dialog's control is a
	 * percentage, and the two used to be the same number, so the slider meant
	 * the inverse of its own label. `successSamplePeriod` does the conversion.
	 */
	success_sample_period?: number;
	slow_threshold_ms?: number;
	save_timing_breakdown?: boolean;
	comment?: string;
	latency_percentiles?: number[];
	max_in_flight?: number;
	/** Absent when the run declared no budgets - never an empty object. */
	thresholds?: RunThresholds;
	/** Absent when the run monitors no endpoint - never an empty object. */
	monitor?: RunMonitorConfig;
	/**
	 * Capacity only: the p99 budget the search looks for the edge of, in ms.
	 * Prefilled from the client-side `sloThresholdMs` setting, so the number
	 * the dashboard already annotates its charts with becomes the number the
	 * search is steered by rather than a second, unrelated one.
	 */
	slo_ms?: number;
	/** Capacity only: how long each concurrency level is held before it is judged. */
	step_duration_seconds?: number;
	/**
	 * Streaming runs only (issue #576): the wall-clock ceiling on one stream,
	 * in seconds, and the ceiling on the events it delivers.
	 *
	 * Both absent means "the engine's `sseMaxStreamDurationMs` /
	 * `sseMaxStreamEvents`", which is what a stream is bounded by when the
	 * dialog is left alone - never "unbounded". They are on the run rather than
	 * on the request because they describe how much of a stream *this run*
	 * measures, while whether the request streams at all is the request's own
	 * Settings-tab flag.
	 *
	 * Seconds here and milliseconds on the wire, like `duration_seconds`: the
	 * dialog's other duration is in seconds and two units in one form is how a
	 * user enters 600 meaning ten minutes and gets 0.6.
	 */
	stream_duration_seconds?: number;
	stream_max_events?: number;
}

/**
 * One scrape of a run's monitored endpoint, as `GET /runs/:id/monitor` returns
 * it and as the live `monitor` SSE frame carries it - one shape for both, so
 * the live overlay and the history overlay are drawn from identical rows.
 *
 * `timestamp` (Unix ms) rather than an elapsed offset is what the join onto the
 * run's own timeline uses: a tick's `elapsed_seconds` is measured from the
 * first *persisted* tick, while the scrape starts with the run.
 */
export interface MonitorSample {
	timestamp: number;
	/** Metric name -> value, for the names the run asked for. */
	series: Record<string, number>;
}

/**
 * Per-request timing breakdown (milliseconds), as `POST /execute` returns it
 * (`serialize(Response)`, engine/src/utils/json.cpp). Phase fields
 * (dns…download) are sequential segments of the request; `wireMs` is libcurl's
 * transfer time and `queueWaitMs` is generator-side overhead (total − wire).
 *
 * The field names are the engine's wire keys - the same `*Ms` convention the
 * stored trace ({@link RunResultTrace}) uses, so a live response and one
 * restored from a stored design run agree without renaming. `wireMs` /
 * `queueWaitMs` stay optional because traces stored by older engines omitted
 * them (current ones store all eight); consumers must treat both as optional.
 */
export interface ResponseTiming {
	totalMs: number;
	wireMs?: number;
	queueWaitMs?: number;
	dnsMs: number;
	connectMs: number;
	tlsMs: number;
	firstByteMs: number;
	downloadMs: number;
}

export interface HttpResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	requestHeaders?: Record<string, string>;
	rawRequest?: string;
	body: unknown;
	bodyRaw: string;
	bodySize: number;
	timing: ResponseTiming;
	errorCode?: string;
	errorMessage?: string;
	/**
	 * The protocol negotiated for this exchange, as `serialize(Response)`
	 * (`engine/src/utils/json.cpp`) emits it on `POST /execute` - `""` when
	 * nothing was negotiated, not omitted. Same display-string value space as
	 * `ResponseState.httpVersion` (`app/src/modules/request-builder/types.ts`),
	 * not the request-side `HttpVersion` union - do not unify the two.
	 */
	httpVersion?: string;
	/**
	 * The request asked for `http2` and the connection negotiated something
	 * older. Computed engine-side (`http_version_downgraded`,
	 * `engine/include/vayu/http/curl_version_map.hpp`) because only the engine
	 * holds both halves at once - `httpVersion` above is the outcome, and the
	 * outcome only becomes a complaint next to what was requested.
	 *
	 * Do not re-derive it here from the tab's `httpVersion` setting: a replay
	 * or a restored response is shown beside request state that may since have
	 * changed, and the answer belongs to the exchange, not to the editor.
	 */
	httpVersionDowngraded?: boolean;
}

export interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
}

/** Which `console.*` method a script line came from. Engine spellings. */
export type ConsoleLevel = "log" | "info" | "warn" | "error";

/** Which of a request's two scripts wrote a line. */
export type ConsoleLogSource = "pre" | "test";

/**
 * One line of script console output.
 *
 * The engine used to send a bare string and encode the source as a `"[pre] "`
 * text prefix, which was indistinguishable from a script that logged a line
 * starting with those characters - and carried no level at all, so the Console
 * tab drew `console.error` exactly like `console.log`. Both are fields now.
 */
export interface ConsoleLogEntry {
	source: ConsoleLogSource;
	level: ConsoleLevel;
	message: string;
}

export interface SanityResult extends HttpResponse {
	requestId?: string;
	testResults?: TestResult[];
	/**
	 * A `string` is the pre-structured shape, kept in the type so the fallback in
	 * `parse-logs.ts` is visible rather than a cast. A renderer can meet one when
	 * it is talking to an older engine sidecar.
	 */
	consoleLogs?: Array<ConsoleLogEntry | string>;
	preScriptError?: string;
	postScriptError?: string;
	error?: string;
	/**
	 * What checking this response against its declared schema found (issue
	 * #628). Absent when the request's collection binds no OpenAPI document -
	 * the engine writes no node at all rather than an unchecked verdict, so
	 * "never judged against a contract" stays distinguishable from "checked and
	 * could not be read".
	 */
	validation?: ResponseValidation;
}

export interface LoadTestMetrics {
	timestamp: number;
	elapsed_seconds: number;
	requests_completed: number;
	requests_failed: number;
	current_rps: number;
	current_concurrency: number;
	latency_p50_ms: number;
	latency_p95_ms: number;
	latency_p99_ms: number;
	avg_latency_ms: number;
	bytes_sent: number;
	bytes_received: number;
	send_rate?: number;
	throughput?: number;
	backpressure?: number;
	dropped_requests?: number;
	avg_queue_wait_ms?: number;
	// Run progress - feeds the iterations-mode ETA stat. requests_expected is 0
	// for open-ended modes (constant_rps), in which case ETA is not shown.
	requests_sent?: number;
	requests_expected?: number;
	// Per-tick full status-code map (e.g. { "200": 1450, "404": 5 }). Same shape
	// the live SSE and the stored time-series both carry.
	status_codes?: Record<string, number>;
}

/**
 * One plan step's numbers in a scenario load run's report, from the summary's
 * `scenario.steps` array (`build_step_breakdown`,
 * `engine/src/core/scenario_load.cpp`).
 *
 * Carries the step's identity beside its latency because a breakdown indexed
 * only by position is unreadable next to a forty-step sequence.
 */
export interface RunScenarioStepStat {
	/** Position in the plan, 0-based and stable for the run. */
	index: number;
	/** `requests.name` - what the sequence calls this step. */
	name: string;
	requestId: string;
	method: string;
	/** Step executions across every virtual user and iteration. */
	executed: number;
	/**
	 * Of those, the ones that errored. An errored step ends its iteration, so a
	 * non-zero count here is also why the steps after it ran fewer times.
	 */
	errors: number;
	latency: {
		min: number;
		p50: number;
		p95: number;
		p99: number;
		max: number;
	};
	/**
	 * What this step's own post-request script found, replayed after the run
	 * against the responses *this step* produced (issue #450).
	 *
	 * `undefined` is a step that asserted nothing, or one whose script never got
	 * a sampled response to run against - deliberately not the same claim as
	 * "zero assertions failed", which is why the engine omits the object rather
	 * than writing zeros.
	 */
	tests?: {
		/** Sampled responses the script was replayed against. */
		sampled: number;
		passed: number;
		failed: number;
	};
}

export interface RunReport {
	metadata?: {
		runId: string;
		runType: string;
		status: string;
		startTime: number;
		endTime: number;
		requestUrl?: string;
		requestMethod?: string;
		configuration?: {
			mode?: string;
			duration?: string;
			targetRps?: number;
			concurrency?: number;
			startConcurrency?: number;
			rampUpDuration?: string;
			timeout?: number;
			comment?: string;
			/**
			 * Requested protocol - see {@link RunConfigSnapshot.httpVersion}. Built by
			 * `build_run_report_config` (`engine/src/http/routes/runs.cpp`), which
			 * always normalizes it to a value via `add_http_version`, so this is
			 * effectively always present despite the optional `?` - kept loosely
			 * typed as `string` (not `HttpVersion`) like its siblings above, since
			 * nothing here is runtime-validated; narrow with `isHttpVersion` before
			 * using it as a value.
			 */
			httpVersion?: string;
			/** Sent by the engine since 0.11.0; not rendered anywhere yet. */
			followRedirects?: boolean;
			/** Sent by the engine since 0.11.0; not rendered anywhere yet. */
			maxRedirects?: number;
		};
		/**
		 * The document this run was measured against (issue #637), echoed from
		 * the snapshot its plan stamped - not what the collection binds today.
		 *
		 * Absent for a run of an unbound collection, and for a single-request
		 * run: a run nobody measured against a contract is not a run measured
		 * against nothing.
		 */
		openapi?: {
			specId: string;
			specHash: string;
			/**
			 * Whether the binding came from an **ancestor** of the collection
			 * this run named (issue #716).
			 *
			 * An OpenAPI import binds the root and files every request under tag
			 * sub-collections, so running one tag folder is measured against the
			 * whole document - most of its operations honestly uncovered. Absent
			 * means the run's own collection carries the binding and there is
			 * nothing to disclose; {@link RunReport.coverage}'s block is the
			 * reader, and prints one line when it is set.
			 */
			inherited?: boolean;
		};
	};
	summary: {
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		errorRate: number;
		totalDurationSeconds: number;
		avgRps: number;
		sendRate?: number;
		throughput?: number;
		backpressure?: number;
		testDuration?: number;
		setupOverhead?: number;
		peakConcurrency?: number;
		droppedRequests?: number;
		avgQueueWaitMs?: number;
		bytesSent?: number;
		bytesReceived?: number;
		throughputBytesPerSec?: number;
		/**
		 * How many of the run's transfers asked for HTTP/2 and negotiated
		 * something older. The only figure in `summary` that is about the
		 * report's validity rather than its performance: non-zero means the
		 * latency and throughput above were measured over a protocol other than
		 * the one `metadata.configuration.httpVersion` names, which is exactly
		 * the mislabelling issue #215 describes.
		 *
		 * `0` is "none recorded", not "none happened" - an engine from 0.15.0
		 * always emits the key, including for a run whose stored summary
		 * predates the count and for one reported from its sampled results
		 * because that summary was malformed or never written, neither of which
		 * can produce a figure. `undefined` therefore only means the sidecar
		 * itself is older than 0.15.0, and reads the same way as 0 here: no
		 * warning. Weaker than the per-response `httpVersionDowngraded` above,
		 * which is exact for its exchange.
		 */
		httpVersionDowngraded?: number;
	};
	latency: {
		min: number;
		max: number;
		avg: number;
		median?: number;
		p50: number;
		p75?: number;
		p90: number;
		p95: number;
		p99: number;
		p999?: number;
	};
	statusCodes: Record<string, number>;
	errors: {
		total: number;
		withDetails: number;
		types: Record<string, number>;
		byStatusCode?: Record<string, number>;
	};
	rateControl?: {
		targetRps: number;
		actualRps: number;
		achievement: number;
	};
	/**
	 * Two independent halves, either of which can be present without the other.
	 *
	 * The `avg*` fields are means over the run's **retained trace sample** (the
	 * 1-in-N successes `save_timing_breakdown` stores, plus any slow-request
	 * outliers), so they are absent for a run that stored no traces. `phases`
	 * comes from histograms fed by **every** completion, so it is present for
	 * such a run and absent only when the engine's `phaseHistograms` setting was
	 * off, nothing succeeded, or the run predates the bank.
	 *
	 * Read each half by its own key. Treating the object's presence as proof of
	 * either is what makes a phases-only report render as five zeroed averages.
	 */
	timingBreakdown?: {
		avgDnsMs?: number;
		avgConnectMs?: number;
		avgTlsMs?: number;
		avgFirstByteMs?: number;
		avgDownloadMs?: number;
		/**
		 * Whole-run percentiles per network phase, over every completion rather
		 * than over the trace sample. `count` is how many completions each
		 * distribution holds - identical across the five, since they are fed
		 * together.
		 */
		phases?: Partial<
			Record<
				"dns" | "connect" | "tls" | "firstByte" | "download",
				{ p50: number; p95: number; p99: number; max: number; count: number }
			>
		>;
	};
	slowRequests?: {
		count: number;
		thresholdMs: number;
		percentage: number;
	};
	/**
	 * What a streaming run's completions delivered (issue #576).
	 *
	 * `undefined` is a run that did not stream - not a stream that delivered
	 * nothing - so a report without it renders exactly as it did before SSE
	 * under load existed. That distinction is why the engine omits the section
	 * rather than writing zeros.
	 *
	 * `events` is the **per-completion** distribution: 500 streams of ~40
	 * events each have a p50 near 40, not near 20000. `eventsPerSecond` is the
	 * whole-run rate, derived engine-side from the same clock `rps` uses so the
	 * two are comparable. Both are reported because they answer different
	 * questions - one long stream and 250 short ones can share a rate.
	 *
	 * `capped` counts the completions a cap ended rather than the server. All
	 * of them means the run measured its own bounds, not the target: the
	 * dashboard says so rather than leaving it to be inferred.
	 *
	 * Time-to-first-event needs no field here: it **is** `phases.firstByte` in
	 * {@link timingBreakdown}, since the first byte of a stream is its first
	 * event's first byte. A second copy would be a second number to keep true.
	 */
	stream?: {
		completions: number;
		totalEvents: number;
		capped: number;
		eventsPerSecond: number;
		events: {
			min: number;
			max: number;
			p50: number;
			p90: number;
			p95: number;
			p99: number;
			count: number;
		};
	};
	testValidation?: {
		samplesTested: number;
		testsPassed: number;
		testsFailed: number;
		successRate: number;
	};
	/**
	 * What the run's server-vitals scrape recorded ({@link RunMonitorConfig}).
	 *
	 * `undefined` is a run that monitored nothing - not a target that reported
	 * zeros - so a report without it renders exactly as it did before the
	 * monitor existed. `samples` is what the history view gates its
	 * `GET /runs/:id/monitor` fetch on: a run whose every scrape failed has a
	 * section, a `failures` count, and no series to draw.
	 */
	monitor?: {
		samples: number;
		failures: number;
		series: Record<string, { min: number; max: number; avg: number; count: number }>;
	};
	/**
	 * The run's verdict against the budgets it declared ({@link RunThresholds}).
	 *
	 * The aggregate half of pass/fail: `testValidation` replays a script against
	 * individual responses and structurally cannot assert a p99 or an error
	 * rate, so a run that meets every assertion can still miss its budget.
	 *
	 * `undefined` is a run that declared no budgets - which is *not* the same
	 * claim as "passed nothing", so a report without it renders exactly as it
	 * did before budgets existed. `metric` is typed loosely on purpose: it is
	 * the engine's key, and a newer sidecar may judge a metric this build has
	 * no label for.
	 */
	thresholdValidation?: {
		checks: {
			metric: string;
			limit: number;
			actual: number;
			passed: boolean;
		}[];
		passed: number;
		failed: number;
		verdict: "passed" | "failed";
	};
	/**
	 * Which operations of the collection's bound contract this run exercised, and
	 * which of their declared responses it saw (issue #629).
	 *
	 * **Absent, never zeros**, for every run that was not measured against a
	 * contract - an unbound collection, a single-request run, or a document
	 * stored before the operation index existed. A run that was never judged
	 * against a contract did not cover none of it.
	 *
	 * Computed against the document `metadata.openapi` names - the one the run
	 * was *planned* with - so a binding that has since synced to a newer spec
	 * cannot rewrite what an old report says was covered.
	 *
	 * Every number here is **exact**: the engine counts each send and each
	 * response as it happens, rather than deriving them from the bounded
	 * `results[]` sample a load run stores.
	 */
	coverage?: RunCoverage;
	/**
	 * Whether what came back matched the schemas the run's bound document
	 * declares (issues #682, #681).
	 *
	 * **Absent, never zeros**, for every run that checked nothing - an unbound
	 * collection, a single-request run, a document carrying no response schemas.
	 * A run whose responses were never checked did not pass a contract.
	 *
	 * Beside {@link RunReport.coverage} and computed against the same document -
	 * the one the run was *planned* with, read when its plan resolved, so a sync
	 * landing mid-run cannot change what the run was measured against.
	 *
	 * **What the numbers describe differs by run mode, and `exact` says which.**
	 * A load run defers the check to run end over its bounded reservoirs, because
	 * the load loop refills concurrency per completion and a schema walk there
	 * would cost throughput - so its figures are sampled, and anything rendering
	 * them has to say so. A collection run checks every step it executed.
	 */
	schemaValidation?: RunSchemaValidation;
	/**
	 * Whether the run's OAuth 2.0 credential was renewed while it ran.
	 *
	 * A run longer than its access token used to turn into a 401 storm the
	 * report never explained; the engine now refreshes header-placed tokens
	 * mid-run and records each swap here. `refreshFailures` with a `lastError`
	 * is the other half of that answer: the run kept going with the credential
	 * it had, so the 401s in `statusCodes` are explained by this, not by the
	 * target.
	 *
	 * `undefined` is a run that could not refresh at all - no OAuth 2.0 auth, a
	 * non-expiring or query-placed token, the user's `autoRefreshToken`
	 * opt-out, or a sidecar older than mid-run refresh - which is *not* the
	 * same claim as "watched and never needed to".
	 */
	auth?: {
		/** Seconds into the run at which each successful refresh landed. */
		refreshes: { atSeconds: number }[];
		refreshFailures: number;
		lastError?: string;
	};
	/**
	 * What a capacity run's adaptive search found: the highest concurrency the
	 * service held inside its latency budget, the level it gave out at, and the
	 * per-level audit trail behind both.
	 *
	 * `undefined` for every other mode - a fixed-target run measured a point,
	 * not a curve, so there is no knee to show. `maxHealthy*` is absent when the
	 * very first level already breached (the search found no sustainable
	 * capacity) and `knee*` when the search ended for a reason other than
	 * latency, so neither can be read as a measured zero. `stopReason` is typed
	 * loosely for the same reason `thresholdValidation.metric` is: a newer
	 * sidecar may stop for a reason this build has no words for.
	 */
	capacity?: {
		sloMs: number;
		stopReason: string;
		maxHealthyConcurrency?: number;
		maxHealthyRps?: number;
		p99AtMaxHealthyMs?: number;
		kneeConcurrency?: number;
		kneeP99Ms?: number;
		levels: { concurrency: number; rps: number; p99Ms: number }[];
	};
	/**
	 * How many records each of the run's bounded stores thinned away.
	 *
	 * Every store the engine keeps is capped, so a long run retains a *sample*
	 * rather than the whole set - and past the cap a later record displaces a
	 * uniformly chosen incumbent (reservoir retention), so what survives
	 * describes the whole run rather than its opening. These counts are what
	 * make that visible: all zeros means `results` and the tested responses are
	 * complete, non-zero means they are a sample of a larger set.
	 *
	 * `undefined` is a run whose stored summary predates the counts (or an older
	 * sidecar), which is *not* the same claim as "nothing was dropped" - so the
	 * UI stays silent rather than asserting completeness it cannot verify.
	 */
	sampling?: {
		errorsDropped: number;
		/** Sampled timing traces displaced or dropped (`max_success_results`). */
		successTracesDropped: number;
		/** Slow-request traces displaced or dropped (`max_slow_results`). */
		slowTracesDropped: number;
		/** Responses displaced or dropped before test validation ran. */
		responseSamplesDropped: number;
		/**
		 * Per-status exemplars refused because the exemplar store was full
		 * (`max_exemplar_results`). Only a target answering with more distinct
		 * status codes than that limit can produce a non-zero figure.
		 */
		exemplarsDropped?: number;
		/**
		 * Samples whose response body was dropped once the run's capture budget
		 * (`maxSampleBytes`) was spent. Their headers and metadata were still
		 * captured, so the sample exists and only its body is missing.
		 */
		sampleBodiesDropped?: number;
		/**
		 * Captured exchanges this run stored. Non-zero is the run's own record
		 * that it holds response headers and bodies **verbatim** - capture does
		 * not redact, by design - which is what the Samples tab warns on rather
		 * than leaving the reader to infer it. Absent on runs recorded before
		 * capture existed.
		 */
		responseBodiesCaptured?: number;
	};
	/**
	 * What the sequence did, present only on a scenario run's report (the engine
	 * leaves the section out entirely for the other two types, rather than
	 * showing a load run four zeros).
	 *
	 * `stepsStored` against `stepsExecuted` is the honest reading of `results[]`:
	 * a run that filled `maxScenarioStoredSteps` reports fewer rows than it ran,
	 * with every non-passing step among the ones kept - so a non-zero
	 * `stepsDropped` means successes are missing, never a failure.
	 */
	scenario?: {
		/** Iterations the run was asked for. */
		iterations: number;
		/** Iterations that finished - fewer when the run was stopped or errored. */
		iterationsCompleted: number;
		/** Step executions the run performed, whether or not their rows survived. */
		stepsExecuted: number;
		passed: number;
		failed: number;
		skipped: number;
		errored: number;
		/** Step rows the run kept - the length `results[]` should have. */
		stepsStored: number;
		stepsDropped: number;
		/**
		 * Load-mode only (issue #357): what `concurrency` meant for this run.
		 * A scenario load run's `concurrency` is its number of virtual users,
		 * each walking the plan on its own with its own cookies.
		 *
		 * Its presence is what separates a scenario *load* run's report from a
		 * design-mode collection run's - the latter has no VUs and no
		 * breakdown, and reports its steps as `results[]` rows instead.
		 */
		virtualUsers?: number;
		/**
		 * Iterations an errored step ended before the plan's last step. Counted
		 * apart from `iterationsCompleted` because it is what explains a
		 * breakdown that thins towards the end of the sequence.
		 */
		iterationsAbandoned?: number;
		/**
		 * Per-step latency and counts, in plan order. Load-mode only: a
		 * scenario load run stores no per-step `results` rows (it would be one
		 * row per step per iteration per VU), so this breakdown *is* how it
		 * says what each step did.
		 */
		steps?: RunScenarioStepStat[];
	};
	results?: Array<{
		/**
		 * The `results` row id, and the join key against
		 * {@link RunSample.resultId} from `GET /runs/:id/samples`. Absent on
		 * reports from engines older than 0.15.0.
		 */
		id?: number;
		timestamp: number;
		statusCode: number;
		statusText?: string;
		latencyMs: number;
		error?: string;
		trace?: RunResultTrace;
	}>;
}

/**
 * One sampled load-run result's captured response, from
 * `GET /runs/:id/samples`.
 *
 * Deliberately not part of {@link RunReport}: the report path loads and parses
 * every result row for a run on each fetch and the dashboard polls it, so
 * bodies travel on their own endpoint and are fetched only when a reader
 * expands a sample. Join to a report row by `resultId`.
 */
export interface RunSample {
	resultId: number;
	response: {
		headers: Record<string, string>;
		/**
		 * The stored body. Absent when {@link RunSample.response.binary} is set -
		 * a body that is not text is reported as its shape, never as a string
		 * that reads like a response and is not one.
		 */
		body?: string;
		/** Size of the body as received, before any truncation. */
		bodyBytes: number;
		/** `body` is a prefix; the response was larger than `maxSampleBodyBytes`. */
		bodyTruncated?: boolean;
		/** The run's capture budget was spent before this sample, so only its
		 * headers were kept. Distinct from an empty response body. */
		bodyDropped?: boolean;
		/** Stored as a descriptor: size and content type, no bytes. */
		binary?: boolean;
		contentType?: string;
		/**
		 * What this sample's stream delivered, when the sampled transfer was a
		 * stream (issue #657). The engine parses it back out of the stored body
		 * with the same parser the live path feeds, so the list means exactly
		 * what the design-mode Events tab's list means.
		 *
		 * Absent - not an empty node - for every sample that did not stream, and
		 * for rows stored before the engine recorded a wire event count.
		 * `totalEvents` is that wire count, so it stays truthful when
		 * `bodyTruncated` cut the bytes the items were parsed from;
		 * `eventsTruncated` covers both that cut and the `sseMaxStoredEvents`
		 * cap. No `endReason`: under load a stream ends by server close or by
		 * one of two caps, and nothing per sample says which.
		 */
		events?: Omit<RunResultStreamEvents, "endReason">;
	};
}

export interface RunSamplesResponse {
	data: RunSample[];
	pagination: {
		total: number;
		limit: number;
		offset: number;
		hasMore: boolean;
		returned: number;
	};
}

export interface EngineHealth {
	status: "ok";
	version: string;
	uptime_seconds: number;
}

export interface EngineConfig {
	max_concurrency: number;
	default_timeout_ms: number;
	follow_redirects: boolean;
	verify_ssl: boolean;
}

export interface ConfigEntry {
	key: string;
	value: string;
	/**
	 * `text` is a multi-line string (a pasted PEM bundle, issue #706) - the
	 * same value space as `string`, rendered as a textarea rather than a
	 * single-line input because the content has line breaks that matter.
	 */
	type: "integer" | "string" | "boolean" | "number" | "enum" | "text";
	label: string;
	description: string;
	category: string;
	default: string;
	min?: string;
	max?: string;
	/**
	 * Whether the running engine keeps the old value until it is restarted.
	 * Typed metadata the engine always sends (`config_entry_json`), replacing
	 * the "(Requires Restart)" label substring both this app and the MCP
	 * `update_config` tool used to parse out of the prose.
	 */
	requiresRestart: boolean;
	/**
	 * Whether the entry is an internal with no everyday user story (a lock
	 * pragma, a watchdog backoff). Rendered collapsed under "Advanced" at the
	 * bottom of its category rather than beside the settings people tune.
	 */
	advanced: boolean;
	/**
	 * Extra terms the settings search matches on - what a user types that this
	 * entry's key, label and description never say ("ram" for `dbCacheSize`,
	 * "deadline" for `defaultTimeout`). Always sent, empty for the entries that
	 * declare none, so "no keywords" never has to be told from "not sent".
	 *
	 * **Never rendered**, which is the one deliberate exception to this repo's
	 * "written but never read" rule: the reader is `buildSettingsIndex`
	 * (`lib/settings-index.ts`), not a component. Do not go looking for the UI
	 * that shows these - there is none, by design.
	 */
	keywords: string[];
	/**
	 * What a numeric entry's value measures - `"ms"`, `"sec"`, `"days"` or
	 * `"bytes"` today. Absent means the number is a count (workers, retained
	 * runs), which has no unit; the engine omits the key rather than sending
	 * null, the same as `min` / `max` / `options`.
	 *
	 * Rendered as the suffix inside the input, which is where a unit is stated
	 * once - so a description must not spell it out as well (the engine guards
	 * its seeds for that). `"bytes"` additionally selects the human-readable
	 * byte formatting for the value, the range hint and the default line; any
	 * other unit is shown verbatim, so a unit this app has never heard of still
	 * reaches the screen instead of vanishing.
	 */
	unit?: string;
	updatedAt: number;
	/**
	 * Present only on `type: "enum"` entries (e.g. `defaultHttpVersion`); the
	 * engine omits the key entirely rather than sending `null` or `[]` when a
	 * stored row's options fail to parse (`engine/src/http/routes/config.cpp`),
	 * so a renderer must treat a missing `options` as "nothing to offer", not
	 * as a bug.
	 */
	options?: { value: string; label: string }[];
}

/** Client-side settings panels (localStorage-backed prefs, rendered by app panels). */
export type ClientSettingsCategory =
	| "appearance"
	| "editor"
	| "dashboard"
	| "load-testing"
	| "notifications"
	| "general"
	| "mcp";

/**
 * Engine settings categories (data-driven from the engine `/config` API).
 *
 * Seeded engine-side in `seed_default_config`; this union is the renderer's
 * copy of that set, and `ENGINE_SETTINGS_CATEGORIES` gives each one its
 * sidebar row. An entry whose category is in neither is dropped from the
 * search index rather than shown under a heading that does not exist.
 */
export type EngineSettingsCategory =
	| "general_engine"
	| "network_performance"
	| "services"
	| "observability"
	| "data_retention"
	| "limits"
	| "scripting_sandbox";

export type SettingsCategory = ClientSettingsCategory | EngineSettingsCategory;

/**
 * MCP safety guardrails, mirrored from the Electron main process
 * (`electron/mcp/config.ts`). The renderer cannot import from `electron/`, so
 * the shape is redeclared here for the Settings panel and the preload typings.
 */
export interface McpSafetyConfig {
	/** Hostnames an agent may send traffic to. Empty = deny all (safe default). */
	allowlist: string[];
	/** When true, bypass the allowlist and allow any resolvable host. */
	allowAll: boolean;
	/** Hard ceiling on `targetRps` for load runs. */
	maxRps: number;
	/** Hard ceiling on `concurrency` for load runs. */
	maxConcurrency: number;
	/** Hard ceiling on a load run's duration, in seconds. */
	maxDurationSeconds: number;
	/**
	 * Hard ceiling on `iterations` for an iterations-mode run, which stops on a
	 * request count and so cannot be bounded by `maxDurationSeconds`.
	 */
	maxIterations: number;
	/** When false (default), collection/environment write tools are disabled. */
	allowWrites: boolean;
	/** Tool names the user has switched off (omitted from tools/list + rejected). */
	disabledTools: string[];
}

/** Feature grouping for the MCP tool list in Settings. */
export type McpToolCategory = "read" | "execute" | "write" | "load";

/** Metadata for one MCP tool, surfaced in Settings for enable/disable control. */
export interface McpToolInfo {
	name: string;
	description: string;
	category: McpToolCategory;
}

export interface McpStatus {
	running: boolean;
	url: string;
	/** Whether the MCP server is enabled (may be enabled-but-not-running on error). */
	enabled: boolean;
}

/** Clients Vayu can register itself with via their own CLI (one-click connect). */
export type McpConnectClient = "claude" | "vscode";

export interface McpConnectResult {
	ok: boolean;
	/** "cli-not-found" → the client's CLI isn't installed; fall back to the snippet. */
	reason?: "cli-not-found" | "error" | "unsupported";
	message?: string;
}

/**
 * A data family an MCP call can change. Mirrors `MCP_DATA_ENTITIES` in
 * `electron/mcp/tools.ts` - the main process owns the list, and production code
 * there cannot import from here (see `tsconfig.node.json`), so the duplication
 * is deliberate and pinned by `electron/mcp/data-changed.conformance.test.ts`.
 */
export type McpDataEntity =
	| "collection"
	| "request"
	| "environment"
	| "run"
	| "cookie"
	| "config"
	/** Engine-hosted local services: webhook inboxes, mock servers and mock issuers. */
	| "service";

/**
 * What the main process sends over `mcp:data-changed`. Invalidation only - the
 * renderer refetches through its normal query layer rather than being handed
 * engine data over IPC. See `lib/mcp-invalidation.ts` for the key mapping.
 */
export interface McpDataChangedEvent {
	entity: McpDataEntity;
	/** The collection the call named, when it named one. */
	collectionId?: string;
	/** The saved request the call named, when it named one. */
	requestId?: string;
	/**
	 * The history run the call named, when it named one. Only the tools that
	 * rewrite or remove an *existing* run spell this (`stop_run`,
	 * `set_run_baseline`, `delete_run`).
	 */
	runId?: string;
	/**
	 * The webhook inbox the call named, when it named one. Only the tools that
	 * act on an existing inbox spell it (`stop_webhook_inbox`,
	 * `delete_webhook_inbox`, `clear_inbox_captures`, `update_inbox_response`).
	 */
	inboxId?: string;
	/**
	 * The collection mock server the call named, when it named one - only
	 * `stop_mock_server` among the mutating tools, since `start_mock_server` has
	 * no id until the engine answers.
	 */
	mockId?: string;
}

export interface ScriptCompletion {
	label: string;
	kind: number;
	insertText: string;
	insertTextRules?: number;
	detail: string;
	documentation: string;
	sortText?: string;
	filterText?: string;
}

export interface ScriptCompletionsResponse {
	version: string;
	engine: string;
	completions: ScriptCompletion[];
}

/**
 * The TypeScript declarations for the `pm.*` surface, generated engine-side
 * from the same completion table (`GET /scripting/types`).
 *
 * Feeding these to Monaco's TypeScript worker is what turns a suggestion list
 * into hover documentation, signature help and typo diagnostics. They are
 * generated rather than hand-written in this repo on purpose: a `pm.d.ts` here
 * would be a second declaration of a surface the engine owns.
 */
export interface ScriptTypeDefinitionsResponse {
	version: string;
	engine: string;
	/** Model URI the declarations are registered under - `ts:vayu/pm.d.ts`. */
	libUri: string;
	/** The `.d.ts` source itself. */
	typeDefinitions: string;
}
