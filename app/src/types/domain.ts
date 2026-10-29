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
	| "x-www-form-urlencoded"
	| "binary";

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
	| "ntlm"
	| "hawk"
	| "oauth1"
	| "edgegrid"
	| "jwt";

/**
 * A single key-value entry (headers, params, form fields).
 * `enabled: false` rows are preserved in storage and excluded only at HTTP-execution time.
 * Duplicates are allowed (useful for multiple `Accept` headers etc.).
 */
/**
 * A header row a *setting* wrote on its way in - the body mode's
 * `Content-Type`, the Event stream toggle's `Accept` - so the setting can tell
 * its own row apart from one the user typed, including across a reload (issue
 * #1481). An in-memory record of "which row did I write" cannot survive that;
 * the fact has to live with the row it describes.
 */
export type AutoHeaderSource = "body-mode" | "stream";

/**
 * `source` on a stored row: an app setting's own marker (`AutoHeaderSource`),
 * or `"legacy-default"` - the engine's header-strip repair pass stamps this on
 * a row it disabled because its value was the exact shape a pre-#1229 client
 * wrote (`X-Vayu-Version`, `X-Request-ID`, `User-Agent`), so the row survives
 * disabled rather than deleted and the user can re-enable it if the match was
 * wrong (issue #1491).
 */
export type HeaderRowSource = AutoHeaderSource | "legacy-default";

/**
 * Which app setting last wrote `Request.method`, still unclaimed by the user
 * (issue #1505) - the same ownership-by-marker rule `AutoHeaderSource` states
 * for a header row, applied to the one field that is not a `KeyValueEntry`.
 * The GraphQL body mode is the only writer today: entering it sets `method` to
 * `POST` on a fresh `GET` and stamps this; picking a method by hand, or
 * leaving GraphQL, clears it the way retyping a marked header row does.
 */
export type MethodSource = "graphql";

/** Which saved example a mock server answers with (issue #481 phase 3). */
export type MockResponseMode = "first" | "fixed" | "random";

export interface KeyValueEntry {
	key: string;
	value: string;
	enabled: boolean;
	description?: string;
	/** Present only on a row an app setting or the engine's own repair pass wrote; absent on one the user typed. */
	source?: HeaderRowSource;
	/**
	 * Where a params row is sent (issue #1764). Absent means `"query"`. A
	 * `"path"` row names a `:key` segment of the URL (`key` without the colon)
	 * and never reaches the query string; the engine substitutes its value at
	 * compose time. Meaningless on any other kind of row.
	 */
	in?: ParamLocation;
	/**
	 * A query row that states no value at all, written as a bare `key` where
	 * an empty `value` writes `key=` (Postman's `"value": null` against `""`,
	 * issue #1772). Only meaningful while `value` is empty; editing the value
	 * clears it. Meaningless on any other kind of row.
	 */
	valueless?: true;
}

/** See {@link KeyValueEntry.in}. */
export type ParamLocation = "query" | "path";

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
 * A text part may carry `contentType` as well (a Postman import keeps the one
 * the source declared, #2539): the part is sent with that type and none
 * otherwise. `src` and `fileName` stay file-only.
 *
 * `unresolved` is read-only: the engine's answer, on a read, to whether it
 * would refuse the path on this machine, and what the editor's warning reads.
 * It is never sent (`lib/file-trust.ts`). `x-www-form-urlencoded` has no file
 * form, so a file part is only ever valid under `form-data`.
 */
export interface FormFieldEntry extends KeyValueEntry {
	type?: "text" | "file";
	src?: string;
	fileName?: string;
	contentType?: string;
	unresolved?: boolean;
}

/**
 * The file a `binary` body sends: an absolute path on this machine, read by the
 * engine at send time, never held here. The members mean what they mean on a
 * form-data file part, `unresolved` included: derived by the engine on a read,
 * `true` for a path it would refuse because it is neither under an allowed
 * folder (`FileRoot`) nor picked on this machine. A pick in the editor sets it
 * `false` until the next read; nothing sends it (`lib/file-trust.ts`).
 */
export interface FileRef {
	src: string;
	fileName?: string;
	contentType?: string;
	unresolved?: boolean;
}

/** A folder Vayu may read request-body files from without a per-file pick. */
export interface FileRoot {
	id: string;
	path: string;
	createdAt: number;
}

/**
 * Request body as a discriminated union.
 * `body_type` on the domain `Request` is a denormalized mirror of `body.mode`.
 */
export type RequestBody =
	| { mode: "none" }
	| { mode: "json" | "text" | "graphql" | "jsonrpc" | "xml"; content: string }
	| { mode: "form-data"; fields: FormFieldEntry[] }
	| { mode: "x-www-form-urlencoded"; fields: KeyValueEntry[] }
	| { mode: "binary"; file: FileRef };

/**
 * Auth configuration for requests.
 * `inherit` resolves by walking the parent collection chain at execution time.
 * Collections never use `inherit` - they are always the auth source.
 */
export type OAuth2GrantType = "authorization_code" | "client_credentials" | "password";

/** Where a token or refresh request carries an {@link OAuth2ParamRow}. */
export type OAuth2ParamSendAs = "body" | "url" | "header";

/**
 * One extra request parameter of an OAuth 2.0 config (issue #2536): an Auth0
 * `audience`, an Azure AD `resource`, an `acr_values`. Absent `enabled` means
 * enabled and absent `sendAs` means `body`; the authorize request reads
 * neither, every row of `authorizationParams` rides its URL query. The engine
 * sends the rows and keys the token cache by them
 * (`engine/include/vayu/http/oauth_client.hpp`).
 */
export interface OAuth2ParamRow {
	key: string;
	value: string;
	enabled?: boolean;
	sendAs?: OAuth2ParamSendAs;
}

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
	/** Appended to the authorize URL's query (authorization_code). Absent when empty. */
	authorizationParams?: OAuth2ParamRow[];
	/** Appended to a fresh grant's token request. Absent when empty. */
	tokenParams?: OAuth2ParamRow[];
	/** Appended to a refresh request. Absent when empty. */
	refreshParams?: OAuth2ParamRow[];
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
 * is the app's half of that read; the engine's is `resolve_inherited_auth` in
 * `engine/src/http/request_composer.cpp`, which `POST /compose` (and so MCP)
 * walks.
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
	| {
			mode: "digest" | "aws" | "ntlm" | "hawk" | "oauth1" | "edgegrid" | "jwt";
			config: Record<string, unknown>;
	  };

/**
 * The data contract a collection declares (issue #599): which columns a run's
 * data file is expected to carry, so `{{data.*}}` and `pm.iterationData` have
 * something to be checked against at authoring time.
 *
 * The *schema* rides the engine row, and so does where the file is
 * (`Collection.dataFile`); the file's **rows** are persisted nowhere at all -
 * they are user data of unknown sensitivity, and that rule is older than this
 * field.
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
 * Where a collection's spec document was picked from (issue #638): a picked
 * file's location, beside `Collection.openapi`, for the specs that came from a
 * file rather than a URL. A URL-sourced spec has none; its origin is
 * `spec_documents.source_url`.
 *
 * Stored on the engine row (#2765), so a workspace backup carries it and a
 * restore names the file again - on another machine, a path that may not
 * exist there. A stored path grants nothing: the main process reads a file
 * only if the user picked it (`electron/file-grants.ts`).
 */
export interface SpecFileLocation {
	/** Absolute path, obtained from the preload `getFilePath` bridge at pick time. */
	path: string;
	/** The file's own name, which is what the Spec tab shows as the source. */
	fileName: string;
}

/**
 * Where a collection's data file was picked from (issue #599), so a run, the
 * Data tab and Send-with-row can re-read the file the contract was declared
 * from. Stored on the engine row like {@link SpecFileLocation}. The file's
 * **rows** are stored nowhere.
 */
export interface DataFileLocation {
	/** Absolute path, obtained from the preload `getFilePath` bridge at pick time. */
	path: string;
	/** The file's own name, for a message about a file that has since moved. */
	fileName: string;
	/**
	 * SHA-256 of the file's bytes the last time the app read it (issue #2051),
	 * the digest a run records as `dataFileHash`. Absent until the first read
	 * that recorded one.
	 */
	hash?: string;
	/**
	 * Read this CSV/TSV file's unquoted numbers as numbers (#2540), the
	 * picker's "Read numbers as numbers". A fact about how *this* file is read,
	 * so a pick of a file starts it off; absent means off. Every re-read of the
	 * path parses with it, so the rows a run sends match the preview.
	 */
	castNumbers?: boolean;
}

/**
 * One row of the declared-operation index stored beside a spec document
 * (issue #629): an operation's identity plus the status patterns its `responses`
 * map declares.
 *
 * The index exists because contract coverage has to know which operations a
 * document declares and which responses each promises, without re-reading the
 * document on every run. **The engine derives it** from the bytes it stores
 * (issue #853) rather than taking one from a client, so what a document declares
 * has one reader; this type is how the app reads the stored result back.
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
 * JSON Schema, translated out of OpenAPI's dialect by the engine as the document
 * was stored (`core/openapi_document.hpp`, issue #860), and may legally be
 * `true` or `false` as well as an object. A status that declares no schema is
 * a status-only row: `contentType` is `""` and `schema` is absent (#3028).
 */
export interface DeclaredResponseSchema {
	status: string;
	contentType: string;
	schema?: unknown;
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
	/**
	 * Typed behaviours run at fixed phases of every step beneath this collection
	 * (issue #1512): extractors, assertions, timers and scripts, in list order.
	 * Replaces `preRequestScript`/`postRequestScript` - a script is now a
	 * `script.pre`/`script.post` element like any other kind. This is the
	 * collection's **own** list only; a request beneath it sees these plus its
	 * ancestors', resolved by the engine at compose/execute time and shown in
	 * the app by walking the chain (see `InheritedElementsNotice`).
	 */
	elements: ElementDef[];
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
	/** The file the spec was picked from; absent when it was not a file, or unbound. */
	specFile?: SpecFileLocation;
	/** The file the data contract was declared from; absent when there is none. */
	dataFile?: DataFileLocation;
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
	 * than name it: Send-with-row looks up that collection's bound data file,
	 * which belongs to the collection whose Data tab declared the contract -
	 * under the chain rule an ancestor as often as the request's own parent.
	 */
	collectionId: string;
	/** Declared column names, in the order the contract lists them. */
	columns: string[];
}

/** Which kind of row a tree sibling is: a sub-folder or a request. */
export type TreeRowKind = "collection" | "request";

/** A row the sidebar places in a tree - a {@link Collection} or a {@link Request}. */
export interface OrderedTreeRow {
	/**
	 * Read only to rank an `order` tie across kinds, so a list of one kind (the
	 * collections list, one request list) sorts the same without it. A list that
	 * mixes the two states it on every row - `childrenOf` in
	 * `modules/collections/tree-children.ts` is the one place that builds one.
	 */
	kind?: TreeRowKind;
	order?: number;
	createdAt?: string;
	id?: string;
}

/** Rank on an `order` tie: a sub-folder sorts before a request. */
const KIND_RANK: Record<TreeRowKind, number> = { collection: 0, request: 1 };

/**
 * The one ordering rule for collections and requests alike: `order` ascending,
 * then kind (a sub-folder before a request), then creation time, remaining ties
 * by id. A collection's sub-folders and requests share one `order` space
 * (#2535), so this sorts the merged sibling list the sidebar renders and a
 * recursive run walks; within one kind it is the `order, createdAt, id` rule
 * unchanged.
 *
 * There used to be two comparators with two different tie rules - collections
 * tiebroke by id, requests by `createdAt` - while the engine tiebroke by
 * neither, leaving ties to a rowid that `INSERT OR REPLACE` reassigns on every
 * edit. So "run this folder" could execute in a different order than the
 * sidebar showed, and either order could change after an unrelated rename.
 *
 * The rule is now identical on both sides, pinned by
 * `engine/tests/fixtures/tree-order-conformance.json` (issues #360, #2535;
 * the engine's copy is `engine/include/vayu/db/sibling_order.hpp`). Three
 * details are load-bearing rather than incidental:
 *
 *  - **Kind before `createdAt`.** A workspace from before the shared space has
 *    rows of both kinds tied at `0`; ranking the folder first keeps the
 *    folders-first display they were created under.
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

	const kindDiff = KIND_RANK[a.kind ?? "collection"] - KIND_RANK[b.kind ?? "collection"];
	if (kindDiff !== 0) return kindDiff;

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

/**
 * One property of an {@link ElementConfigSchema} - almost always a flat
 * scalar, with one level of `object` nesting for the rare kind whose config
 * groups two fields (`assert.status.range`'s `{min, max}`). The generic
 * element form (`components/shared/ElementList/GenericElementForm.tsx`)
 * renders one of these per property; a kind that needs more than one level,
 * or a form richer than one row per field, ships a bespoke form instead
 * (`elementForms.ts`).
 */
export interface ElementConfigProperty {
	type?: "string" | "integer" | "number" | "boolean" | "array" | "object";
	enum?: string[];
	items?: { type?: string };
	minimum?: number;
	maximum?: number;
	/** The numeric form (`value > exclusiveMinimum`), the only one the registry emits. */
	exclusiveMinimum?: number;
	minLength?: number;
	maxLength?: number;
	/** A plain pattern, unanchored unless it says otherwise; `validateElementConfig` runs it as a JS `RegExp`. */
	pattern?: string;
	/** Present only when `type` is `"object"` - one level deep, never further. */
	properties?: Record<string, ElementConfigProperty | null>;
	required?: string[];
	/** A short label for this field (issue #1607), in place of its raw key. */
	title?: string;
	/** One sentence of hint text for this field (issue #1607). */
	description?: string;
	/** `"advanced"` folds this field under a disclosure instead of the form's main rows (issue #1607). */
	"x-vayu-group"?: "advanced";
	/** A numeric suffix to render beside this field's value: `"ms"`, `"%"` or `"B"` (issue #1607). */
	"x-vayu-unit"?: "ms" | "%" | "B";
}

/**
 * A JSON Schema object, scoped to what the element registry emits (issue
 * #1512).
 *
 * A property's value is `| null` because JSON Schema lets an unconstrained
 * property be written that way rather than as `{}` - `assert.jsonpath`'s
 * `expected` does this, since it legally holds any JSON value. Read through
 * `GenericElementForm`'s `PropertyRow`, which treats `null` the same as `{}`:
 * a property that declares nothing still renders, as a JSON value field,
 * rather than the type checker's non-null promise crashing the one place that
 * reads it.
 */
export interface ElementConfigSchema {
	type: "object";
	properties?: Record<string, ElementConfigProperty | null>;
	required?: string[];
	additionalProperties?: boolean;
}

/** One entry in the engine's element-kind catalogue, `GET /elements/kinds`. */
export interface ElementKindSchema {
	kind: string;
	version: number;
	label: string;
	description: string;
	category: string;
	hotPathClass: "declarative" | "script";
	/** True for a kind valid only on a collection (`script.setup` / `script.teardown`, issue #1499) - refused engine-side on a request; the app's Add menu hides it there too. */
	collectionOnly: boolean;
	configSchema: ElementConfigSchema;
	phases: string[];
}

/**
 * One typed behaviour attached to a request or collection (issue #1512): an
 * extractor, assertion, timer, controller or script, run by the engine's
 * element pipeline at the phase its `kind` implies (`GET /elements/kinds`
 * names each kind's phases; never stored here). Replaces the two script
 * columns - a script is now a `script.pre` / `script.post` element like any
 * other kind, edited through the same `ElementList` as the rest.
 *
 * `config` is validated against the kind's schema engine-side on save; the
 * app's own check is `validateElementConfig` (`lib/elements.ts`), which covers
 * the keywords the registry uses and reports every failing field.
 */
export interface ElementDef {
	id: string;
	kind: string;
	enabled: boolean;
	name?: string;
	config: Record<string, unknown>;
}

/**
 * The level of the inheritance chain an element, an assertion or a console line
 * came from (issue #2522): the root collection, any collection below it (a
 * folder), or the request itself. Finer than an origin's `kind`, which keeps
 * its two values because its readers branch on them.
 */
export type ElementScope = "collection" | "folder" | "request";

/**
 * One element as sent inline to `POST /compose` / `POST /execute` for an
 * ad-hoc send (issue #1512), stamped with where it came from - the
 * generalized, N-kind form of {@link ScriptPart}. Built by
 * `elements-parts.ts`, which walks the collection chain, root to leaf, then
 * the request's own. Absent `origin` is an inline send with no `requestId`
 * chain to resolve from.
 */
export interface ResolvedElement extends ElementDef {
	origin?: { kind: "collection" | "request"; scope?: ElementScope; id?: string; name?: string };
}

/**
 * What one element did when its phase ran (issue #1512), carried on the same
 * trace `scripts` rides (`RunResultTrace.elements`) - one entry per element
 * that ran, beside the existing script test results.
 *
 * `origin` is absent for an inline send with no `requestId` to resolve a
 * chain from (`docs/engine/api-reference.md`'s Elements section).
 */
export interface ElementOutcome {
	id: string;
	kind: string;
	origin?: { kind: "collection" | "request"; id: string; name?: string };
	outcome: "ok" | "failed" | "missing" | "skipped" | "error";
	message?: string;
	waitedMs?: number;
}

export interface Request {
	id: string;
	collectionId: string;
	name: string;
	description: string;
	method: HttpMethod;
	/**
	 * Which app setting last wrote {@link method}, still unclaimed by the user
	 * (issue #1505). Optional, unlike `stream`: the engine serializes `null` for
	 * a request with no marker and `undefined` is how every reader here spells
	 * that - the same `specOperation` convention below.
	 */
	methodSource?: MethodSource;
	url: string;
	params: KeyValueEntry[];
	headers: KeyValueEntry[];
	body: RequestBody;
	bodyType: BodyMode; // Denormalized mirror of body.mode - kept for queryability
	auth: RequestAuth;
	/**
	 * Typed behaviours run at fixed phases of this request's step (issue
	 * #1512): extractors, assertions, timers and scripts, in list order. This
	 * request's **own** list only - see {@link Collection.elements} for the
	 * inheritance rule.
	 */
	elements: ElementDef[];
	/** Follow 3xx `Location` responses. Engine default is `true`. */
	followRedirects: boolean;
	/** Redirect hops allowed when {@link followRedirects} is on. Engine default is 10. */
	maxRedirects: number;
	/**
	 * This request's own timeout in milliseconds (issue #2937), `1`-`86400000`,
	 * or `null` when it states none and sends with the `defaultTimeout` setting
	 * read at each send. Always present on a stored row. Unlike the fields
	 * around it this one is never sent at its default: `null` stays off the
	 * composed payload so the engine resolves the live setting, where a copy of
	 * today's default would pin it.
	 */
	timeout: number | null;
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
	 * control, Settings > Network & connectivity > Custom CA certificates, and
	 * it is the one to reach for first.
	 */
	verifySSL: boolean;
	/**
	 * Skip the cookie jar for this request (issue #1765, Postman's
	 * `protocolProfileBehavior.disableCookies`): no jar cookie is attached and
	 * no `Set-Cookie` is stored. A `Cookie` header typed in the Headers tab is
	 * still sent.
	 */
	disableCookies: boolean;
	/**
	 * The engine's automatic headers this request never sends, as lowercased
	 * names (issue #1765, Postman's `disabledSystemHeaders`). **Stored**, unlike
	 * the per-send `disabledDefaultHeaders` (#1229), which lives only on the
	 * editor state for one Send; the engine unions the two at send time. Names
	 * Vayu cannot omit (`host`, `content-length`) or never sends
	 * (`postman-token`, `connection`, `cache-control`) are kept for the Postman
	 * export and do nothing on the wire.
	 */
	disabledSystemHeaders: string[];
	/**
	 * Send the path and query as written, skipping Vayu's own percent-encoding
	 * of path-variable values, query rows and an API-key query param
	 * (issue #1765, Postman's `disableUrlEncoding`).
	 */
	disableUrlEncoding: boolean;
	/**
	 * The imported Postman item's `protocolProfileBehavior`, verbatim: the JSON
	 * text the engine stores, in the source's member order. Read by the
	 * engine's Postman exporter only; nothing sends it and the app never edits
	 * or parses it - a Duplicate passes the text back as it came, so the copy
	 * exports the same bytes. Absent or `null` for a request that did not come
	 * from Postman.
	 */
	postmanProtocolBehavior?: string | null;
	/**
	 * Consume this endpoint's response as a `text/event-stream` (issue #574).
	 * Stored on the request because it describes the *endpoint* rather than one
	 * send, so the builder's Event stream toggle survives a tab switch and a
	 * bulk import carries it. Always present: a request saved before the column
	 * existed reads back `false`, which is what it was.
	 */
	stream: boolean;
	/**
	 * Which saved example a mock server answers with (issue #481 phase 3).
	 * Always present, unlike `mockExampleId` - a request stored before this
	 * column existed reads back `"first"`, which is what it always served.
	 */
	mockResponseMode: MockResponseMode;
	/**
	 * The example {@link mockResponseMode} `"fixed"` names. Optional, on the
	 * `specOperation` convention above: the engine serializes `null` for a
	 * request that names none, and `undefined` is how every reader here
	 * spells that.
	 */
	mockExampleId?: string;
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
 * A request as the tree lists it: one row of `GET /requests?fields=summary`
 * (#2546), the shape every `listByCollection` cache holds. A `Request` is one,
 * so a write that has the whole row (a create, a reorder's settle) may store it
 * as it stands; a reader that needs anything else fetches the row through
 * `requestDetailOptions`.
 *
 * `createdAt` is here for `compareTreeOrder`'s tie-break and `specOperation`
 * for the Spec tab's mapping count; the rest is what a tree row draws.
 */
export type RequestSummary = Pick<
	Request,
	"id" | "collectionId" | "name" | "method" | "url" | "order" | "createdAt" | "specOperation"
>;

/**
 * A saved example response stored against a request (issue #481).
 *
 * What an importer found next to the request - Postman's saved responses, an
 * OpenAPI operation's documented ones - what the user kept from a live response
 * (issue #588), and what a mock server for the collection answers with.
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
	 * Who wrote this row: `import` for what an importer or a spec sync produced,
	 * `user` for what was saved from a live response (issues #588, #722).
	 *
	 * Typed here because the panel reads it, and it had to be: the two kinds
	 * behave differently and the difference was invisible. A sync rewrites the
	 * imported rows of every request it touches, so an imported example is the
	 * document's to change and a saved one is not - and what deleting one means
	 * differs with it. Always present: the engine has recorded an origin on
	 * every row since #588 and defaults the column to `import`.
	 */
	origin: "import" | "user";
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
 * Where an answer for a name came from: one of the three writable scopes, or the
 * bound data row - the tier above all of them (D18, issue #1007).
 *
 * Deliberately a second union rather than a fourth member of `VariableScope`.
 * Every *write* path is typed on that union - `updateVariable`, the
 * `writableScopes` a caller advertises, the popover's create picker - and a row
 * is not somewhere a variable can be written. Widening `VariableScope` would
 * have offered "Bound row" as a create target that silently no-ops, which is the
 * defect the writable-scope list exists to prevent.
 */
export type VariableOriginScope = VariableScope | "row";

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
 *
 * A `"row"` origin is not a definition at all - nobody wrote it and nothing can
 * edit it - but it is an answer for the name, and the one the send will use, so
 * it belongs in the list the UI reads to explain the winner. It is layered on by
 * `getVariableOrigins`, never by the scope ladder itself; see
 * `ScopeVariableOrigin`.
 */
export interface VariableOrigin {
	scope: VariableOriginScope;
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
	 *
	 * "Winner" means what the send will use, not what the scope ladder settled
	 * on, so a bound row's cell takes it away from every definition beneath.
	 */
	winner: boolean;
}

/**
 * An origin that really is a stored definition, in a scope someone could edit.
 *
 * The scope ladder is built from these and `ResolvedVariable` is derived from
 * them, which is what keeps `ResolvedVariable.scope` a `VariableScope`: a row
 * has no scope to report, and a resolved variable that claimed one would be
 * offering an uneditable tier to every write path that reads it.
 */
export type ScopeVariableOrigin = VariableOrigin & { scope: VariableScope };

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
	/** The request's name as the client sent it at run start - see {@link RunSummary.requestName}. */
	requestName?: string;
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
	 * The data file that drove a **load** run (issue #2051): its name and the
	 * SHA-256 of its bytes, never a path. A collection run keeps the pair inside
	 * its `scenario` block - read both through `dataFileFromSnapshot`.
	 */
	dataFileName?: string;
	dataFileHash?: string;
	/**
	 * Whether the file's numbers were read as numbers (issue #2540). The hash
	 * is of the bytes, so it cannot tell two readings apart. Absent means read
	 * as text, and is how every run recorded before the flag reads.
	 */
	dataFileCastNumbers?: boolean;
	/**
	 * The budgets the run declared, as sent (the engine stores the sanitized
	 * request body). `loadConfigFromSnapshot` reads `latencyP99Ms` from it as the
	 * line the live dashboard draws. A key can be absent, and a run recorded before
	 * budgets existed has none.
	 */
	thresholds?: RunThresholds;
	/**
	 * Requested protocol the run executed with - `build_run_report_config` in
	 * `engine/src/http/routes/runs.cpp` normalizes an absent or explicit-`null`
	 * key to `"auto"` before this ever reaches the client, so it is always
	 * present in practice despite the optional `?`. Distinct from the
	 * *negotiated* protocol on a single exchange (`ResponseState.httpVersion`).
	 */
	httpVersion?: HttpVersion;
	/**
	 * A load or collection run's resolved default-header decision at start
	 * (issue #1488) - `userAgent` is the value verbatim, `requestId` and
	 * `acceptEncoding` are whether each was negotiated at all, and
	 * `expectContinue` (issue #2516) is whether libcurl was allowed to add
	 * `Expect: 100-continue`. Absent on a design run and on any run recorded
	 * before this field existed (a run before #2516 has no `expectContinue`).
	 * Never re-applied to a send; kept only so a baseline comparison can tell
	 * whether two runs measured under the same conditions.
	 */
	defaultHeaders?: {
		userAgent: string;
		requestId: boolean;
		acceptEncoding: boolean;
		expectContinue?: boolean;
	};
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
 * The size a collection run resolved to - the `plan` SSE event that opens
 * `GET /runs/:runId/live` for a sequential run, built by `build_plan_data`
 * (engine/src/core/scenario_runner.cpp), issue #1398.
 *
 * The engine is the only side that holds these numbers: the client sends no
 * step count, so a run's denominator arrives here or not at all. It arrives
 * once, ahead of the first `step` frame, and a client that attached past its
 * eviction from the tick ring simply never sees it.
 */
export interface ScenarioRunPlanEvent {
	/** The plan's length - steps in one pass, not executions. */
	stepsPerIteration: number;
	/**
	 * Passes over the plan, as the engine resolved them - a data set's row
	 * count where the request named no count of its own.
	 */
	iterations: number;
	/**
	 * `stepsPerIteration * iterations`, an upper bound rather than a promise:
	 * a run stops early on an errored step or a stop request, and
	 * `setNextRequest` can walk an iteration in fewer steps than the plan holds.
	 */
	stepsExpected: number;
}

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
	 * Plan positions the error that ended this step's iteration cost (issue
	 * #2526). Present only on the step whose error ended the iteration short of
	 * the plan's end, and only when above zero - absent, never `0`, everywhere
	 * else - on the same terms as the stored row's.
	 */
	stepsNotRun?: number;
	/**
	 * This step's extractions that found nothing and unset their variable
	 * (issue #3053). Absent, never `0`, when none did - on the same terms as
	 * the stored row's.
	 */
	extractorMisses?: number;
	/**
	 * The stored request this step ran (issue #831), the same id
	 * `stamp_step_identity` writes onto the stored trace - so the way back to a
	 * step's request exists while the run streams, which is when a step that has
	 * just failed is being read.
	 *
	 * Absent for a step whose plan entry names no stored request; the frame
	 * sends no key rather than an empty id, and absent means the card offers no
	 * link at all.
	 */
	requestId?: string;
	/**
	 * What the contract says about this step's response (issue #681), the same
	 * object the stored trace carries - so a step watched live and the same step
	 * read back from the report show one verdict, not two derivations of it.
	 *
	 * Absent for a step of an unbound collection and for one that sent nothing:
	 * a response nobody made was not judged against a contract.
	 */
	validation?: ResponseValidation;
	/**
	 * What this step's assertions came to (issue #724) - two numbers, because
	 * the frame is replayed from a fixed-size ring and a script may make
	 * hundreds of them. The list itself rides the stored row, which is the only
	 * route a collection run's results ever take.
	 *
	 * Absent for a step whose test script asserted nothing, on the same terms as
	 * the verdict above: `0 passed` would read as a result.
	 */
	tests?: StepTestTally;
}

/**
 * How many of one step's assertions held, as the `step` event reports them.
 *
 * The test script's alone, which is exactly what the stored `scripts` node
 * lists - so the tally a step shows live and the list it shows after a reload
 * count the same assertions rather than disagreeing by one script's worth.
 */
export interface StepTestTally {
	passed: number;
	failed: number;
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
	"completed" | "stopped" | "maxStreamEvents" | "maxStreamDurationMs" | "idleTimeout" | "error";

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
	/** Design-mode writer only, flat; see {@link ResponseTiming.engineMs}. */
	engineMs?: number;
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
		/**
		 * `sentHeaders` as lines in wire order (issue #2466): a repeated name is
		 * repeated lines, in the spelling the author typed. Written whenever the
		 * transfer sent any; absent on rows stored before the key, which keep
		 * the folded `sentHeaders` alone (`HttpResponse.requestHeaderLines` is
		 * the live spelling).
		 */
		sentHeaderLines?: HeaderLine[];
		/**
		 * What a `binary` body sent: the file's name, size in bytes and
		 * sha256, recorded at send time - never the bytes and never the path.
		 * `unknown` because a stored row is whatever its engine wrote;
		 * `sentBodyFileOf` (`lib/sent-body-file.ts`) is the one reader.
		 */
		bodyFile?: unknown;
		/**
		 * The auth mode was not executed and the request went out without
		 * authentication - see {@link HttpResponse.authNotice} (issue #2474).
		 * Written on the request node because it describes what was sent, so it
		 * is present on a failed exchange (no `response` node) too.
		 */
		authNotice?: string;
	};
	response?: {
		headers?: Record<string, string>;
		/**
		 * The header lines as received, written only when the response had any
		 * (issue #2460) - `HttpResponse.headerLines` is the live spelling. Absent
		 * on rows stored before the key and on load-run samples, which keep the
		 * folded map alone.
		 */
		headerLines?: HeaderLine[];
		/**
		 * The redirect hops followed, written only when there were some (issue
		 * #2461) - `HttpResponse.redirects` is the live spelling. Absent on rows
		 * stored before the key, on load-run samples and when nothing was followed.
		 */
		redirects?: RedirectHop[];
		body?: unknown;
		/** Set by `store_result` when the response body exceeded `maxTraceBodyBytes`. */
		bodyTruncated?: boolean;
		/** The response body's original byte length, present only when truncated. */
		bodyBytes?: number;
		/**
		 * `body` is the bytes in base64, the same spelling the live answer's
		 * `bodyEncoding` gave them (issue #2458). Written only then: absent is
		 * text, which is what every row stored before the key holds. A truncated
		 * one is the base64 of the prefix kept, and `bodyBytes` counts the
		 * original bytes.
		 */
		bodyEncoding?: "base64";
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
		/**
		 * The live send this trace records stopped reading at
		 * `maxDesignResponseBodyBytes` - see {@link HttpResponse.bodyCapped}
		 * (issue #1157). `build_result_trace` writes the key **only when the
		 * body was cut**, so absent is "not capped" here, unlike on the live
		 * response where it is always present.
		 *
		 * Distinct from `bodyTruncated` above: that one is storage shortening a
		 * body the user already saw whole, and a re-send recovers from it.
		 */
		bodyCapped?: boolean;
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
	 * What each of the step's typed elements did (issue #1512) - extractors,
	 * assertions and timers, beside the script results `scripts` already
	 * carries. One design send and one sequential-run step both write this;
	 * a load-test trace never does, because load mode runs no element yet.
	 */
	elements?: ElementOutcome[];
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
	/**
	 * Which client-certificate registry entry this exchange presented, as
	 * `host` or `host:port` (issue #707). Top level rather than under
	 * `response` because it is a property of the transfer: the exchange that
	 * most needs to name its certificate is the one whose handshake failed, and
	 * that one has no `response` node at all.
	 *
	 * Absent means no certificate was used - which is also what a row stored
	 * before the registry existed means, and the two are the same fact.
	 */
	clientCertificate?: string;
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
	/**
	 * Plan positions the error that ended this step's iteration cost (issue
	 * #2526), stored inside `trace_data` beside the identity above. Absent, never
	 * `0`, on every step but the one that ended its iteration short of the plan's
	 * end.
	 */
	stepsNotRun?: number;
	/**
	 * This step's extractions that found nothing and unset their variable
	 * (issue #3053). Absent, never `0`, on a step where none did, and on a row
	 * stored before the engine counted them.
	 */
	extractorMisses?: number;
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
	/** The data file that drove the run (issue #2051): its name and content hash, never a path. */
	dataFileName?: string;
	dataFileHash?: string;
	/** Whether its numbers were read as numbers (issue #2540); absent means read as text. */
	dataFileCastNumbers?: boolean;
}

/**
 * The compact per-row summary the paginated `GET /runs` list carries in place
 * of the full {@link RunConfigSnapshot}. Mirrors every key
 * `build_run_summary` sends (`engine/src/http/routes/runs.cpp`); each is
 * omitted by the engine when absent from the stored snapshot, except
 * `httpVersion` which the engine always normalizes to a value (see
 * `add_http_version`, same file). The full snapshot is still available on
 * `GET /runs/:id`.
 *
 * `startConcurrency` / `rampUpDuration` / `followRedirects` / `maxRedirects`
 * are declared but **not read from a row's summary** - this type mirrors the
 * wire, so a field the engine sends is declared whether or not a screen reads
 * it, and a reader can trust that what is missing here is missing from the
 * payload too. The two ramp knobs are read from the *report's*
 * `metadata.configuration` instead, by the baseline comparison's
 * `comparability` list (issue #2162); the redirect settings are shown nowhere.
 * If you are looking for somewhere to surface them on a row, the history
 * sidebar row and the load test report both already show `httpVersion` and
 * would be the consistent home.
 */
export interface RunSummary {
	url?: string;
	/**
	 * The request's name, as the client sent it at run start -
	 * `execIdentity` in `execute-mapping.ts` is what threads it through
	 * composition. Never re-read from the requests table server-side, so it
	 * is exactly what the editor showed at the moment this run started: a
	 * renamed or since-deleted request does not retroactively change it, and
	 * a run recorded before this field existed has none. The history row
	 * falls back to `url` when this is absent or still the default name
	 * (`DEFAULT_REQUEST_NAME`).
	 */
	requestName?: string;
	method?: string;
	mode?: string;
	duration?: string;
	concurrency?: number;
	/** Ramp-up runs only (issue #1935); sent by the engine, not read from a row - see the note above. */
	startConcurrency?: number;
	/** Ramp-up runs only (issue #1935); sent by the engine, not read from a row - see the note above. */
	rampUpDuration?: string;
	comment?: string;
	/** Requested protocol - see {@link RunConfigSnapshot.httpVersion}. */
	httpVersion?: HttpVersion;
	/** Sent by the engine, not yet rendered - see the note above. */
	followRedirects?: boolean;
	/** Sent by the engine, not yet rendered - see the note above. */
	maxRedirects?: number;
	/**
	 * Whether this run negotiated a compressed response (issue #1488) - see
	 * {@link RunConfigSnapshot.defaultHeaders}. Omitted, not `false`, for a
	 * run recorded before this field existed; the baseline comparison (its
	 * `compression` entry in `comparability`) is the one reader that treats an
	 * absent value as `false`, matching what such a run actually sent.
	 */
	acceptEncoding?: boolean;
	/**
	 * A collection run's sequence, and nothing else's - see
	 * {@link RunScenarioSummary}. Read by the history row, which has no `url` to
	 * show for one.
	 */
	scenario?: RunScenarioSummary;
	/**
	 * The data file that drove a **load** run (issue #2051): its name and the
	 * SHA-256 of its bytes, never a path. A collection run's pair rides
	 * {@link RunScenarioSummary} instead.
	 */
	dataFileName?: string;
	dataFileHash?: string;
	/** Whether its numbers were read as numbers (issue #2540); absent means read as text. */
	dataFileCastNumbers?: boolean;
	/**
	 * Whether the run's terminal report carries a non-empty `warnings` array
	 * (issue #1527, extending #1503). Omitted, not `false`, for a run with
	 * nothing to report - still running, or finished clean - which is what
	 * lets the history row skip the glyph with a plain presence check rather
	 * than an explicit `=== true`.
	 */
	hasWarnings?: boolean;
}

/**
 * Who started a run, as the engine records it (issue #1817): `app` for this
 * renderer, `mcp` for an agent (with the `clientInfo.name` it sent in its
 * handshake, as sent), `other` for any other caller of the engine and for every
 * run recorded before the field existed. Client-asserted metadata, not
 * identity - the engine takes the caller's word for it.
 *
 * `client` is `null` on the wire when there is none; optional here so a
 * literal in a test or a mapper need not spell it.
 */
export interface RunOrigin {
	kind: "app" | "mcp" | "other";
	client?: string | null;
}

/** What every run shares; {@link Run} adds the `type` and the `resultSummary` that goes with it. */
interface RunFields {
	id: string;
	status: "pending" | "running" | "completed" | "stopped" | "failed";
	startTime: number; // Unix timestamp in ms
	/** Unix ms once the run is terminal; `null` while it is pending or running. */
	endTime: number | null;
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
	 * Whether this run is pinned - kept past the engine's retention and
	 * findable through `GET /runs?baseline=true`. Toggled through
	 * `PUT /runs/:id/baseline`, and any run type can carry it: a design run is
	 * pinned to keep a known-good response, not to be compared. Only a load
	 * run's pin is also read as *the* baseline the vs-baseline comparison
	 * diffs (`useBaselineRunQuery`, `listBaselineRuns`) - it is the only type
	 * with percentiles and throughput to diff.
	 *
	 * Optional because a run row from an engine older than this field has none;
	 * absent reads the same as `false` everywhere.
	 */
	baseline?: boolean;
	/**
	 * Who started the run - see {@link RunOrigin}. Optional because a row from
	 * an engine older than the field has none; absent reads as `other`.
	 */
	origin?: RunOrigin;
}

/**
 * A run as the engine lists it. `type` decides what `resultSummary` holds, so
 * narrow on it before reading the summary: a design row's is its one exchange
 * ({@link RunResultSummary}), a terminal load row's is the run's headline
 * numbers ({@link LoadResultSummary}), and a terminal collection row's is its
 * step counts ({@link CollectionResultSummary}).
 * `GET /runs/:id` carries none of them: it attaches a design run's whole
 * `result`, and the report serves a load or collection run's numbers.
 */
export type Run =
	| (RunFields & { type: "load"; resultSummary?: LoadResultSummary })
	| (RunFields & { type: "design"; resultSummary?: RunResultSummary })
	// A collection run - one row per step. Its tab is `ScenarioRunView` (the step
	// list), not the load-test report: a scenario run's `results[]` are step
	// executions, so the load report's percentiles would describe a sequence as if
	// it were one request repeated. The sidebar row is still the non-load shape,
	// which `RunItem.run-types.test.tsx` pins: the row carries the counts (#2954)
	// for a reader of the wire, and no badge or glyph reads them.
	| (RunFields & { type: "scenario"; resultSummary?: CollectionResultSummary });

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

/**
 * A **terminal load run's** list row, read engine-side from the run's stored
 * summary (#2130) so History can show how a run went without a report fetch per
 * row. Every key is absent when the run did not record it, never zeroed; a row
 * still pending or running has no `resultSummary` at all.
 *
 * `verdict` is present only when the run declared budgets. Its absence means no
 * budget judged the run, which is a different claim from `"passed"`.
 */
export interface LoadResultSummary {
	/** Achieved requests per second. */
	rps?: number;
	/** 95th-percentile latency, in milliseconds. */
	p95Ms?: number;
	/** Percent, 0-100, by the one error definition (`docs/ux-writing.md`). */
	errorRate?: number;
	verdict?: "passed" | "failed";
	/**
	 * Exact assertion outcomes of a **scenario load run** that made at least one
	 * (#2820): `assert.*` outcomes, required `extract.*` misses and inline
	 * `pm.test` calls. Both keys are present or neither is, and neither is ever
	 * zeroed: absent for a run that asserted nothing, a collection run, a
	 * single-request run and a run stored before the field.
	 *
	 * `assertionsFailed` is what a row's verdict and subtitle read (`rowOutcome`,
	 * `resultSubtitle`); `errorRate` and `verdict` stay HTTP-and-budget only.
	 * `assertionsPassed` has no renderer reader - the MCP `list_runs` row, which
	 * passes the summary through, is its consumer.
	 */
	assertionsPassed?: number;
	assertionsFailed?: number;
	/**
	 * What a **terminal capacity run's** search found (#2930): present on that
	 * row alone, absent for every other mode and for a row an older engine sent.
	 * `rps`, `p95Ms` and `errorRate` stay on the row, but they average a search
	 * that stepped load up, so `resultSubtitle` prints these levels instead.
	 *
	 * `maxHealthyConcurrency` is the highest level that held its budgets and
	 * `kneeConcurrency` the level that broke them; each is omitted, never
	 * zeroed. A missing `maxHealthyConcurrency` beside a knee means the first
	 * level already failed. `stopReason` is the key `STOP_REASONS` words.
	 */
	capacity?: LoadResultCapacity;
}

/**
 * A **terminal collection run's** list row, read engine-side from the stored
 * `summary.scenario` block (#2954). The four counts are disjoint outcomes of the
 * run's steps, and `errored` sits beside `failed` because a run whose steps only
 * errored would otherwise read clean. Every key is absent when the run did not
 * record it, never zeroed; a row still pending or running has no
 * `resultSummary` at all, and `verdict` is present only when the run declared
 * budgets.
 *
 * No renderer reader: the history row's badge and glyph stay gated on a load
 * run, and the MCP `list_runs` row, which passes the summary through, is the
 * consumer.
 */
export interface CollectionResultSummary {
	passed?: number;
	failed?: number;
	skipped?: number;
	errored?: number;
	verdict?: "passed" | "failed";
}

/** The levels a capacity search settled on - see {@link LoadResultSummary.capacity}. */
export interface LoadResultCapacity {
	stopReason: string;
	maxHealthyConcurrency?: number;
	kneeConcurrency?: number;
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
		/**
		 * The `before` cursor naming this page's last row, `null` on the last page.
		 * Pass it back unchanged: the engine owns its spelling (`<startTime>:<id>`).
		 */
		nextBefore: string | null;
	};
}

/** Server-side filters for the paginated `GET /runs` list. */
export interface RunListParams {
	limit?: number;
	offset?: number;
	/**
	 * Keyset cursor: the page starts after the row it names. Take it from the
	 * previous page's `pagination.nextBefore`. The engine refuses it beside a
	 * non-zero `offset`, so `listRuns` leaves its default `offset` off when one
	 * is set.
	 */
	before?: string;
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
	/**
	 * Only runs started by this kind of caller (`GET /runs?origin=`). Unset
	 * lists every origin. An engine older than the filter ignores it.
	 */
	origin?: RunOrigin["kind"];
}

/** Load-test execution strategy. Single source of truth for the mode union. */
export type LoadTestMode =
	"constant_rps" | "constant_concurrency" | "iterations" | "ramp_up" | "capacity";

/**
 * The fixed budget keys, split out from {@link RunThresholds} so they stay a
 * closed set of named fields: `keyof` this is the six metrics and nothing else,
 * which is what lets the dialogs drive their fields, their validation and their
 * payload from one table (`budgets.ts`). `keyof RunThresholds` cannot say that,
 * because that type also carries the dynamic `custom.*` family below.
 */
export interface RunThresholdBudgets {
	latencyP50Ms?: number;
	latencyP95Ms?: number;
	latencyP99Ms?: number;
	/** Share of the run's requests allowed to fail, 0-100. */
	maxErrorRatePct?: number;
	minThroughputRps?: number;
	/**
	 * Share of the run's assertions - `assert.*` element outcomes and
	 * `pm.test` calls alike - allowed to fail, 0-100 (issue #1497).
	 */
	maxAssertionFailureRatePct?: number;
}

/**
 * Pass/fail budgets a run declares up front, so the engine can judge it rather
 * than only measure it. Keys are the engine's own metric names (they travel
 * verbatim on `POST /runs` and come back in `RunReport.thresholdValidation`),
 * which is why they are camelCase where the rest of `LoadTestConfig` is not.
 *
 * Every key is optional and at least one must be present - the engine rejects
 * an empty object rather than starting a run nothing will judge.
 */
export interface RunThresholds extends RunThresholdBudgets {
	/**
	 * A budget this run missed changes its terminal status to `failed`
	 * rather than only being reported (issue #1497). Not a budget itself, so
	 * it needs at least one of the above declared to mean anything - the
	 * engine rejects `{ failRun: true }` alone the same way it rejects `{}`.
	 */
	failRun?: boolean;
	/**
	 * `custom.<name>.<stat>` - a budget on a `metric.record` / `pm.metrics`
	 * value (issue #1500), where `<name>` is the name it was recorded under and
	 * `<stat>` one of `p50`, `p95`, `p99`, `max`, `value`, `rate`. Always a
	 * ceiling, always a non-negative number.
	 *
	 * A *pattern* index signature rather than a blanket `[key: string]`: the six
	 * fields above keep their own types, `failRun` keeps its `boolean` (it does
	 * not match the pattern, so nothing has to be widened to accommodate it),
	 * and a mistyped fixed key is still a type error rather than being swallowed
	 * as "some other threshold". The engine checks the *shape* of these keys and
	 * not that `<name>` is one this run records, so neither does this
	 * (`docs/engine/api-reference.md`, the thresholds block).
	 */
	[key: `custom.${string}`]: number | undefined;
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
	/**
	 * Which `thresholds` keys still hold a value the user did not set for this run
	 * (issue #2195). Absent when none do, and never names a key `thresholds` lacks.
	 */
	carriedBudgets?: string[];
	/** Absent when the run monitors no endpoint - never an empty object. */
	monitor?: RunMonitorConfig;
	/**
	 * Capacity only: the p99 budget the search looks for the edge of, in ms.
	 * Prefilled from the client-side `sloThresholdMs` setting, so the number
	 * the search is steered by is the one the user already chose rather than a
	 * second, unrelated one. The live and stored dashboards draw it as the run's
	 * SLO line (`runOwnSloMs`, `runSloMs`).
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
	/**
	 * The rows this run binds, one object per row (issue #993) - the parsed
	 * file the dialog's picker holds, never a re-parse of it.
	 *
	 * Absent when no file was picked, which is what leaves the run on the path
	 * it took before data-driven single-request runs existed. Named `data`
	 * rather than snake_cased like its neighbours because it is the engine's own
	 * field name, the same reason {@link RunThresholds} and
	 * {@link RunMonitorConfig} are camelCase here.
	 */
	data?: Record<string, unknown>[];
	/**
	 * The column names of that same file (issue #1007) - what composition must
	 * leave for the per-row bind, so a Postman-shaped `{{username}}` is not
	 * resolved from a same-named environment variable before any row is bound.
	 *
	 * Carried beside the rows rather than derived from them at the compose call:
	 * the picker's parse already names the columns (a JSON row may simply omit
	 * one), and re-unioning the keys here would be a second answer to a question
	 * `ParsedDataFile` has already answered. Absent exactly when `data` is.
	 */
	dataColumns?: string[];
	/**
	 * The picked file's name and the SHA-256 of its bytes (issue #2051),
	 * forwarded beside `data` so the run records which file drove it - a
	 * display name, never a path. Absent exactly when `data` is.
	 */
	dataFileName?: string;
	dataFileHash?: string;
	/**
	 * Whether the picked file's numbers were read as numbers (issue #2540),
	 * so the run records how its rows were typed. Absent exactly when `data` is.
	 */
	dataFileCastNumbers?: boolean;
	/**
	 * The `elements` run override (issue #1594), single-request runs only:
	 * whether an inherited `script.*` element's own `config.inline` decides
	 * ("asMarked"), or every one runs inline / stays deferred regardless of
	 * its own marking. The same override {@link StartScenarioRunRequest}
	 * sends, restricted to `scripts` here - a load run has no per-run
	 * `timers` control on this dialog. Absent means "asMarked", the engine's
	 * own default, so the field is only sent when the user actually changed
	 * it.
	 */
	elements?: { scripts: "asMarked" | "allInline" | "allDeferred" };
}

/**
 * One scrape of a run's monitored endpoint, as `GET /runs/:id/monitor` returns
 * it and as the live `monitor` SSE frame carries it - one shape for both, so
 * the live overlay and the history overlay are drawn from identical rows.
 *
 * `timestamp` (Unix ms) rather than an elapsed offset is what the join onto the
 * run's own timeline uses: a tick's `elapsed_seconds` counts from load start,
 * after any setup script, while the scrape starts with the run.
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
 *
 * `engineMs` is Vayu's own cost for the exchange (#2132): the engine's elapsed
 * time less the transfer and the user's scripts. Not a phase and not part of
 * `totalMs`' arithmetic, and distinct from `queueWaitMs`, which is the sliver
 * before libcurl. Absent for a stream, an auth-failure reply and rows stored
 * before the key existed.
 */
export interface ResponseTiming {
	totalMs: number;
	wireMs?: number;
	queueWaitMs?: number;
	engineMs?: number;
	dnsMs: number;
	connectMs: number;
	tlsMs: number;
	firstByteMs: number;
	downloadMs: number;
}

/**
 * One header line, name and value, in the case it was written: a response line
 * as the server sent it (issue #2460, the value trimmed by the engine and
 * nothing else) or a request line as it goes out (issue #2466). A repeated
 * header is repeated lines, which a folded `headers` map beside it cannot hold.
 */
export interface HeaderLine {
	name: string;
	value: string;
}

/**
 * One redirect response the engine followed on the way to the final answer
 * (issue #2461): its status and every header line it carried. `headers` and
 * `headerLines` of the answer hold the last hop only, so a `Set-Cookie` or
 * `Location` here is readable nowhere else. It reports what the server sent,
 * not what the cookie jar kept.
 *
 * `url` and `schemeDowngrade` are issue #2949, and absent on a hop from an
 * engine or a stored trace from before it. `url` is the request the hop
 * answered: the requested URL for the first hop, the previous hop's `Location`
 * resolved against it for each later one, with
 * the values of credential query parameters blanked by the engine; `""` when
 * libcurl reported none. `schemeDowngrade` is true when that request went over
 * `https` and the next over `http`.
 */
export interface RedirectHop {
	status: number;
	statusText: string;
	headerLines: HeaderLine[];
	url?: string;
	schemeDowngrade?: boolean;
}

export interface HttpResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	/**
	 * The redirect hops followed before this response, in the order they
	 * arrived - `serialize(Response)` always sends the key, `[]` when nothing
	 * was followed (and always for `followRedirects: false`). Absent on an
	 * engine from before #2461. `responseFromExecuteResult` passes it through
	 * `receivedRedirects`, which reads an empty list as an absent one.
	 */
	redirects?: RedirectHop[];
	/**
	 * The response's header lines in wire order - `serialize(Response)`
	 * (`engine/src/utils/json.cpp`) always sends the key, `[]` when there were
	 * none. `headers` above is the same headers folded (lowercased, repeats
	 * joined with ", "); this is what the folding loses: a repeated name, and
	 * the case the server used.
	 *
	 * `responseFromExecuteResult` passes it through `receivedHeaderLines`
	 * (`lib/header-lines.ts`), which reads an empty list as an absent one.
	 */
	headerLines?: HeaderLine[];
	requestHeaders?: Record<string, string>;
	/**
	 * The request's header lines as the transfer sent them, in wire order
	 * (issue #2466) - `requestHeaders` above is the same headers folded (a
	 * repeat joined with ", ", `Cookie` with "; "), which loses a repeated name
	 * and the spelling typed. Absent from an engine that predates the key.
	 *
	 * `responseFromExecuteResult` passes it through `sentHeaderLines`
	 * (`lib/header-lines.ts`), which reads an empty list as an absent one.
	 */
	requestHeaderLines?: HeaderLine[];
	rawRequest?: string;
	/**
	 * The engine's JSON parse of `bodyRaw`, or `null` when it has none to give:
	 * the request declined it (`includeParsedBody: false`, which the renderer
	 * always sends), the body is not JSON, is base64, or is past 4 MiB. Nothing
	 * in the renderer reads it but the guard in `responseFromExecuteResult`; the
	 * pane is built from `bodyRaw`.
	 */
	body: unknown;
	bodyRaw: string;
	/**
	 * How to read `bodyRaw` (issue #2458). `"base64"`: the body is not UTF-8
	 * text, `bodyRaw` is its bytes in standard padded base64 and `body` is
	 * null; `bodySize` still counts bytes. Always present on a live body; an
	 * absent one (an older engine, or `useEngine`'s synthesised failure) is
	 * `"utf8"`. Read through `decodeResponseBody`
	 * (`request-builder/utils/response-bytes.ts`), never by hand.
	 */
	bodyEncoding?: "utf8" | "base64";
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
	/**
	 * The request's auth mode is one the engine stores but does not execute
	 * (`digest`, `ntlm`, ...), so it was sent without authentication
	 * (issue #2474). A sentence naming the mode, written by
	 * `record_auth_provenance` (`engine/src/http/request_exchange.cpp`) to this
	 * key and to `trace.request.authNotice` from one place. **Absent** when
	 * there is nothing to say - an executed mode, no auth, or an engine older
	 * than the key - and on a streaming send, which is answered before it
	 * exists: only its stored trace carries it.
	 */
	authNotice?: string;
	/**
	 * Which client-certificate registry entry this exchange presented, as
	 * `host` or `host:port`; `""` when none matched (issue #707). Always
	 * present on a live body, like `httpVersion` above and for the same reason:
	 * an absent key would be an engine too old to say, not "no certificate".
	 */
	clientCertificate?: string;
	/**
	 * The engine stopped reading this body at `maxDesignResponseBodyBytes`
	 * (Settings → Limits, default 32MB), so `body` / `bodyRaw` / `bodySize`
	 * describe the prefix that was read rather than what the server sent
	 * (issue #1157). Status and headers are the server's own - they arrive
	 * first - so this is a successful response carrying a flag.
	 *
	 * Always present on a live body, like `clientCertificate` above and for the
	 * same reason: an absent key is an engine too old to say, not "not capped".
	 *
	 * Not the same fact as the stored trace's `bodyTruncated`, which is
	 * `maxTraceBodyBytes` shortening a body for storage *after* the whole of it
	 * was read - a re-send recovers from that one, and re-sending under a
	 * capped read reproduces the cap.
	 */
	bodyCapped?: boolean;
}

export interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
	/**
	 * Which script called `pm.test` (issue #810).
	 *
	 * Optional because a trace stored - or an engine sidecar answering - before
	 * that issue listed the post-request script's assertions and nothing else,
	 * so an absent source is a `"test"` one rather than an unknown phase. A
	 * pre-request assertion used to fail its scenario step and appear in no
	 * list; it is listed now, and the phase is what keeps "asserted before the
	 * request went out" from reading as an assertion about the response.
	 */
	source?: ScriptSource;
	/**
	 * The level whose script made this assertion (issue #2522). Absent on a trace
	 * stored before the field, and on a send whose elements carry no origin; both
	 * are the request's own.
	 */
	scope?: ElementScope;
}

/** Which `console.*` method a script line came from. Engine spellings. */
export type ConsoleLevel = "log" | "info" | "warn" | "error";

/**
 * Which of a request's two scripts produced something - a console line, or an
 * assertion. One type rather than one per payload: it is the same pair of
 * scripts, and the engine spells them these two ways everywhere.
 */
export type ScriptSource = "pre" | "test";

/**
 * One line of script console output.
 *
 * The engine used to send a bare string and encode the source as a `"[pre] "`
 * text prefix, which was indistinguishable from a script that logged a line
 * starting with those characters - and carried no level at all, so the Console
 * tab drew `console.error` exactly like `console.log`. Both are fields now.
 */
export interface ConsoleLogEntry {
	source: ScriptSource;
	/**
	 * The level whose script printed this line (issue #2522) - not {@link level},
	 * which is the `console.*` method. Absent reads as the request's own.
	 */
	scope?: ElementScope;
	level: ConsoleLevel;
	message: string;
}

export interface SanityResult extends HttpResponse {
	requestId?: string;
	testResults?: TestResult[];
	/**
	 * What each of this send's non-script elements did (issue #1512) -
	 * extractors, assertions and timers, beside `testResults` above.
	 */
	elements?: ElementOutcome[];
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

/**
 * A scenario load run's sequence so far, as a gate frame carries it (issue
 * #2823): the counters the stored summary's `scenario` block reads, without any
 * latency (a step's percentiles are in the finished report alone). Read while
 * the workers still write, so the figures may differ by the completions that
 * landed between the reads.
 */
export interface LiveScenarioProgress {
	/** Iterations started. */
	iterations: number;
	iterationsCompleted: number;
	iterationsAbandoned: number;
	stepsExecuted: number;
	/** One entry per plan step, in plan order. */
	steps: LiveScenarioStep[];
}

/** One plan step's counters on a gate frame; `errors` is the run's one definition (#2124). */
export interface LiveScenarioStep {
	index: number;
	name: string;
	executed: number;
	errors: number;
}

/** A gate frame's run-so-far latency distribution, as the engine sends it (ms). */
export interface LiveLatencyDistribution {
	minMs: number;
	p50Ms: number;
	p75Ms: number;
	p90Ms: number;
	p95Ms: number;
	p99Ms: number;
	p999Ms: number;
	maxMs: number;
	/** Completions behind the distribution. */
	count: number;
}

/** One network phase's run-so-far distribution on a gate frame (ms). */
export interface LivePhaseDistribution {
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
	count: number;
}

/** The five phases keyed by the engine's wire names (TTFB is `firstByte`). */
export type LivePhaseDistributions = Record<
	"dns" | "connect" | "tls" | "firstByte" | "download",
	LivePhaseDistribution
>;

/**
 * The responses that completed in `span` consecutive whole seconds counted from
 * load start, starting at `second`, by status class (issue #2866). `counts`
 * lists 2xx, 3xx, 4xx, 5xx, then every other code (no response included). A
 * gate emits an entry per second it closed, so `span` is 1; a History tick the
 * engine folded (`maxPoints`) carries one entry for its whole bucket, so
 * `counts / span` is responses per second at either resolution.
 */
export interface StatusSecondEntry {
	second: number;
	span: number;
	counts: [number, number, number, number, number];
}

/**
 * Where a capacity search stands, on a live frame (issue #2928); keys keep the
 * wire's camelCase. `level` is the concurrency being measured, `0` until the
 * first level opens. `levelElapsedMs` is the time since that level opened (`0`
 * while `level` is `0`, held at the moment the search ended once it has).
 * `levelsJudged` counts judged levels, a re-measured level once per
 * measurement. `stopReason` is the report's `capacity.stopReason` and appears
 * only once the search has ended.
 */
export interface LiveCapacityState {
	level: number;
	levelElapsedMs: number;
	levelsJudged: number;
	stopReason?: string;
}

export interface LoadTestMetrics {
	timestamp: number;
	elapsed_seconds: number;
	requests_completed: number;
	/**
	 * Errors so far: a response outside 2xx/3xx plus every request that got no
	 * response (issue #2124). `http_errors + no_response`.
	 */
	requests_failed: number;
	/** The part of `requests_failed` that got a response. Absent on a tick stored by an older engine. */
	http_errors?: number;
	/** The part of `requests_failed` that got none (status code 0). Absent on a tick stored by an older engine. */
	no_response?: number;
	/**
	 * Completions per second over the trailing window (at least one second)
	 * ending at this tick, a live frame's and a stored tick's alike (issue #2393).
	 */
	current_rps: number;
	/**
	 * Dispatches per second over the same trailing window as `current_rps`.
	 * Absent on a tick stored before the window existed: `send_rate` is the
	 * run-cumulative figure and must not stand in for it.
	 */
	current_send_rate?: number;
	/**
	 * Mean latency and queue wait of the requests that completed in that
	 * window. `null` for a window in which nothing completed, absent on a tick
	 * stored before the window existed; `avg_latency_ms` is the run-cumulative
	 * mean and must not stand in for either.
	 */
	window_avg_latency_ms?: number | null;
	window_avg_queue_wait_ms?: number | null;
	/**
	 * Mean requests on the wire over the same window (Little's law: the latency
	 * that completed in it over its span), `0` for a window with no completion.
	 * `current_concurrency` is the instant a virtual user in a timer wait holds
	 * nothing at, so it reads 0-and-N for users that never stopped (#2821).
	 * Absent on a tick stored before the window mean existed.
	 */
	window_avg_in_flight?: number | null;
	current_concurrency: number;
	/**
	 * Latency percentiles of the tick. A stored tick's are its whole second's,
	 * merged (issue #2385). A live frame's are only the last ~100 ms window, so
	 * a chart or a threshold must read them through `utils/tickPercentiles.ts`
	 * (`secondPercentiles`, `cumulativePercentiles`) and never off these keys.
	 * An interval with no completion has none (issue #2386): `null` on a live
	 * frame, absent from a stored tick. A tick stored by an older engine holds
	 * `0` there instead.
	 */
	latency_p50_ms?: number | null;
	latency_p95_ms?: number | null;
	latency_p99_ms?: number | null;
	/**
	 * Set by `mapSseMetrics` on every frame that came off the live stream and
	 * absent on a stored tick. It is what tells a live frame with no
	 * `second_samples` (not a gate frame) from a stored tick, whose
	 * `latency_p*_ms` are already per second.
	 */
	live?: true;
	/**
	 * Completions behind the `second_p*_ms` figures. Present only on a gate frame
	 * (about one live frame a second, plus the final frame); 0 for an idle second.
	 */
	second_samples?: number;
	/** The gate frame's whole-second percentiles; `null` when `second_samples` is 0. */
	second_p50_ms?: number | null;
	second_p95_ms?: number | null;
	second_p99_ms?: number | null;
	/**
	 * The run's percentiles so far, on every live frame - the span `avg_latency_ms`
	 * covers. `null` until a completion has been sampled; absent on a stored tick.
	 */
	cumulative_p50_ms?: number | null;
	cumulative_p95_ms?: number | null;
	cumulative_p99_ms?: number | null;
	/**
	 * The run-so-far latency distribution and per-phase distributions, on a gate
	 * frame only (about one live frame a second, the final one included; issue
	 * #2782). Both are `null` until something has completed and absent from every
	 * other frame, so a reader takes them from the latest frame that carries the
	 * key (`utils/liveDistributions.ts`), never from the newest tick.
	 * `cumulative_phases` is also absent when the run has phase histograms off:
	 * absent means "not measured", `null` means "nothing yet".
	 */
	cumulative_latency?: LiveLatencyDistribution | null;
	cumulative_phases?: LivePhaseDistributions | null;
	/**
	 * The sequence of a scenario load run, on a gate frame only (issue #2823):
	 * absent from every other frame and from every run that is not a scenario
	 * load, so a reader takes it from the latest frame that carries it
	 * (`utils/liveScenario.ts`), never from the newest tick.
	 */
	scenario?: LiveScenarioProgress;
	/** Mean latency over the whole run so far, not the tick's window. */
	avg_latency_ms: number;
	bytes_sent: number;
	bytes_received: number;
	/** Dispatches per second over the whole run so far (see `current_send_rate`). */
	send_rate?: number;
	/** Completions per second over the whole run so far (see `current_rps`). */
	throughput?: number;
	backpressure?: number;
	dropped_requests?: number;
	/**
	 * Requests a `constant_rps` pacer owed beyond its catch-up window and skipped
	 * instead of bursting (issue #2911), and the schedule time they cover. Both
	 * are cumulative like `dropped_requests` and absent from a tick stored by an
	 * older engine.
	 */
	skipped_requests?: number;
	stalled_ms?: number;
	/** Mean queue wait over the whole run so far. */
	avg_queue_wait_ms?: number;
	// Run progress - feeds the iterations-mode ETA stat. requests_expected is 0
	// for open-ended modes (constant_rps), in which case ETA is not shown.
	requests_sent?: number;
	requests_expected?: number;
	// Per-tick full status-code map (e.g. { "200": 1450, "404": 5 }). Same shape
	// the live SSE and the stored time-series both carry.
	status_codes?: Record<string, number>;
	/**
	 * The responses that completed in the seconds this tick closed, by status
	 * class (issue #2866): a stored gate row, or a live gate frame (`statusSeconds`
	 * on the wire). `[]` is a gate that closed no second yet. Absent on every other
	 * live frame and on a tick stored before the engine wrote it, which is what
	 * tells the status chart to diff `status_codes` instead.
	 */
	status_seconds?: StatusSecondEntry[];
	/**
	 * The capacity search's state, on every live frame of a capacity run (issue
	 * #2928). Absent means not a capacity run, or an engine from before #2928; it
	 * is never zeroed. A stored tick never carries it. The renderer card that
	 * reads it is item 2 of #2818 (#2929); until it lands the only reader is MCP
	 * `get_live_metrics`, which forwards frames raw.
	 */
	capacity?: LiveCapacityState;
	/**
	 * Custom trends, counters and rates recorded so far, riding the same tick
	 * as the built-in phases above (issue #1500). Absent until the run has
	 * recorded at least one value - not `{}`. Same shape as
	 * `RunReport.customMetrics`, but snake_case here like every other field on
	 * this interface: the stored time-series wire shape is `custom_metrics`,
	 * and the live SSE tick's own `customMetrics` is renamed into this one by
	 * `sse-client.ts`, the same way it renames `statusCodes` into
	 * `status_codes` above.
	 */
	custom_metrics?: Record<
		string,
		{
			type: "trend" | "counter" | "rate";
			count: number;
			p50?: number;
			p95?: number;
			p99?: number;
			max?: number;
			value?: number;
		}
	>;
}

/**
 * One element's pass/fail/skip/defer tally within a load run's step, from
 * `scenario.steps[i].elements` (`StepElementTallies::build`,
 * `engine/src/core/scenario_load.cpp`) - the load-path sibling of the
 * sequential run's per-execution {@link ElementOutcome}. Aggregated across
 * every virtual user and iteration rather than one outcome per execution,
 * which is why the shape is a set of counts instead of a single `outcome`.
 *
 * `deferred` counts a post-request script (`script.post`) that the load path
 * left to the post-run replay against the sampled responses (issue #2144), so
 * its verdicts are in {@link RunReport.testValidation}, not in `passed` or
 * `failed`. It is **not** a kind of `skipped`: a script that did not run at
 * all (an un-inlined `script.pre`, a disabled element) stays `skipped`.
 * Absent from a report stored before #2144, which tallied the replayed script
 * as `skipped`; those rows keep their stored numbers.
 */
export interface RunScenarioStepElementTally {
	id: string;
	kind: string;
	passed: number;
	failed: number;
	skipped: number;
	deferred?: number;
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
	 * Of those, the ones that were errors under the run's one definition (issue
	 * #2124): a response outside 2xx/3xx, or no response at all. The sum of
	 * {@link httpErrors} and {@link noResponse}. Only a no-response step ends its
	 * iteration, so a non-zero count here does not by itself explain the steps
	 * after it running fewer times.
	 */
	errors: number;
	/**
	 * Of {@link errors}, the responses that arrived with a 4xx or 5xx. The
	 * iteration carries on to the next step. Absent from a report stored before
	 * the engine split the tally (issue #2134).
	 */
	httpErrors?: number;
	/**
	 * Of {@link errors}, the executions that got no response (a transport error,
	 * or a step never sent). These are the ones that end the iteration. Absent
	 * from a report stored before the engine split the tally (issue #2134).
	 */
	noResponse?: number;
	latency: {
		min: number;
		p50: number;
		p95: number;
		p99: number;
		max: number;
	};
	/**
	 * Executions of this step sent with a `{{token}}` composition never
	 * resolved (issue #1503) - load mode runs no residual pass, so this is
	 * counted rather than fixed. Always present on an engine that reports
	 * this field at all; 0 is an honest "none of them".
	 */
	unresolvedTokens?: number;
	/**
	 * Executions of this step whose extractors found nothing and unset their
	 * variable (issue #3053), one per extractor that missed. Absent, never `0`,
	 * when none did, and on a report stored before the engine counted them.
	 */
	extractorMisses?: number;
	/**
	 * `"skipped"` when this step carries a pre-request script: load mode
	 * never executes one (see {@link RunReport.scenario}'s sibling note),
	 * and the field says so instead of leaving the report silent about it.
	 * Absent for a step with no pre-request script.
	 */
	preRequestScript?: "skipped";
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
	/**
	 * This step's non-script elements - extractors, assertions, timers -
	 * tallied across every virtual user and iteration (issue #1495). Absent
	 * for a step with no compiled elements or none that ever ran; an element
	 * that never ran is omitted rather than listed at zero, the same
	 * "absent when nothing happened" convention {@link unresolvedTokens} and
	 * {@link tests} follow.
	 */
	elements?: RunScenarioStepElementTally[];
}

/**
 * One `control.transaction` name's percentiles (issue #1515) - a folder's
 * members summed into one latency distribution per pass, across the whole
 * run. A sibling of {@link RunScenarioStepStat}, not a member of it: a
 * transaction spans a folder, not one step.
 */
export interface RunTransactionSummary {
	/** The `name` the element's config declared. */
	name: string;
	/** Closed occurrences - one per iteration that reached the folder's last member. */
	count: number;
	errors: number;
	latency: {
		min: number;
		p50: number;
		p90: number;
		p95: number;
		p99: number;
		max: number;
	};
}

/** One assertion population of the assertion-failure budget's check (issue #2892). */
export interface AssertionPopulation {
	passed: number;
	failed: number;
}

export interface RunReport {
	/**
	 * What this run did not do (issue #1503): a request sent with an
	 * unresolved `{{token}}` because load mode runs no residual pass, a step
	 * whose pre-request script that mode never executes, a per-host connection
	 * limit raised above its setting (#2394), or requests libcurl re-sent on a
	 * new connection (#2799). Never refuses the run - a literal `{{` can be
	 * deliberate in a body - only names it, so a green run and one that quietly
	 * sent every request unauthenticated do not read the same. Absent, not
	 * empty, for a run with nothing to report.
	 */
	warnings?: Array<{
		code: string;
		message: string;
		count?: number;
		names?: string[];
		steps?: number;
		/** `per_host_limit_raised` (#2394): the setting, and the limit the run used. */
		configured?: number;
		effective?: number;
	}>;
	metadata?: {
		runId: string;
		runType: string;
		status: string;
		startTime: number;
		/** Unix ms once the run is terminal; `null` while it is pending or running. */
		endTime: number | null;
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
			 * The `thresholds` keys the app sent as carried over rather than set for
			 * this run (issue #2195), echoed as sent. Absent when none were, and for
			 * runs that predate the key.
			 */
			carriedBudgets?: string[];
			/**
			 * A `capacity` run's step length, as it was started (issue #2925), and
			 * the p99 budget it searched for the edge of. Absent on every other
			 * mode and on a capacity run that left either at its default (the
			 * effective budget is {@link RunReport.capacity}'s `sloMs`). `stepDuration`
			 * is read by `CapacitySummary` (#2927); nothing reads `sloMs` yet, and
			 * #2819 (the export's run table) is the next reader of both.
			 */
			stepDuration?: string;
			sloMs?: number;
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
			/** See {@link RunSummary.acceptEncoding} (issue #1488). */
			acceptEncoding?: boolean;
			/**
			 * Whether `Expect: 100-continue` was allowed (issue #2516). Read by the
			 * baseline comparison only, which treats an absent key as `false`; the
			 * list-row {@link RunSummary} does not carry it.
			 */
			expectContinue?: boolean;
			/**
			 * How many `data` rows the run bound (issue #993); the rows themselves
			 * are never stored. Absent for a run without a data file.
			 */
			dataRowCount?: number;
			/**
			 * The file's display name and the SHA-256 of its bytes (issue #2051).
			 * Never a path. Absent for a run without a data file, and for one
			 * recorded before the pair was.
			 */
			dataFileName?: string;
			dataFileHash?: string;
			/** Whether its numbers were read as numbers (issue #2540); absent means read as text. */
			dataFileCastNumbers?: boolean;
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
		/** Errors by the one definition (issue #2124): `httpErrorRequests + noResponseRequests`. */
		failedRequests: number;
		/** The part of `failedRequests` that got a response. Absent from an engine older than #2124. */
		httpErrorRequests?: number;
		/** The part of `failedRequests` that got none (status code 0). Absent from an engine older than #2124. */
		noResponseRequests?: number;
		/**
		 * Requests a user's Stop cancelled before they were answered (issue #2136).
		 * Not an error and in no other count: outside `totalRequests`, the
		 * status-code distribution and `errorRate`. Absent from an engine older
		 * than #2136; absent means none.
		 */
		cancelledRequests?: number;
		errorRate: number;
		totalDurationSeconds: number;
		avgRps: number;
		/** Requests sent over `sendingDurationSeconds`, not over the drain (#2392). */
		sendRate?: number;
		/** Completions over the whole `testDuration`, including the end-of-run drain. */
		throughput?: number;
		backpressure?: number;
		/** Load start to the last request settling: includes the drain. */
		testDuration?: number;
		/**
		 * Load start to the moment the run stopped submitting, before the drain
		 * (#2392). Absent from a run stored by an older engine, whose `sendRate`
		 * divided by `testDuration`.
		 */
		sendingDurationSeconds?: number;
		/**
		 * Completions counted at the moment sending ended, before the drain
		 * (#2882): over `sendingDurationSeconds` it is a received rate on the
		 * window `sendRate` uses. 0 is a measurement. Absent from a run stored by
		 * an older engine.
		 */
		completedWhileSending?: number;
		/**
		 * Seconds from the run's entry to load start, including the
		 * `script.setup` script. Absent from a run stored before the engine
		 * split it from `cleanupOverhead`: that run's figure is the teardown
		 * time, so it must never be read as a setup time.
		 */
		setupOverhead?: number;
		/** Seconds from load end to teardown finished. Present on a stored load run; a collection run has none (#2822). */
		cleanupOverhead?: number;
		/** Absent where not recorded: `partial` or `summaryMissing` below, or a collection run (#2963). */
		peakConcurrency?: number;
		/** Mean requests on the wire over `testDuration`; absent from a run stored before it (#2821). */
		avgInFlight?: number;
		droppedRequests?: number;
		/**
		 * `constant_rps` only (issue #2911): requests skipped after a generator
		 * stall, and the schedule time they cover in milliseconds. Absent from a run
		 * stored before the engine counted them, which reads as none.
		 */
		skippedRequests?: number;
		stalledMs?: number;
		/** Absent where not recorded: `partial` or `summaryMissing` below, or a collection run (#2963). */
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
		/**
		 * Requests libcurl re-sent on a new connection after the server dropped
		 * or refused a reused one before answering (#2799). Each is counted once
		 * in `totalRequests`, so the target received `totalRequests` plus this.
		 * The `connection_replayed` entry in `warnings` is the surface the app
		 * shows (its message carries the count); the number itself is for MCP
		 * and export readers.
		 *
		 * Unlike `httpVersionDowngraded`, absent and `0` differ: `0` is a run
		 * that counted and saw none, absent is a run stored before the count
		 * existed, or reported from its sampled results.
		 */
		connectionReplays?: number;
		/**
		 * A failed load run reconciled after an engine crash (#2895). The counts,
		 * `errorRate`, `statusCodes`, `avgRps`, duration and bytes are the last
		 * persisted tick's totals, so they are a floor and not the final figures;
		 * the report carries no `latency`, `peakConcurrency` or `avgQueueWaitMs`:
		 * absent, not recorded (#2963). Absent means false.
		 */
		partial?: boolean;
		/**
		 * A Failed load run that has no summary at all (#2895): a crash before the
		 * first tick, or a worker failure that never wrote one. The counts are
		 * whatever the stored sampled results hold (0 where none were stored), not
		 * whole-run totals, and none is a measurement; the report carries no
		 * `latency`, `peakConcurrency` or `avgQueueWaitMs`. Absent means false.
		 * Distinct from the report's top-level `partial`, which means the run is
		 * still in flight.
		 */
		summaryMissing?: boolean;
	};
	/**
	 * Absent for a run whose latency was never recorded: one with
	 * `summary.partial` or `summary.summaryMissing`, or a collection run in which
	 * no step sent. Absent is not zero; print it through `formatLatencyOrDash`.
	 */
	latency?: {
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
		/** Requests sent over the sending window (#2392). */
		actualRps: number;
		/** Percent: `requestsSent / requestsExpected`, or the stored formula on an older run. */
		achievement: number;
		/** Run totals behind `achievement`; absent from a run stored before #2392. */
		requestsSent?: number;
		requestsExpected?: number;
	};
	/**
	 * Two independent halves, either of which can be present without the other.
	 *
	 * `phases` comes from histograms fed by **every** completion, and is absent
	 * only when the engine's `phaseHistograms` setting was off, nothing
	 * succeeded, or the run predates the bank. The `avg*` fields are the means
	 * of those histograms (issue #2782), so they average the same completions;
	 * without `phases`, or for a run stored before the means existed, they are
	 * means over the **retained trace sample** (the 1-in-N successes
	 * `save_timing_breakdown` stores, plus any slow-request outliers) and are
	 * absent for a run that stored no traces.
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
		/** Every completion past the threshold, counted exactly (#2399). */
		count: number;
		thresholdMs: number;
		/** How many of them were kept as sample traces; capped, so it can be below `count`. */
		tracesStored: number;
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
			/** Absent when `evaluated` is false - there is no measurement to show. */
			actual?: number;
			passed: boolean;
			/**
			 * False when the run recorded no sample for this metric (issue #1484:
			 * a latency percentile with zero completions used to read as 0ms,
			 * trivially meeting an "at most" ceiling). Absent on a report a
			 * pre-fix engine wrote, which never carried the field and never had
			 * the bug's blind spot corrected either - reads as evaluated, the
			 * same value that engine effectively assumed everywhere.
			 */
			evaluated?: boolean;
			/**
			 * `maxAssertionFailureRatePct` only (issue #2892): the budget judges the
			 * worse of two populations, and an evaluated check names both. `Exact`
			 * is every `assert.*` outcome, unmatched required `extract.*` and inline
			 * `pm.test` call; `Sampled` is the deferred `pm.test` replay over 1 in
			 * `sampleRate` responses. Absent on a report a pre-#2892 engine wrote
			 * (its `actual` is the old blended rate) and on an unevaluated check.
			 */
			assertionsExact?: AssertionPopulation;
			assertionsSampled?: AssertionPopulation;
			/** Keep 1 in N; present only when `assertionsSampled` is non-empty. */
			sampleRate?: number;
		}[];
		passed: number;
		failed: number;
		verdict: "passed" | "failed";
	};
	/**
	 * Custom trends, counters and rates the run recorded through a
	 * `metric.record` element or `pm.metrics.trend` / `.counter` / `.rate`
	 * (issue #1500). Keyed by the name the script or element chose, which is
	 * why the key set is open - there is no fixed label table the way
	 * `thresholdValidation.checks[].metric` has one.
	 *
	 * `undefined`, never `{}`, when the run recorded no custom metric - the
	 * same "absent means never happened" convention `thresholdValidation`
	 * follows. For `type: "trend"` the percentile fields are present; for
	 * `type: "counter"` (a running total) or `type: "rate"` (0-100 percent
	 * true) only `value` is.
	 */
	customMetrics?: Record<
		string,
		{
			type: "trend" | "counter" | "rate";
			count: number;
			p50?: number;
			p95?: number;
			p99?: number;
			max?: number;
			value?: number;
		}
	>;
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
	 * `script.setup` / `script.teardown` outcomes (issue #1499): what ran once
	 * at `run.start` / `run.end` on the collection itself, never per step.
	 *
	 * Each key is present only when that phase ran at least one element - an
	 * empty array would read as "a setup element ran and did nothing" rather
	 * than "this collection declared none". `undefined` for a run whose
	 * collection declared neither, and for a single-request run, which has no
	 * collection to declare them on.
	 */
	lifecycle?: {
		setup?: ElementOutcome[];
		teardown?: ElementOutcome[];
	};
	/**
	 * A single-request run's own step-level element outcomes (issues #1594,
	 * #1641) - extractors, assertions, timers tallied across every submission,
	 * the single-request sibling of {@link RunScenarioStepStat.elements}.
	 *
	 * `undefined` for a scenario run (its per-step tallies live nested under
	 * {@link RunReport.scenario} instead - the two never coexist) and for a
	 * single-request run that declared no `requestElements`, or one whose
	 * elements never ran. Reuses {@link RunScenarioStepElementTally}: both
	 * come off the same `{id, kind, passed, failed, skipped, deferred}` tally shape.
	 */
	elements?: RunScenarioStepElementTally[];
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
	 * capacity) and `knee*` when the search ended for a reason other than the
	 * target giving out on latency (`slo_exceeded`) or errors
	 * (`errors_exceeded`), so neither can be read as a measured zero.
	 * `saturation*` is the lowest healthy level whose throughput was within the
	 * plateau gain of the best healthy throughput, sent only when `stopReason`
	 * is `plateau`; a plateau stored before the engine reported it carries none,
	 * and its `maxHealthy*` is then the last level tried, which overshoots where
	 * throughput stopped growing. The error
	 * share (`maxErrorPct`, `kneeErrorPct`, `levels[].errorPct`, percent 0-100)
	 * is absent for a run stored by an engine that did not judge errors, which
	 * is not the claim "every level was clean". `stopReason` is typed
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
		saturationConcurrency?: number;
		saturationRps?: number;
		saturationP99Ms?: number;
		/** The error limit, in percent, that the levels were judged against. */
		maxErrorPct?: number;
		kneeErrorPct?: number;
		levels: {
			concurrency: number;
			rps: number;
			p99Ms: number;
			errorPct?: number;
			samples?: number;
		}[];
	};
	/**
	 * How many records each of the run's bounded stores thinned away.
	 *
	 * Every store the engine keeps is capped, so a long run retains a *sample*
	 * rather than the whole set - and past the cap a later record displaces a
	 * uniformly chosen incumbent (reservoir retention), so what survives
	 * describes the whole run rather than its opening. These counts are what
	 * make that visible: all zeros means the stored traces and the tested
	 * responses are complete, non-zero means they are a sample of a larger set.
	 *
	 * They describe those stores, not the `results` array: the report route
	 * picks its rows from the stored traces by a failures-first rule, and says
	 * so through {@link RunReport.resultsStored} / {@link RunReport.resultsCap}.
	 *
	 * `undefined` is a run whose stored summary predates the counts (or an older
	 * sidecar), which is *not* the same claim as "nothing was dropped" - so the
	 * UI stays silent rather than asserting completeness it cannot verify.
	 */
	sampling?: {
		/**
		 * Errors past the error store's cap (`maxStoredErrors`): counted in every
		 * total, but with no stored record. On a run stored before the engine
		 * kept exact per-type counts, and on a design-mode collection run,
		 * `errors.types` is built from the stored records, so this is how many
		 * errors it did not see. On any other run `errors.types` is exact and a
		 * non-zero figure costs it nothing - compare its sum with the no-response
		 * count before calling the breakdown partial (`ErrorSummary`).
		 */
		errorsDropped: number;
		/** Sampled timing traces displaced or dropped (`max_success_results`). */
		successTracesDropped: number;
		/** Slow-request traces displaced or dropped (`max_slow_results`). */
		slowTracesDropped: number;
		/** Responses displaced or dropped before test validation ran. */
		responseSamplesDropped: number;
		/**
		 * Whether the run's response-sample **byte** budget
		 * (`max_response_sample_bytes`) ended a sample. The count above cannot
		 * say it: the store is bounded twice and both bounds report through it,
		 * but only this one costs the tested set its uniformity - the count cap
		 * displaces an incumbent, while a spent byte budget stops admitting, so
		 * the run is graded on the part of it whose bodies fit.
		 *
		 * `undefined` is a run recorded before the marker existed, which is not
		 * the same claim as `false` - see `SampleRetentionNote`.
		 */
		responseSampleBudgetSpent?: boolean;
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
		/**
		 * Iterations the run was asked for; on a load run, the ones it started.
		 * `iterationsCompleted` and `iterationsAbandoned` do not add up to it when
		 * the deadline or a Stop cut iterations off, and the difference is that term
		 * (the Steps tab's "Iterations cut short").
		 */
		iterations: number;
		/** Iterations that finished - fewer when the run was stopped or errored. */
		iterationsCompleted: number;
		/** Step executions the run performed, whether or not their rows survived. */
		stepsExecuted: number;
		/**
		 * The four outcomes below are disjoint and sum to `stepsExecuted` on both
		 * run kinds (#2824). A load run counts them per step execution under the
		 * collection run's definition; engine 0.45.0 and earlier stored the old
		 * load meaning (`failed` was the steps' `httpErrors`, and `passed` still
		 * held the skipped steps).
		 */
		passed: number;
		/**
		 * Step executions whose response arrived and in which an assertion did not
		 * hold. A 4xx or 5xx no assertion rejected is `passed`; the steps'
		 * `httpErrors` and `summary.failedRequests` count it.
		 */
		failed: number;
		/** Steps a controller or `pm.execution.skipRequest()` stopped before the wire. */
		skipped: number;
		/**
		 * Step executions that got no response, whose script threw (#2947) or that
		 * set a jump the run could not honour (#2974), on both run kinds. On a load
		 * run a thrown script does not end its iteration, so there it is not the
		 * sum of the steps' `noResponse`: `iterationsAbandoned` is the abort count.
		 */
		errored: number;
		/**
		 * A scenario *load* run's exact assertion population (#2820): every
		 * `assert.*` outcome, required `extract.*` miss and inline `pm.test` call,
		 * counted on each completion. Not folded into `passed`, `failed` or the
		 * report's error rate, which stay HTTP-only, so a run whose every assertion
		 * failed against `200`s reads a 0% error rate and a non-zero
		 * `assertions.failed`. The sampled replay of an un-inlined script is
		 * `testValidation`, a different population.
		 *
		 * Absent, never `{0, 0}`, for a run that made none, a collection run and a
		 * report stored before the field. Read it through `exactAssertionsOf`.
		 */
		assertions?: { passed: number; failed: number };
		/** Step rows the run kept - the length `results[]` should have. */
		stepsStored: number;
		stepsDropped: number;
		/**
		 * Plan positions errors cost a collection run (issue #2526): for every
		 * iteration an `errored` step ended, the positions after it the iteration
		 * had not attempted. A run that executed fewer steps than its plan holds
		 * says so here, rather than reading as a complete run with an error in it.
		 *
		 * Collection runs only, and absent - not `0` - on a load report and on one
		 * stored before the field existed, so absent says nothing either way.
		 */
		stepsNotRun?: number;
		/**
		 * The run's own `stopOnError`, echoed because the same counts describe a
		 * different run under it (issue #2526). Absent on the same reports
		 * `stepsNotRun` is.
		 */
		stopOnError?: boolean;
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
		 * Iterations a step with no response ended before the plan's last step
		 * (an HTTP error status does not end one). Counted
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
		/**
		 * Every `control.transaction` name that closed at least once this run
		 * (issue #1515), a sibling of `steps` rather than a member of it - a
		 * transaction spans a folder, not one step. Absent, never `[]`, for a
		 * run with no such element or one whose folder never closed.
		 */
		transactions?: RunTransactionSummary[];
	};
	/**
	 * Rows the run stored, before the report's cap. Beside `results` rather
	 * than inside `sampling` because that section is optional. Absent on a
	 * report from an engine that predates it (#2210), which is not the same
	 * claim as "nothing was cut" - the UI says nothing then.
	 */
	resultsStored?: number;
	/**
	 * The cap the report applied to `results`: 100 for a single-request run,
	 * equal to {@link RunReport.resultsStored} for a scenario run.
	 * `resultsStored > resultsCap` is the only signal that `results` is a
	 * selection and not the whole stored set.
	 *
	 * That selection is failures first (every row outside 2xx/3xx, including
	 * a status `0` transport failure, takes a slot before any success), the
	 * successes filling the rest, and the chosen rows are listed by
	 * `timestamp` - not a uniform sample of the run.
	 */
	resultsCap?: number;
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

/**
 * What the engine's startup did about a database it could not open (issue
 * #922).
 *
 * Every outcome but `restored_from_backup` is data loss - the workspace the
 * user comes back to is empty. What separates them is what is left to salvage:
 *
 * - `restored_from_backup` - the `<db>.bak` beside it passed the same
 *   validation and was restored over it. Only what was saved since that backup
 *   was taken is gone.
 * - `started_fresh_quarantined` - nothing restored it (there was no backup), so
 *   it was moved aside and a fresh one created (issue #984).
 * - `backup_also_corrupt` - there *was* a backup and it failed the same
 *   validation, so it was left untouched rather than written over the original.
 * - `deleted_corrupt` - it was **deleted**. Written by engines before #984, and
 *   still by one whose quarantine rename failed; there is nothing to recover.
 *
 * The first three leave the bytes on disk, and `quarantinedPath` says where.
 */
export interface EngineRecovery {
	outcome:
		| "restored_from_backup"
		| "deleted_corrupt"
		| "backup_also_corrupt"
		| "started_fresh_quarantined";
	/** Epoch milliseconds, as every engine timestamp is. */
	at: number;
	/** The database file the outcome happened to - the data directory, in effect. */
	databasePath: string;
	/**
	 * Where the unopenable database was moved to, when it was moved rather than
	 * deleted - the file `sqlite3 <path> .recover` reads.
	 *
	 * Absent for a `deleted_corrupt` marker and for any written by an engine
	 * that predates the quarantine, so it is tested for rather than derived
	 * from `outcome`.
	 */
	quarantinedPath?: string;
}

export interface EngineHealth {
	status: "ok";
	version: string;
	/** The `workers` setting's effective value: the configured count, or the
	 *  detected core count when nothing overrides it. */
	workers: number;
	/**
	 * Absent on a clean start, which is the ordinary case and the one a genuine
	 * first run gives. Present only when this engine startup restored or deleted
	 * the database - see `EngineRecovery`.
	 */
	recovery?: EngineRecovery;
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
	/**
	 * The key of a boolean entry in the same category this one means nothing
	 * without (`correlationIdHeader` names `correlationIdEnabled`). Absent when
	 * the entry stands on its own; `SettingsMain` nests a dependent immediately
	 * under its parent, indented and disabled while the parent reads `"false"`.
	 * A catalogue fact only - never sent back on `POST /config`.
	 */
	dependsOn?: string;
}

/** Client-side settings panels (localStorage-backed prefs, rendered by app panels). */
export type ClientSettingsCategory =
	| "appearance"
	| "editor"
	| "dashboard"
	| "load-testing"
	| "notifications"
	| "general"
	| "shortcuts"
	| "mcp"
	| "files";

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
	/** Hard ceiling on `maxResponseSamples`, the response bodies a load run keeps. */
	maxResponseSamples: number;
	/** When false (default), collection/environment write tools are disabled. */
	allowWrites: boolean;
	/**
	 * When false (default), `update_engine_config` refuses the `proxy*` keys and
	 * `customCaCertificates` even with writes on.
	 */
	allowNetworkSettings: boolean;
	/**
	 * When false (default), MCP reads withhold secret variables, auth
	 * credentials, cookie values and proxy URL credentials.
	 */
	revealSecretsToAgents: boolean;
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

/**
 * Why an enabled server is not listening. Mirrors `McpStartError` in
 * `electron/mcp/status.ts`, pinned by `electron/mcp/status.conformance.test.ts`.
 */
export interface McpStartError {
	/** `EADDRINUSE`: another program holds the port. `EACCES`: the OS refused the bind. */
	code: "EADDRINUSE" | "EACCES" | "other";
	message: string;
}

export interface McpStatus {
	running: boolean;
	/** The configured endpoint while not running: it names the port, it is not usable. */
	url: string;
	/** Whether the MCP server is enabled (may be enabled-but-not-running on error). */
	enabled: boolean;
	/** Set while the server is enabled and its last start failed. */
	error?: McpStartError;
	/**
	 * Absolute path of the copy of an unreadable `mcp-config.json` that the first
	 * Settings change set aside. Absent when the file was readable.
	 */
	corruptCopy?: string;
}

/** Clients Vayu can register itself with via their own CLI (one-click connect). */
export type McpConnectClient = "claude" | "vscode";

export interface McpConnectResult {
	ok: boolean;
	/**
	 * "cli-not-found" → the client's CLI isn't installed; fall back to the snippet.
	 * "not-running" → the server has no listener, so there is no endpoint to register.
	 */
	reason?: "cli-not-found" | "error" | "unsupported" | "not-running";
	message?: string;
}

/**
 * A data family an MCP call can change. Mirrors `MCP_DATA_ENTITIES` in
 * `electron/mcp/tools/contract.ts` - the main process owns the list, and
 * production code there cannot import from here (see `tsconfig.node.json`), so
 * the duplication is deliberate and pinned by
 * `electron/mcp/data-changed.conformance.test.ts`.
 */
export type McpDataEntity =
	/** Collections, and anything under them: request lists, trash, compositions. */
	| "collection"
	/** One collection row and nothing under it: a create, an update, an unbind. */
	| "collectionRow"
	| "request"
	/** Environments and the globals beside them, and the trash an environment delete adds to. */
	| "environment"
	| "run"
	| "cookie"
	| "config"
	/** Engine-hosted local services: webhook inboxes, mock servers and mock issuers. */
	| "service"
	/** The engine's OAuth 2.0 token cache - fetched, refreshed or cleared. */
	| "oauth"
	/** The client-certificate registry: what a trash restore puts an entry back into. */
	| "clientCertificate"
	/** Variables a script or extractor saved back during a run: environment, globals, collection. */
	| "variables";

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
	/**
	 * The run this call just started, and which run service watches it (#1419).
	 *
	 * The one field here that is not a scope hint: it says the run is *live*, and
	 * `useRunWatchers` reads it to attach the matching service's stream to a run
	 * no surface of this app started - which is what gives an agent's run the OS
	 * progress indicator, the keep-awake hold and the finished notification it
	 * would otherwise only get once its dashboard tab was opened.
	 *
	 * Present on the `run` event of `start_load_run` and `run_collection` and on
	 * no other: the remaining `run` tools name a run that already exists.
	 */
	startedRun?: StartedRun;
}

/**
 * A run an MCP call put in flight, named for the renderer that watches it.
 *
 * `kind` is which service owns the stream: a load run and a collection run
 * publish different frames, so attaching the wrong one is a permanently empty
 * view rather than a degraded one.
 */
export interface StartedRun {
	runId: string;
	kind: "load" | "collection";
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
	/**
	 * Snippet metadata, present only on the template entries (`kind` 28).
	 *
	 * `context` is which script kind the template belongs in, so the snippets
	 * surface under a pre-request editor never offers a `pm.response` template;
	 * `group` is the heading it is listed under. Both are the engine's to say -
	 * the completion table is the single source for what the editor advertises,
	 * and a second list in the renderer is how the two come to disagree.
	 */
	context?: ScriptSnippetContext;
	group?: string;
}

/** Which script kind a snippet template belongs in. */
export type ScriptSnippetContext = "pre" | "test" | "both";

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
