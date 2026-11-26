/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Core Domain Types

/**
 * Re-exported for `Request.httpVersion`; derived from `HTTP_VERSIONS`, the Settings picker's list.
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
	| "mcp"
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
 * A header row a setting wrote (body mode's `Content-Type`, Event stream's `Accept`), marked on the
 * row so the setting still tells it from a typed one after a reload (#1481).
 */
export type AutoHeaderSource = "body-mode" | "stream";

/**
 * `"legacy-default"`: disabled, not deleted, by the engine's header-strip repair as a pre-#1229
 * client's `X-Vayu-Version`, `X-Request-ID` or `User-Agent`; re-enable a wrong match (#1491).
 */
export type HeaderRowSource = AutoHeaderSource | "legacy-default";

/**
 * The setting that wrote `Request.method` and still owns it (#1505), `AutoHeaderSource`'s rule:
 * GraphQL sets `POST` on a fresh `GET`; a hand pick or leaving GraphQL clears it.
 */
export type MethodSource = "graphql";

/** Which saved example a mock server answers with (issue #481 phase 3). */
export type MockResponseMode = "first" | "fixed" | "random";

/** A header, param or form row. Disabled rows are stored, not sent; duplicate keys are allowed. */
export interface KeyValueEntry {
	key: string;
	value: string;
	enabled: boolean;
	description?: string;
	/** Present only on a row an app setting or the engine's own repair pass wrote; absent on one the user typed. */
	source?: HeaderRowSource;
	/**
	 * Where a params row goes (#1764); absent is `"query"`. A `"path"` row fills the URL's `:key`
	 * segment at compose time and never reaches the query. Meaningless on other rows.
	 */
	in?: ParamLocation;
	/**
	 * A query row with no value at all, sent as bare `key` where `value: ""` sends `key=`
	 * (Postman's `null`, #1772). Only while `value` is empty; editing clears it. Query rows only.
	 */
	valueless?: true;
}

/** See {@link KeyValueEntry.in}. */
export type ParamLocation = "query" | "path";

/**
 * `secret` only masks in the UI: values are not encrypted at rest. `type` affects rendering and
 * validation only; values are stored as strings.
 */
export interface VariableValue {
	value: string;
	enabled: boolean;
	secret?: boolean;
	type?: "string" | "number" | "boolean" | "json";
	createdAt?: number;
}

/**
 * A `form-data` part: text, or a file at `src` the engine reads at send time (no bytes stored).
 * `fileName`/`contentType` override the part's own; absent, libcurl derives them from the path. A
 * text part has a type only if `contentType` is set (#2539). `unresolved` is read-only, the
 * engine's would-refuse answer the editor warns on, never sent (`lib/file-trust.ts`).
 */
export interface FormFieldEntry extends KeyValueEntry {
	type?: "text" | "file";
	src?: string;
	fileName?: string;
	contentType?: string;
	unresolved?: boolean;
}

/**
 * A `binary` body's file: an absolute path the engine reads at send time. `unresolved` as on a form
 * part: `true` when outside every `FileRoot` and not picked here; a pick sets `false` until the
 * next read; never sent (`lib/file-trust.ts`).
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
 * The tool an `mcp` body's `tools/call` names (#3762). The engine sends each argument an
 * `x-mcp-header` in `inputSchema` marks as an `Mcp-Param-*` header; `name` must be non-empty and
 * `inputSchema` an object, or the write is refused.
 */
export interface McpTool {
	name: string;
	inputSchema?: Record<string, unknown>;
	/**
	 * `tools/list`'s schema for `structuredContent`. Stored, never read by the engine; the builder
	 * prefills an `assert.jsonschema` element from it (#3806).
	 */
	outputSchema?: Record<string, unknown>;
}

export type RequestBody =
	| { mode: "none" }
	| { mode: "json" | "text" | "graphql" | "jsonrpc" | "xml"; content: string }
	| { mode: "mcp"; content: string; mcpTool?: McpTool }
	| { mode: "form-data"; fields: FormFieldEntry[] }
	| { mode: "x-www-form-urlencoded"; fields: KeyValueEntry[] }
	| { mode: "binary"; file: FileRef };

export type OAuth2GrantType =
	"authorization_code" | "client_credentials" | "password" | "jwt_bearer";

/** Where a token or refresh request carries an {@link OAuth2ParamRow}. */
export type OAuth2ParamSendAs = "body" | "url" | "header";

/**
 * An extra OAuth 2.0 request parameter (#2536): Auth0's `audience`, Azure AD's `resource`,
 * `acr_values`. Absent `enabled` is enabled, absent `sendAs` is `body`; the authorize request
 * ignores both and puts every row in its URL query. The engine keys the token cache by the rows.
 */
export interface OAuth2ParamRow {
	key: string;
	value: string;
	enabled?: boolean;
	sendAs?: OAuth2ParamSendAs;
}

/**
 * An extra `jwt_bearer` claim (RFC 7523, #3632); absent `enabled` is enabled. A row named `iss`,
 * `sub`, `aud`, `exp` or `iat` is never sent: the engine writes those.
 */
export interface OAuth2ClaimRow {
	key: string;
	value: string;
	enabled?: boolean;
}

/**
 * String fields may hold `{{variables}}`, resolved app-side before the engine sees the config. No
 * `state`: it is generated per authorization attempt.
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
	/** `jwt_bearer`: the assertion's `sub`; `clientId` is its `iss`. */
	subject?: string;
	/** `jwt_bearer`: the assertion's `aud`, which is not the `audience` form parameter. */
	assertionAudience?: string;
	/** `jwt_bearer`: extra claims beside the five the engine writes. */
	assertionClaims?: OAuth2ClaimRow[];
	/** `jwt_bearer`: `exp - iat`, 1 to 3600, default 180. */
	assertionLifetimeSeconds?: number;
	/** `jwt_bearer`: default RS256. */
	signingAlgorithm?: "RS256" | "ES256";
	/** `jwt_bearer`: the JWT header's `kid`, omitted when empty. */
	keyId?: string;
	/** `jwt_bearer`: exactly one `{{variable}}` naming a secret holding the PEM, resolved only by the engine; exactly one of this and `privateKeyFile`. */
	privateKey?: string;
	/** `jwt_bearer`: a key file the engine reads at token time. */
	privateKeyFile?: string;
	/** Seconds a token that states no `expires_in` is kept for; absent or 0 keeps it until replaced. */
	fallbackExpiresIn?: number;
	/**
	 * `authorization_code`: the OAuth-protected MCP server whose authorization server a sign-in
	 * discovers (#3766); only blank members are filled. `""` is discovery on with no URL yet.
	 */
	discoverUrl?: string;
	/** The members a sign-in's discovery wrote, which the form shows read-only and Discover again clears. */
	discoveredFields?: OAuth2DiscoveredField[];
}

/** The config members discovery can fill (the engine's `resolved` minus `issuer`). */
export type OAuth2DiscoveredField =
	"authorizationUrl" | "accessTokenUrl" | "clientId" | "resource" | "scope";

/**
 * `inherit` walks the parent collections at send time; a collection never uses it. On a collection,
 * `none` is "nothing set" (the walk steps past) and `noauth` is "send nothing" (it stops), as in
 * Postman; merging them leaks a parent's token into an imported No Auth folder (#195). Walkers:
 * `resolveAuthSource` and the engine's `resolve_inherited_auth` (`POST /compose`, so MCP). On a
 * request the two coincide, so only collections offer `noauth`.
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
 * The columns a collection's run data file should carry (#599), so `{{data.*}}` and
 * `pm.iterationData` can be checked while authoring. The file's rows are stored nowhere (user data
 * of unknown sensitivity). `{}` declares no contract and is the engine's default.
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
 * The OpenAPI document a collection binds (#637, phase 1 of #625), by id: the document is a
 * top-level `/specs` resource several collections may share. `specHash` is the version last synced
 * to, which makes drift detectable; a bound run is stamped with both. `{}` is unbound, the engine's
 * default.
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
 * Where a file-sourced spec was picked (#638); a URL spec's origin is `spec_documents.source_url`.
 * On the engine row (#2765), so a backup carries it; restored elsewhere, the path may not exist. A
 * stored path grants nothing: main reads only files the user picked (`electron/file-grants.ts`).
 */
export interface SpecFileLocation {
	/** Absolute path, obtained from the preload `getFilePath` bridge at pick time. */
	path: string;
	/** The file's own name, which is what the Spec tab shows as the source. */
	fileName: string;
}

/**
 * Where the data file was picked (#599), re-read by a run, the Data tab and Send-with-row. On the
 * engine row like {@link SpecFileLocation}; the rows are stored nowhere.
 */
export interface DataFileLocation {
	/** Absolute path, obtained from the preload `getFilePath` bridge at pick time. */
	path: string;
	/** The file's own name, for a message about a file that has since moved. */
	fileName: string;
	/** SHA-256 of the bytes as last read (#2051), a run's `dataFileHash`; absent before a read. */
	hash?: string;
	/**
	 * Read this CSV/TSV's unquoted numbers as numbers (#2540): a fact of this file, so a new pick
	 * starts it off (absent is off), and every re-read uses it so a run sends what the preview
	 * showed.
	 */
	castNumbers?: boolean;
}

/**
 * A declared-operation index row stored beside a spec document (#629), so coverage needs no per-run
 * re-read. Engine-derived from the stored bytes, never client-supplied (#853). `responses` keeps
 * patterns verbatim, in order: `"200"`, `"4XX"`, `"default"` are distinct promises, and expanding a
 * range would report a contract never written.
 */
export interface DeclaredOperation {
	operationId?: string;
	method: string;
	path: string;
	responses: string[];
}

/**
 * A declared response schema by status pattern (verbatim, as in `DeclaredOperation.responses`) and
 * media type (#628). `schema` is JSON Schema translated from OpenAPI's dialect on store
 * (`core/openapi_document.hpp`, #860), possibly `true`/`false`. A status with no schema is a row
 * with `contentType: ""` and no `schema` (#3028).
 */
export interface DeclaredResponseSchema {
	status: string;
	contentType: string;
	schema?: unknown;
}

/**
 * A document's response schemas (#628). `refRoots` holds `components` / `definitions` /
 * `x-vayu-bundled` once and schemas keep their `$ref`s; the engine merges them to validate.
 * Inlining would copy a shared schema everywhere, and a recursive one has no finite expansion.
 */
export interface ResponseSchemaIndex {
	refRoots?: Record<string, unknown>;
	operations: (SpecOperation & { responses: DeclaredResponseSchema[] })[];
}

/**
 * Why a response was not checked (#628): a code, since the app owns the wording. An unbound
 * collection gets no verdict at all, not one of these: "not judged" is not "could not read".
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
 * One response checked against its schema (#628). `checked: false` has a `reason` and no `valid`,
 * so an unchecked response cannot render as a failure. Non-empty `unevaluatedKeywords` (keywords
 * the validator could not evaluate) means a `valid: true` beside it is narrower than it looks.
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
 * An operation's coverage row (#629). `declaredHit`/`declaredMissed` partition its status patterns;
 * `undeclaredSeen` is statuses matching none (a finding, not a miss). A status matches its most
 * specific pattern, so `200` + `2XX` declared and only 200 seen reports `2XX` missed.
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
	 * Distinct statuses in neither list, dropped by the per-row cap; absent when both are complete.
	 * Counted across both lists (#786): `undeclaredSeen` repeats `statusesSeen` codes.
	 */
	statusesTruncated?: number;
}

/**
 * A run's contract coverage (#629); see {@link RunReport.coverage}. The four rollups stay plain so
 * a CLI gate (#473) can threshold on them, as on `thresholdValidation`'s counts.
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
 * A load run's sampled responses against its contract (#682); presence:
 * {@link RunReport.schemaValidation}. Unlike {@link RunCoverage} it checks the stored reservoir,
 * not every send, so `failed: 0` means no *sampled* response failed. `uncheckedReasons` accounts
 * for `sampled - checked`; `unevaluated` passed every check that ran but had a keyword the draft-07
 * validator cannot evaluate.
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
	 * `sampled` is the whole population (#681): a collection run checks every executed step. A load
	 * run omits it; absent reads as sampled, the safe reading for a report from an older engine.
	 */
	exact?: boolean;
	/**
	 * Whether a schema failure could fail its step (collection runs; the Run dialog sets it). Shown
	 * by `SampledSchemaValidation`: the step list's failure count depends on it (#720).
	 */
	failOnSchemaError?: boolean;
}

/**
 * Which operation of the bound spec a request is (#637). `path` is the templated path
 * (`/pets/{petId}`), never the sent URL: it is the identity a re-fetch diffs against, and resolved
 * variables would break the match. `operationId` is optional because OpenAPI allows none.
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
	 * This collection's own elements (#1512), run in order at fixed phases of every step beneath
	 * it; a request sees these plus its ancestors', resolved by the engine
	 * (`InheritedElementsNotice`).
	 */
	elements: ElementDef[];
	/**
	 * Absent and `{}` both mean no contract; test with {@link hasDataContract} (a cleared contract
	 * is `{}`). Always set off the wire; optional only for fixtures and partials.
	 */
	dataSchema?: CollectionDataSchema;
	/**
	 * Absent and `{}` both mean unbound; test with {@link hasSpecBinding} (an unbind stores `{}`).
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

/** Tests `specId`: unbind stores `{}`, and a `syncedAt` alone is a half-written binding. */
export function hasSpecBinding(binding: CollectionOpenApiBinding | undefined): boolean {
	return !!binding?.specId;
}

/**
 * The contract that answers for a request and who declared it (#600). A contract binds every
 * request beneath its collection, so scope is a chain walk (`lib/data-contract.ts`; the rule is in
 * `docs/app/variable-resolution.md`). The declarer travels along: an amber token in a
 * sub-collection is actionable only if the tooltip names the collection whose Data tab fixes it.
 */
export interface DataContractScope {
	/** The declaring collection's name (an ancestor or the leaf): every consumer displays it. */
	collectionName: string;
	/**
	 * The declarer's id (#601): Send-with-row reads its bound data file, as often an ancestor's.
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
	 * Read only to rank an `order` tie across kinds, so a one-kind list sorts the same without it.
	 * A mixed list sets it on every row; `childrenOf` (`modules/collections/tree-children.ts`) is
	 * it.
	 */
	kind?: TreeRowKind;
	order?: number;
	createdAt?: string;
	id?: string;
}

/** Rank on an `order` tie: a sub-folder sorts before a request. */
const KIND_RANK: Record<TreeRowKind, number> = { collection: 0, request: 1 };

/**
 * The one ordering rule for collections and requests: `order`, then kind (sub-folder first),
 * `createdAt`, then id. Sub-folders and requests share one `order` space (#2535). It must equal the
 * engine's (`db/sibling_order.hpp`; pinned by `tree-order-conformance.json`, #360) so a run
 * executes in the order the sidebar shows, never by a rowid `INSERT OR REPLACE` reassigns. Kind
 * before `createdAt`: pre-shared-space workspaces tie both kinds at `0`, folders first. `createdAt`
 * before id: requests from before explicit orders all sit at `0`. `<`, not `localeCompare`: the
 * engine's tiebreak is SQLite's byte-wise BINARY ("Row-A" vs "row-a").
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
 * A request's script part as a run recorded it before elements replaced parts (#1514), with its
 * origin; read only from such snapshots (`modules/history/main/design-run-seed.ts`).
 */
export interface ScriptPart {
	origin: "collection" | "request";
	id?: string;
	/** Collection name, for showing the user where a part came from. */
	name?: string;
	script: string;
}

/**
 * One property of an {@link ElementConfigSchema}: a scalar, or one level of `object` (e.g.
 * `assert.status.range`'s `{min, max}`). `GenericElementForm` renders a row per property; a kind
 * needing more ships a bespoke form (`elementForms.ts`).
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
	/**
	 * What the engine runs when the key is absent (#3045), from the kind's own constant. Forms and
	 * summaries show it; nothing writes it into the config.
	 */
	default?: string | number | boolean;
	/** `"advanced"` folds this field under a disclosure instead of the form's main rows (issue #1607). */
	"x-vayu-group"?: "advanced";
	/** A numeric suffix to render beside this field's value: `"ms"`, `"%"` or `"B"` (issue #1607). */
	"x-vayu-unit"?: "ms" | "%" | "B";
}

/**
 * A JSON Schema object as the element registry emits it (#1512). A property may be `null` (an
 * unconstrained one: `assert.jsonpath`'s `expected`), typed so its one reader, `PropertyRow` in
 * `GenericElementForm`, cannot assume an object; it reads `null` as `{}`.
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
 * A typed behaviour on a request or collection (#1512), run by the engine's element pipeline at the
 * phases its `kind` implies (`GET /elements/kinds`; never stored). The engine validates `config` on
 * save; `validateElementConfig` (`lib/elements.ts`) checks the registry's keywords and reports
 * every failing field.
 */
export interface ElementDef {
	id: string;
	kind: string;
	enabled: boolean;
	name?: string;
	config: Record<string, unknown>;
}

/**
 * The chain level an element, assertion or console line came from (#2522). Finer than an origin's
 * `kind`, whose two values stay because readers branch on them.
 */
export type ElementScope = "collection" | "folder" | "request";

/**
 * An element sent inline to `POST /compose` / `POST /execute` (#1512) with its origin, the N-kind
 * {@link ScriptPart}. `elements-parts.ts` walks the chain root to leaf, then the request's own; no
 * `origin` means an inline send with no `requestId` chain.
 */
export interface ResolvedElement extends ElementDef {
	origin?: ElementOrigin;
}

/** The level an element was composed from; see {@link ResolvedElement}. */
export interface ElementOrigin {
	kind: "collection" | "request";
	scope?: ElementScope;
	id?: string;
	name?: string;
}

/**
 * What one element did in its phase (#1512), on the trace beside the script results
 * (`RunResultTrace.elements`). No `origin` for an inline send without a `requestId` chain
 * (`docs/engine/api-reference/execute.md`, the `elements` entries).
 */
export interface ElementOutcome {
	id: string;
	kind: string;
	/** The element's own label; absent when it has none (issue #3051). */
	name?: string;
	origin?: ElementOrigin;
	/** Present only for an element whose config requires it: a `missing` then fails the step. */
	required?: true;
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
	 * Which setting last wrote {@link method} and still owns it (#1505). Optional, unlike `stream`:
	 * the engine sends `null` for none, which every reader here spells `undefined`.
	 */
	methodSource?: MethodSource;
	url: string;
	params: KeyValueEntry[];
	headers: KeyValueEntry[];
	body: RequestBody;
	bodyType: BodyMode; // Denormalized mirror of body.mode - kept for queryability
	auth: RequestAuth;
	/** This request's own elements (#1512); for inheritance see {@link Collection.elements}. */
	elements: ElementDef[];
	/** Follow 3xx `Location` responses. Engine default is `true`. */
	followRedirects: boolean;
	/** Redirect hops allowed when {@link followRedirects} is on. Engine default is 10. */
	maxRedirects: number;
	/**
	 * This request's own timeout in ms (#2937), `1`-`86400000`, or `null` for the `defaultTimeout`
	 * setting read at each send. Always stored. Unlike its neighbours, `null` stays off the
	 * composed payload, so the engine resolves the live setting instead of a pinned copy of today's
	 * default.
	 */
	timeout: number | null;
	/**
	 * The requested protocol; `"auto"` lets curl pick (ALPN over TLS, else HTTP/1.1; see
	 * {@link HTTP_VERSIONS}). Not `ResponseState.httpVersion`, the negotiated display string: do
	 * not unify them.
	 */
	httpVersion: HttpVersion;
	/**
	 * Verify this endpoint's TLS certificate (engine default `true`). Always sent, never elided at
	 * the default: an omitted `false` would verify what the user said not to (#706). Per request
	 * for one internal self-signed host; trusting a CA everywhere (Settings > Network &
	 * connectivity > Custom CA certificates) comes first.
	 */
	verifySSL: boolean;
	/**
	 * Skip the cookie jar (#1765, Postman's `disableCookies`): no jar cookie attached, no
	 * `Set-Cookie` stored. A typed `Cookie` header is still sent.
	 */
	disableCookies: boolean;
	/**
	 * Engine automatic headers this request never sends, lowercased (#1765, Postman's
	 * `disabledSystemHeaders`). Stored, unlike the per-send `disabledDefaultHeaders` (#1229); the
	 * engine unions both. Names Vayu cannot omit (`host`, `content-length`) or never sends
	 * (`postman-token`, `connection`, `cache-control`) only survive for the Postman export.
	 */
	disabledSystemHeaders: string[];
	/**
	 * Send path and query as written: no percent-encoding of path variables, query rows or an
	 * API-key query param (#1765, Postman's `disableUrlEncoding`).
	 */
	disableUrlEncoding: boolean;
	/**
	 * An imported Postman item's `protocolProfileBehavior` as stored JSON text, member order kept.
	 * Only the engine's Postman exporter reads it; the app never parses it, and a Duplicate copies
	 * the text so the copy exports the same bytes. Absent or `null` when not from Postman.
	 */
	postmanProtocolBehavior?: string | null;
	/**
	 * Consume the response as `text/event-stream` (#574). On the request because it describes the
	 * endpoint, so the toggle survives a tab switch and imports carry it. Always present (`false`
	 * on rows older than the column).
	 */
	stream: boolean;
	/**
	 * The JSONPath each event's JSON `data` yields the reply text through (#3773), e.g.
	 * `$.choices[0].delta.content`. Only with {@link stream} (the engine refuses it otherwise);
	 * `null` or absent is none.
	 */
	streamTextPath?: string | null;
	/**
	 * The literal a load run times its stream to (#3774): `stream.timeToFirstMatch` waits for these
	 * bytes (e.g. `content_block_delta`). Only with {@link stream}; `null` or absent is none.
	 */
	streamFirstContentMarker?: string | null;
	/** The example a mock server answers with (#481 phase 3); `"first"` on rows older than it. */
	mockResponseMode: MockResponseMode;
	/** What `"fixed"` {@link mockResponseMode} serves; the engine's `null` is `undefined` here. */
	mockExampleId?: string;
	/**
	 * Which operation of the bound spec this request is (#637). Optional: the engine sends `null`
	 * for none (`undefined` here), so presence is the request-level twin of `hasSpecBinding`.
	 */
	specOperation?: SpecOperation;
	order: number;
	createdAt: string;
	updatedAt: string;
}

/**
 * A tree row: one `GET /requests?fields=summary` row (#2546), what every `listByCollection` cache
 * holds. A full `Request` is one, so a write holding the whole row may store it; anything else is
 * fetched through `requestDetailOptions`. `createdAt` serves `compareTreeOrder`'s tie-break and
 * `specOperation` the Spec tab's mapping count.
 */
export type RequestSummary = Pick<
	Request,
	"id" | "collectionId" | "name" | "method" | "url" | "order" | "createdAt" | "specOperation"
>;

/**
 * A saved example response (#481): imported (Postman, OpenAPI), kept from a live response (#588),
 * and what a mock server answers with. The engine row's `order` and timestamps are untyped on
 * purpose: the list arrives ordered and nothing displays either.
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
	 * Who wrote the row (#588, #722): `import` (an importer or spec sync) or `user` (saved from a
	 * live response). A sync rewrites the imported rows of every request it touches, so only an
	 * imported example is the document's to change, and deleting one differs by kind. Always
	 * present (the engine defaults the column to `import`).
	 */
	origin: "import" | "user";
	/**
	 * `body` is only the first slice of the response (#659); the panel shows a chip, since a mock
	 * serves the stored body verbatim. Absent on rows older than the column, all complete.
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

export interface GlobalVariables {
	id: string; // Always "globals"
	variables: Record<string, VariableValue>;
	updatedAt: string;
}

/** Resolution priority: environment, then collections leaf to root, then global. */
export type VariableScope = "global" | "collection" | "environment";

/**
 * What a token popover's create can set beyond the value; an edit passes none and keeps its mark. A
 * create landing on an existing name (its only definition switched off) marks that entry too.
 */
export interface VariableCreateOptions {
	/** Store the entry with `secret: true`. Absent or false leaves the entry as it was; never un-secrets. */
	secret?: boolean;
}

/**
 * `secret` is a UI masking hint, not encryption at rest. `value` is the raw string `{{var}}`
 * interpolation uses; `type`/`typedValue` give the cast value for scripts and autocomplete.
 */
export interface ResolvedVariable {
	value: string;
	scope: VariableScope;
	secret?: boolean;
	type?: VariableValue["type"];
	typedValue?: unknown;
	/** Source collection or environment (set by the resolver); none for the singleton `global`. */
	sourceId?: string;
	sourceName?: string;
}

/**
 * A writable scope or the bound data row, the tier above them all (D18, #1007). Not a fourth
 * `VariableScope`: every write path is typed on that union (`updateVariable`, `writableScopes`, the
 * create picker), and widening it would offer "Bound row" as a create target that no-ops.
 */
export type VariableOriginScope = VariableScope | "row";

/**
 * One definition of a name at one scope. The resolver's single winner cannot explain a value (a
 * name at several scopes, or a disabled top definition, the commonest surprise), so losers and
 * disabled definitions are listed. A `"row"` origin is no definition but the answer the send uses;
 * `getVariableOrigins` layers it on, never the scope ladder (`ScopeVariableOrigin`).
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
	 * The definition the send uses: one per name, none if all are disabled. Explicit, since
	 * precedence and win order differ once disabled ones are listed; a bound row's cell takes it
	 * from all beneath.
	 */
	winner: boolean;
}

/**
 * An origin that is a stored, editable definition. The scope ladder and `ResolvedVariable` are
 * built from these, which keeps `ResolvedVariable.scope` a `VariableScope`: a row has no scope, and
 * claiming one would offer an uneditable tier to every write path.
 */
export type ScopeVariableOrigin = VariableOrigin & { scope: VariableScope };

export interface VariableInfo extends ResolvedVariable {
	name: string;
}

/**
 * Request and load parameters captured at run start and stored with the run; the index signature
 * admits keys the engine adds.
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
	 * Whether the run waited out `Retry-After` (#3782), and the longest wait in ms, as sent. Absent
	 * when off, as on every older run; `RunConfigSection` reads both.
	 */
	retryAfterBackoff?: boolean;
	retryAfterMaxMs?: number;
	/**
	 * A load run's data file (#2051): name and SHA-256, never a path. A collection run keeps the
	 * pair in its `scenario` block; read both through `dataFileFromSnapshot`.
	 */
	dataFileName?: string;
	dataFileHash?: string;
	/** Numbers read as numbers (#2540), invisible to the hash; absent is text, as on older runs. */
	dataFileCastNumbers?: boolean;
	/**
	 * The budgets the run declared, as sent (sanitized); `loadConfigFromSnapshot` takes
	 * `latencyP99Ms` as the live dashboard's line. Any key may be absent; runs before budgets have
	 * none.
	 */
	thresholds?: RunThresholds;
	/**
	 * The server-vitals block as sent; `MonitorSummary` reads its `series` to name what a no-match
	 * scrape lacked. Absent when nothing was monitored.
	 */
	monitor?: RunMonitorConfig;
	/**
	 * The requested protocol, always present in practice: `build_run_report_config`
	 * (`routes/runs.cpp`) turns absent or `null` into `"auto"`. Not the negotiated
	 * `ResponseState.httpVersion`.
	 */
	httpVersion?: HttpVersion;
	/**
	 * A load or collection run's default-header decision at start (#1488): `userAgent` verbatim,
	 * `requestId`/`acceptEncoding` whether negotiated, `expectContinue` (#2516) whether libcurl
	 * could add `Expect: 100-continue`. Absent on design runs and older runs (no `expectContinue`
	 * before #2516). Never re-applied; kept so a baseline comparison can tell whether conditions
	 * matched.
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
 * How a scenario step ended. `skipped` stopped before the wire (a controller or
 * `pm.execution.skipRequest()`, #180) and is never a pass. `stopped` was cut short by a Stop or
 * shutdown (#3397): it ends the run and counts as no failure.
 */
export type StepOutcome = "passed" | "failed" | "skipped" | "errored" | "stopped";

/** The outcomes as a value, in the order a run summary reads them. */
export const STEP_OUTCOMES: readonly StepOutcome[] = [
	"passed",
	"failed",
	"skipped",
	"errored",
	"stopped",
] as const;

/**
 * The `plan` SSE event opening a sequential run's `GET /runs/:runId/live` (`build_plan_data`,
 * #1398). Only the engine knows these numbers. Sent once, before the first `step`; a client
 * attaching after it left the tick ring never sees it.
 */
export interface ScenarioRunPlanEvent {
	/** The plan's length - steps in one pass, not executions. */
	stepsPerIteration: number;
	/** Passes the engine resolved: a data set's row count when the request named none. */
	iterations: number;
	/**
	 * `stepsPerIteration * iterations`, an upper bound: an errored step or a stop ends a run early,
	 * and `setNextRequest` can walk an iteration in fewer steps.
	 */
	stepsExpected: number;
}

/**
 * The `step` SSE event on `GET /runs/:runId/live` (`build_step_payload`). No exchange: the stored
 * `results` row restores the response pane after the run.
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
	/** The `data` row this iteration bound, as on the stored row; absent without a data set. */
	dataRowIndex?: number;
	/**
	 * Plan positions lost to the error that ended this step's iteration early (#2526); only on that
	 * step and only above zero (absent, never `0`), as on the stored row.
	 */
	stepsNotRun?: number;
	/** Extractions that found nothing and unset their variable (#3053); absent, never `0`. */
	extractorMisses?: number;
	/** Distinct `{{names}}` still in the request when sent (#3248); absent, never `0`, if none. */
	unresolvedTokens?: number;
	/**
	 * The stored request this step ran (#831), the id `stamp_step_identity` writes on the trace, so
	 * a failed step links back while the run streams. No key (never `""`) without one; no link
	 * then.
	 */
	requestId?: string;
	/**
	 * What this step sent (#3634): verb, URL (masked and cut to 512 bytes by the engine, so not the
	 * stored request's) and response body bytes. Absent for a step that sent nothing; `bodyBytes`
	 * is `0`, not absent, for an empty body.
	 */
	method?: string;
	url?: string;
	bodyBytes?: number;
	/**
	 * The step's contract verdict (#681), the same object the stored trace carries, so live and
	 * reloaded steps show one verdict. Absent for an unbound collection or a step that sent
	 * nothing.
	 */
	validation?: ResponseValidation;
	/**
	 * The step's assertion tally (#724): two numbers, since the frame replays from a fixed-size
	 * ring and a script may assert hundreds of times; the list rides the stored row. Absent when
	 * nothing was asserted: `0 passed` would read as a result.
	 */
	tests?: StepTestTally;
}

/**
 * One step's assertion tally on the `step` event: the test script's only, as the stored `scripts`
 * node lists, so the live tally and the reloaded list count the same assertions.
 */
export interface StepTestTally {
	passed: number;
	failed: number;
}

/**
 * Every {@link StreamEndReason}: the union, the `complete` frame parser and the Events tab use it.
 */
export const STREAM_END_REASONS = [
	"completed",
	"stopped",
	"maxStreamEvents",
	"maxStreamDurationMs",
	"idleTimeout",
	"shutdown",
	"error",
] as const;

/**
 * Why a stream ended (#573), the same word on the relay's `complete` frame and the stored trace.
 * Only `"completed"` means the server closed it; the rest are this side's bounds or an unasked stop
 * (`"shutdown"`: the engine went down, #3342), so the Events tab names the one that fired.
 */
export type StreamEndReason = (typeof STREAM_END_REASONS)[number];

/**
 * One upstream `text/event-stream` event, as the live relay (`GET /runs/:id/events`) and the stored
 * trace carry it. `sourceId` is the origin's `id:`, not the relay frame id `lastEventId` resumes
 * from; mixing them breaks one resume (`docs/engine/api-reference/live-metrics.md`). An event over
 * `sseMaxEventBytes` is a prefix with `dataTruncated` and `dataBytes` its sent size.
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
	/**
	 * What `streamTextPath` read off this event's `data` (#3773). Absent, not `""`, with no path,
	 * no match (a role-only chunk, a ping) or a cut event. Engine-evaluated: the app declares no
	 * provider shape.
	 */
	text?: string;
}

/** The relay's `open` frame, sent on the response headers so even a late consumer learns them. */
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
 * The `events` node only a streaming design run's trace carries. `eventsTruncated` is the engine's
 * own `totalEvents` comparison, so an uncut stream and a dropped tail stay distinguishable after
 * the cap changes.
 */
export interface RunResultStreamEvents {
	items: StreamEvent[];
	totalEvents: number;
	eventsTruncated: boolean;
	endReason: StreamEndReason;
	/**
	 * Transfer start, epoch ms on the engine clock `receivedAt` uses, so an offset is
	 * `receivedAt - startedAt` (#3805). Absent on older nodes and when no transfer began.
	 */
	startedAt?: number;
	/**
	 * Every event's `text` joined with nothing between, over all events in the stored body, the
	 * ones `items` dropped included (#3773). Only with a `streamTextPath`; `""` if nothing matched.
	 * The whole reply unless `eventsTruncated` marks a cut body.
	 */
	streamText?: string;
}

/**
 * The `scripts` node a streaming design run's trace carries (#575), keyed as the live `/execute`
 * body. A key is written only with content, so silent scripts store no node.
 */
export interface RunResultScripts {
	testResults?: TestResult[];
	consoleLogs?: ConsoleLogEntry[];
	preScriptError?: string;
	postScriptError?: string;
	scriptRequests?: ScriptRequestRecord[];
}

/**
 * One `pm.sendRequest` a script made (#3633), with {@link RunResultTrace}'s members for the call.
 * The engine masks credentials as it builds it (`<redacted>` for credential header values and a
 * URL's userinfo password or credential query value, hops included; challenge headers shown), so
 * render it as written. `status` `0` is a transport failure (code in `error_type`; no `response`
 * when nothing answered).
 */
export interface ScriptRequestRecord extends Pick<
	RunResultTrace,
	| "totalMs"
	| "wireMs"
	| "queueWaitMs"
	| "dnsMs"
	| "connectMs"
	| "tlsMs"
	| "firstByteMs"
	| "downloadMs"
	| "error_type"
	| "error_message"
> {
	/** Absent on a setup or teardown row's record: the row names its phase. */
	source?: ScriptSource;
	scope?: ElementScope;
	/** When the call began, in epoch milliseconds. */
	startedAt?: number;
	status: number;
	statusText?: string;
	request: NonNullable<RunResultTrace["request"]>;
	response?: NonNullable<RunResultTrace["response"]>;
}

/**
 * Something the engine did to a design send that the response does not show (#3307). `code` is
 * stable (`cookie_not_sent`, `cookie_limit_reached`, `cookie_dropped_oversized`,
 * `cookie_dropped_too_many`, more to come); `message` names a cookie, never its value.
 */
export interface ExchangeWarning {
	code: string;
	message: string;
}

/**
 * One exchange's stored trace. A design trace (`store_result`, execution.cpp) nests request and
 * response; a load trace is flat. Both writers omit fields freely, so all are optional. Shared by
 * {@link RunResult} and {@link RunReport}.
 */
export interface RunResultTrace {
	totalMs?: number;
	/**
	 * libcurl's transfer time (`queueWaitMs`: generator overhead); older engines' rows lack both.
	 */
	wireMs?: number;
	queueWaitMs?: number;
	/** Design-mode writer only, flat; see {@link ResponseTiming.engineMs}. */
	engineMs?: number;
	/** Design-mode and collection-run step writers, flat; see {@link ResponseTiming.scriptMs}. */
	scriptMs?: number;
	dnsMs?: number;
	connectMs?: number;
	tlsMs?: number;
	firstByteMs?: number;
	downloadMs?: number;
	isSlow?: boolean;
	thresholdMs?: number;
	request_number?: number;
	error_code?: number;
	/**
	 * `to_string(ErrorCode)`, as a live `errorCode`. A failure after the header block keeps
	 * `response` beside it (#3423), so `response` is no success flag.
	 */
	error_type?: string;
	/** The load-test writer's failure text (`load_strategy.cpp`). */
	message?: string;
	/** The design-mode writer's failure text (`store_result`, execution.cpp). */
	error_message?: string;
	/**
	 * A load run's `validate_scripts` failures (`run_manager.cpp`) on the summary row's trace
	 * (#111): `"<test name>: <assertion>"`, or a `Script error:` / `Exception:` line when the
	 * script threw.
	 */
	failures?: string[];
	/**
	 * Per distinct message in {@link failures}, how often it failed (deferred replay, #3127).
	 * Absent on rows from before deduplication, whose entries count once each.
	 */
	failureCounts?: number[];
	/**
	 * Distinct failure messages the replay saw, kept or not, so
	 * `failuresDistinct - failures.length` were turned away. Absent with {@link failureCounts}.
	 */
	failuresDistinct?: number;
	/** Assertions that failed / passed, each occurrence counted. */
	totalFailed?: number;
	totalPassed?: number;
	headers?: Record<string, string>;
	body?: string;
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
		 * The wire message sent (#348), `build_result_trace`'s copy of the live `rawRequest`, so a
		 * restored raw view shows the jar's `Cookie` line. Absent on older rows and unsent steps
		 * (`sentSide` then falls back to `buildRawRequest`). **Not redacted**, as live
		 * (`docs/engine/api-reference/execute.md`). Body capped at `maxTraceBodyBytes`; headers
		 * never are.
		 */
		rawRequest?: string;
		/**
		 * What the transfer issued (#664), `build_result_trace`'s copy of the live
		 * `requestHeaders`: `headers` minus suppressed entries and a blank `Content-Type` or
		 * `Cookie` (other blanks are sent empty, #3220), plus the derived body `Content-Type` and
		 * default `User-Agent`. The pane's "sent" disclosure; `headers` stays as the composed
		 * request `design-run-seed.ts` reseeds from. Absent on older rows and unsent steps
		 * (`sentSide` falls back to `headers`). **Not redacted**.
		 */
		sentHeaders?: Record<string, string>;
		/**
		 * `sentHeaders` as wire-order lines (#2466): repeats repeated, as typed. Absent on rows
		 * before the key, which keep the folded map (`HttpResponse.requestHeaderLines` is the live
		 * spelling).
		 */
		sentHeaderLines?: HeaderLine[];
		/**
		 * A `binary` body's name, byte size and sha256 at send time, never bytes or path.
		 * `unknown`: a stored row is whatever its engine wrote; `sentBodyFileOf`
		 * (`lib/sent-body-file.ts`) reads it.
		 */
		bodyFile?: unknown;
		/**
		 * What the auth block did on the wire when not plain (see {@link HttpResponse.authNotice};
		 * #2474, #3203, #3202). On the request node because it describes what was sent, so a failed
		 * exchange with no `response` has it too.
		 */
		authNotice?: string;
		/**
		 * The header names and query parameter the auth block wrote (`record_auth_provenance`),
		 * each only when present; a script request's record masks their values (#3633).
		 */
		authHeaders?: string[];
		authQueryParam?: string;
	};
	response?: {
		headers?: Record<string, string>;
		/**
		 * The received header lines, written only if any (#2460; live spelling
		 * `HttpResponse.headerLines`). Absent on older rows and load-run samples, which keep the
		 * folded map.
		 */
		headerLines?: HeaderLine[];
		/**
		 * Followed redirect hops, written only if any (#2461; live: `HttpResponse.redirects`).
		 * Absent on older rows, load-run samples and when nothing was followed.
		 */
		redirects?: RedirectHop[];
		body?: unknown;
		/** Set by `store_result` when the response body exceeded `maxTraceBodyBytes`. */
		bodyTruncated?: boolean;
		/**
		 * UTF-8 byte count, the original when `bodyTruncated` (`body` is then a prefix). Written on
		 * every response (#3423); older rows have it only when truncated or streamed, so fall back
		 * to counting.
		 */
		bodyBytes?: number;
		/**
		 * `body` is base64 bytes, as the live `bodyEncoding` (#2458); written only then, absent is
		 * text (as on older rows). A truncated one is the base64 of the kept prefix; `bodyBytes`
		 * counts the original.
		 */
		bodyEncoding?: "base64";
		/**
		 * The negotiated protocol as `build_result_trace` stores it, in
		 * `ResponseState.httpVersion`'s display-string space, not `HttpVersion`.
		 * `restore-response.ts`'s `sentSide` puts it on the raw request line;
		 * `responseFromRunResult` onto `ResponseState.httpVersion` (the Raw status line).
		 */
		httpVersion?: string;
		/**
		 * Asked for HTTP/2, negotiated older ({@link HttpResponse.httpVersionDowngraded}).
		 * Optional, not defaulted `false`: traces from engines before 0.15.0 lack it.
		 */
		httpVersionDowngraded?: boolean;
		/**
		 * The live send stopped reading at `maxDesignResponseBodyBytes`
		 * ({@link HttpResponse.bodyCapped}, #1157). Written only when cut, so absent is "not
		 * capped" (live, it is always present). Unlike `bodyTruncated` (storage shortening a body
		 * seen whole), a re-send does not recover it.
		 */
		bodyCapped?: boolean;
	};
	/**
	 * A streaming design run's events (#573), optional because one `results` row shape serves every
	 * writer; `restore-response.ts` reads it to show a reopened stream's timeline.
	 */
	events?: RunResultStreamEvents;
	/**
	 * A design run's script output (#575) under the live `/execute` body's keys; one engine object
	 * (`build_script_result_node`) fills both, so restored and live Tests panes agree. The only
	 * route for a streaming send's results (answered `202` before its post-request script);
	 * buffered sends store it too (#725). Absent means no scripts ran or the row predates #725,
	 * never "none passed".
	 */
	scripts?: RunResultScripts;
	/**
	 * The step's element outcomes (#1512) beside `scripts`, written by design sends and sequential
	 * steps. A load trace never has them: load runs tally elements in the report instead
	 * (`RunReport.elements`, `scenario.steps[].elements`).
	 */
	elements?: ElementOutcome[];
	/**
	 * The response's schema verdict (#628), stored verbatim as live `/execute` carried it (one
	 * builder, `build_validation_payload`). Absent when the collection binds no document, and for a
	 * streaming run: an event stream is no document a response schema describes.
	 */
	validation?: ResponseValidation;
	/**
	 * The client-certificate entry presented, `host` or `host:port` (#707). Top level: the exchange
	 * most needing it is a failed handshake, which has no `response`. Absent means none, as on rows
	 * from before the registry.
	 */
	clientCertificate?: string;
	/**
	 * {@link HttpResponse.warnings} stored verbatim (#3307), top level like `clientCertificate` (a
	 * failed send can still warn). Written only when non-empty: absent is "none", as on older rows.
	 */
	warnings?: ExchangeWarning[];
	/*
	 * Step identity, stamped on a scenario run's per-step trace by `stamp_step_identity` and read
	 * by `scenario-steps.ts`. Only scenario rows carry it, so a row without `stepIndex` is skipped,
	 * not shown as step 0.
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
	 * The `data` row this iteration bound (absent without a data set), showing the wrap: iteration
	 * 4 of a 3-row set reads row 1. A scenario load run writes it on every retained result too
	 * (#449), its only record of the row since that executor stores no per-step rows; it arrives on
	 * a flat load trace, hence its place outside the `stepIndex` keys.
	 */
	dataRowIndex?: number;
	/**
	 * Plan positions lost to this step's iteration-ending error (#2526); else absent, never `0`.
	 */
	stepsNotRun?: number;
	/** Extractions that found nothing and unset their variable (#3053); absent, never `0`. */
	extractorMisses?: number;
	/** Distinct `{{names}}` left in the request when sent (#3248); absent, never `0`. */
	unresolvedTokens?: number;
}

/** A design run's one exchange, embedded by `GET /runs/:id` (`attach_design_result`). */
export interface RunResult {
	timestamp: number;
	statusCode: number;
	statusText: string;
	latencyMs: number;
	error?: string;
	trace?: RunResultTrace;
}

/**
 * A collection run's list-row sequence summary, from the snapshot's scenario manifest
 * (`add_scenario`, `routes/runs.cpp`). Its presence marks a collection run (`type: "scenario"` or a
 * scenario `"load"`), and its `collectionId` scopes a load run's compare, trend and baseline when
 * there is no `requestId`. `stepCount`, not the manifest's per-step array, keeps rows small; the
 * array stays on `GET /runs/:id`.
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
 * The paginated `GET /runs` row summary, in place of the full {@link RunConfigSnapshot}: every key
 * `build_run_summary` sends, each omitted when the snapshot lacks it, except `httpVersion` (always
 * normalized). It mirrors the wire, so some keys no row reads: the ramp knobs come from the
 * report's `metadata.configuration` (`comparability`, #2162); the redirect settings are shown
 * nowhere (their home would be beside `httpVersion`).
 */
export interface RunSummary {
	url?: string;
	/**
	 * The request's name as the client sent it at run start (`execIdentity`, `execute-mapping.ts`),
	 * never re-read: a rename or delete does not change it; older runs have none. The history row
	 * falls back to `url` when absent or still `DEFAULT_REQUEST_NAME`.
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
	 * Whether the run negotiated compression (#1488; {@link RunConfigSnapshot.defaultHeaders}).
	 * Omitted, not `false`, on older runs; only the baseline `compression` check reads absent as
	 * `false`, which is what such a run sent.
	 */
	acceptEncoding?: boolean;
	/**
	 * Collection runs' sequence ({@link RunScenarioSummary}); history rows show it, lacking `url`.
	 */
	scenario?: RunScenarioSummary;
	/**
	 * A load run's data file (#2051): name and SHA-256, never a path; collection runs:
	 * {@link RunScenarioSummary}.
	 */
	dataFileName?: string;
	dataFileHash?: string;
	/** Whether its numbers were read as numbers (issue #2540); absent means read as text. */
	dataFileCastNumbers?: boolean;
	/**
	 * The terminal report has non-empty `warnings` (#1527, extending #1503). Omitted, not `false`,
	 * otherwise (running, or clean), so the history row tests presence, not `=== true`.
	 */
	hasWarnings?: boolean;
}

/**
 * Who started a run (#1817): `app` (this renderer), `mcp` (with its handshake `clientInfo.name`) or
 * `other` (any other caller, and every older run). Client-asserted, not identity. `client` is
 * `null` on the wire when absent; optional here for test literals.
 */
export interface RunOrigin {
	kind: "app" | "mcp" | "other";
	client?: string | null;
}

/**
 * Where an active run's worker is (#3568), on every live metrics frame and `GET /runs/:id` while
 * active; `draining` is the run's end reached, `backpressure` the requests still awaited. Live
 * only, engine-owned, never inferred; `runPhaseOf` (`lib/run-status.ts`) reads unknown as absent.
 */
export type RunPhase = "setup" | "sending" | "draining" | "summarising" | "settled";

/** The phases as a value, for narrowing what the wire sent. */
export const RUN_PHASES: readonly RunPhase[] = [
	"setup",
	"sending",
	"draining",
	"summarising",
	"settled",
];

/**
 * The verdict stored on a run row and filtered by `GET /runs` (#3547); `not-judged` is `not_judged`
 * here.
 */
export type StoredRunOutcome = "passed" | "failed" | "not_judged";

/** What every run shares; {@link Run} adds the `type` and the `resultSummary` that goes with it. */
interface RunFields {
	id: string;
	status: "pending" | "running" | "completed" | "stopped" | "failed";
	/** `GET /runs/:id` of a run the engine holds active only; read it through `runPhaseOf`. */
	phase?: RunPhase;
	startTime: number; // Unix timestamp in ms
	/** Unix ms once the run is terminal; `null` while it is pending or running. */
	endTime: number | null;
	/** On paginated `GET /runs` rows; `GET /runs/:id` returns {@link configSnapshot} instead. */
	summary?: RunSummary;
	/** Full snapshot - present on `GET /runs/:id`, not on paginated list rows. */
	configSnapshot?: RunConfigSnapshot;
	requestId?: string | null;
	environmentId?: string | null;
	/** The exchange, present only for a design run once it has completed or failed. */
	result?: RunResult;
	/**
	 * Pinned: kept past retention, listed by `GET /runs?baseline=true`, toggled by
	 * `PUT /runs/:id/baseline`. Any type can pin (a design run keeps a known-good response); only a
	 * load run's pin is the comparison baseline (`useBaselineRunQuery`), having percentiles and
	 * throughput. Absent (an older engine) reads as `false`.
	 */
	baseline?: boolean;
	/** Who started the run ({@link RunOrigin}); absent on older rows, read as `other`. */
	origin?: RunOrigin;
	/**
	 * The stored verdict (#3547), on list rows and the pin's PUT answer, never `GET /runs/:id`.
	 * Always `failed` for a failed run (#3643). Absent when nothing was judged (a clean collection
	 * run, a design run that did not fail, a run in flight) and on rows from before the column,
	 * failed ones included: absent is not `passed`. `rowOutcome` reads it first, deriving `failed`
	 * for that status.
	 */
	outcome?: StoredRunOutcome;
}

/**
 * A listed run; narrow on `type` before reading `resultSummary`: a design row's exchange
 * ({@link RunResultSummary}), a terminal load row's headline numbers ({@link LoadResultSummary}), a
 * terminal collection row's step counts ({@link CollectionResultSummary}). `GET /runs/:id` carries
 * none: it attaches a design run's `result`; the report serves the others.
 */
export type Run =
	| (RunFields & { type: "load"; resultSummary?: LoadResultSummary })
	| (RunFields & { type: "design"; resultSummary?: RunResultSummary })
	// A collection run, one row per step, shown by `ScenarioRunView`: the load report's percentiles
	// would describe a sequence as one request repeated. Its sidebar row reads the step counts
	// (#2954) for its glyph and subtitle.
	| (RunFields & { type: "scenario"; resultSummary?: CollectionResultSummary });

/**
 * A design run's outcome on its `GET /runs` row (`get_runs_response`): two numbers, since the full
 * {@link RunResult}'s `trace` is too costly per row. No outcome yet (in flight, a failed write)
 * means no `resultSummary`, which is not `statusCode: 0` (a request that reached no server).
 */
export interface RunResultSummary {
	statusCode: number;
	latencyMs: number;
}

/**
 * A terminal load run's row, read engine-side from its stored summary (#2130), so History needs no
 * report fetch per row. Unrecorded keys are absent, never zeroed; pending or running rows have no
 * `resultSummary`. `verdict` only with declared budgets: absent means unjudged, not `"passed"`.
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
	 * The report's assertion block (#3537), on both load kinds; absent with the two flat keys when
	 * nothing asserted or errored. Rows read it through `rowAssertionsOf`; `errorRate` and
	 * `verdict` stay HTTP-and-budget only.
	 */
	assertions?: RunAssertions;
	/**
	 * `assertions.exact` plus `assertions.sampled`, for older readers. Before #3537 the engine sent
	 * only these: a scenario load run's exact pair (#2820), a single-request run's
	 * `assertionsFailed` summed over both (#3458), which `rowAssertionsOf` reads as exact.
	 * `assertionsPassed` has no renderer reader; MCP's `list_runs` passes it through.
	 */
	assertionsPassed?: number;
	assertionsFailed?: number;
	/**
	 * A Stop cut the end-of-run drain with requests outstanding (#3538): `completed` but unjudged
	 * (`rowOutcome`); only for a positive `cancelled`.
	 */
	drainCut?: { cancelled: number };
	/**
	 * A terminal capacity run's search result (#2930), absent elsewhere and from older engines. The
	 * row's `rps`/`p95Ms`/`errorRate` average a stepped-up search, so `resultSubtitle` prints these
	 * levels. `maxHealthyConcurrency` held its budgets, `kneeConcurrency` broke them (each omitted,
	 * never zeroed; a knee alone means the first level failed); `stopReason` is a `STOP_REASONS`
	 * key.
	 */
	capacity?: LoadResultCapacity;
}

/**
 * A terminal collection run's row, from the stored `summary.scenario` (#2954): disjoint step
 * counts, `errored` beside `failed` so an all-errored run does not read clean, `stopped` (#3397) a
 * step a Stop cut short. Unrecorded keys are absent, never zeroed (no `stopped` in older
 * summaries); running rows have no `resultSummary`; `verdict` needs declared budgets. `rowOutcome`
 * fails a completed run on any `failed` or `errored` (#3458) or a `"failed"` verdict, "Fail the
 * run" or not (#3539), and `collectionSubtitle` prints the counts; a `failed` status is always
 * failed (#3643). MCP's `list_runs` passes it through.
 */
export interface CollectionResultSummary {
	passed?: number;
	failed?: number;
	skipped?: number;
	errored?: number;
	stopped?: number;
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
		 * This page's last row as a cursor, `null` on the last page; pass it back as is (the engine
		 * owns its spelling).
		 */
		nextBefore: string | null;
	};
}

/** Server-side filters for the paginated `GET /runs` list. */
export interface RunListParams {
	limit?: number;
	offset?: number;
	/**
	 * Keyset cursor from the previous page's `pagination.nextBefore`. The engine refuses it with a
	 * non-zero `offset`, so `listRuns` drops its default `offset` when one is set.
	 */
	before?: string;
	type?: Run["type"];
	status?: Run["status"];
	requestId?: string;
	/** Matched as JSON against a stored `scenario.collectionId`: only collection runs can match. */
	collectionId?: string;
	q?: string;
	/** `true` only pinned, `false` only unpinned; leave unset (not `false`) for either. */
	baseline?: boolean;
	/** Only runs this kind of caller started; unset is every origin; older engines ignore it. */
	origin?: RunOrigin["kind"];
	/** Only runs storing this verdict (rows with none never match); older engines ignore it. */
	outcome?: StoredRunOutcome;
}

/** Load-test execution strategy. Single source of truth for the mode union. */
export type LoadTestMode =
	"constant_rps" | "constant_concurrency" | "iterations" | "ramp_up" | "capacity";

/**
 * The fixed budget keys, apart from {@link RunThresholds} so `keyof` is exactly the fixed metrics:
 * the dialogs drive fields, validation and payload from one table (`budgets.ts`), which
 * `keyof RunThresholds` cannot, carrying the `custom.*` family too.
 */
export interface RunThresholdBudgets {
	latencyP50Ms?: number;
	latencyP95Ms?: number;
	latencyP99Ms?: number;
	/** Share of the run's requests allowed to fail, 0-100. */
	maxErrorRatePct?: number;
	minThroughputRps?: number;
	/**
	 * Share of assertions (`assert.*` outcomes and `pm.test` calls) allowed to fail, 0-100 (#1497).
	 */
	maxAssertionFailureRatePct?: number;
	/** P95 ceiling on `stream.timeToFirstEvent`, ms (#3234); a run without streams fails it. */
	streamTimeToFirstEventP95Ms?: number;
	/**
	 * Ceiling on p95 `stream.timeToFirstMatch`, ms (#3774), the wait for the first content marker.
	 * A run whose streams never matched has no figure: unevaluated, so failed.
	 */
	streamTimeToFirstMatchP95Ms?: number;
	/**
	 * Floor on `stream.eventsPerSecond` (#3234), judged like {@link streamTimeToFirstEventP95Ms}.
	 */
	streamEventsPerSecondMin?: number;
}

/**
 * Pass/fail budgets a run declares so the engine judges, not only measures, it. Keys are the
 * engine's metric names (verbatim on `POST /runs` and in `thresholdValidation`), hence camelCase
 * beside snake_case `LoadTestConfig`. At least one key: the engine rejects `{}`.
 */
export interface RunThresholds extends RunThresholdBudgets {
	/**
	 * A missed budget turns the terminal status `failed` (#1497). Not a budget, so
	 * `{ failRun: true }` alone is rejected like `{}`.
	 */
	failRun?: boolean;
	/**
	 * `custom.<name>.<stat>`: a non-negative ceiling on a `metric.record` / `pm.metrics` value
	 * (#1500), `<stat>` one of `p50`, `p95`, `p99`, `max`, `value`, `rate`. A pattern signature,
	 * not `[key: string]`, so fixed fields keep their types, `failRun` its `boolean`, and a
	 * mistyped fixed key still errors. Only the shape is checked, not that `<name>` is recorded, as
	 * in the engine (`docs/engine/api-reference/load-runs.md`, the thresholds block).
	 */
	[key: `custom.${string}`]: number | undefined;
}

/**
 * A server-vitals endpoint scraped alongside the run, so the target's CPU or memory shares p99's
 * timeline. Engine keys (`monitor` on `POST /runs`), hence camelCase like {@link RunThresholds}.
 * Omitted, not sent empty, when off: the engine rejects a block without `series`.
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
	 * Keep 1 in N success traces (engine `counter % N`). Named for the unit because the dialog
	 * shows the inverse, a percentage; `successSamplePeriod` converts.
	 */
	success_sample_period?: number;
	slow_threshold_ms?: number;
	save_timing_breakdown?: boolean;
	/**
	 * Wait out a 429's or 503's `Retry-After` before the virtual user's next request (#3782),
	 * camelCase as the engine spells it. Both keys absent when off or under `constant_rps`, which
	 * the engine would only skip with a warning.
	 */
	retryAfterBackoff?: boolean;
	/** The longest such wait, in ms. Present only with `retryAfterBackoff`. */
	retryAfterMaxMs?: number;
	comment?: string;
	latency_percentiles?: number[];
	max_in_flight?: number;
	/** Absent when the run declared no budgets - never an empty object. */
	thresholds?: RunThresholds;
	/** Carried-over `thresholds` keys (#2195), always a subset of them; absent when none. */
	carriedBudgets?: string[];
	/** Absent when the run monitors no endpoint - never an empty object. */
	monitor?: RunMonitorConfig;
	/**
	 * Capacity only: the p99 budget, ms, whose edge the search finds. Prefilled from the
	 * `sloThresholdMs` setting so the user's own number steers it; dashboards draw it as the SLO
	 * line (`runOwnSloMs`, `runSloMs`).
	 */
	slo_ms?: number;
	/** Capacity only: how long each concurrency level is held before it is judged. */
	step_duration_seconds?: number;
	/**
	 * Streaming runs only (#576): the ceiling on one stream's wall clock, in seconds, and on its
	 * events. Both absent means the engine's `sseMaxStreamDurationMs` / `sseMaxStreamEvents`, never
	 * unbounded. On the run, not the request: they bound what this run measures. Seconds here, ms
	 * on the wire, like `duration_seconds`: one unit per form, or 600 meant as ten minutes becomes
	 * 0.6.
	 */
	stream_duration_seconds?: number;
	stream_max_events?: number;
	/**
	 * The rows this run binds (#993), the picker's parsed file, never re-parsed; absent when no
	 * file, leaving the plain path. `data`, not snake_case: the engine's name, as for
	 * {@link RunThresholds} and {@link RunMonitorConfig}.
	 */
	data?: Record<string, unknown>[];
	/**
	 * That file's columns (#1007), left for the per-row bind so a Postman-style `{{username}}` is
	 * not resolved from a same-named environment variable first. Carried, not derived: a JSON row
	 * may omit one, and `ParsedDataFile` already names them. Absent exactly when `data` is.
	 */
	dataColumns?: string[];
	/**
	 * The picked file's name and SHA-256 (#2051), so the run records what drove it; never a path.
	 * Absent exactly when `data` is.
	 */
	dataFileName?: string;
	dataFileHash?: string;
	/** Whether the file's numbers were read as numbers (#2540); absent exactly when `data` is. */
	dataFileCastNumbers?: boolean;
	/**
	 * The `elements` run override (#1594), single-request runs: an inherited `script.*` element's
	 * own `config.inline` decides (`"asMarked"`, the engine default, sent only when changed) or all
	 * run inline / stay deferred. {@link StartScenarioRunRequest}'s override, `scripts` only: this
	 * dialog has no `timers` control.
	 */
	elements?: { scripts: "asMarked" | "allInline" | "allDeferred" };
}

/**
 * One scrape, as `GET /runs/:id/monitor` returns it and the live `monitor` frame carries it, so
 * both overlays draw identical rows. Joined by `timestamp` (Unix ms), not elapsed: a tick's
 * `elapsed_seconds` counts from load start, after any setup script; the scrape starts with the run.
 */
export interface MonitorSample {
	timestamp: number;
	/** Metric name -> value, for the names the run asked for. */
	series: Record<string, number>;
}

/**
 * Per-request timing in ms as `POST /execute` returns it (`serialize(Response)`), in the stored
 * trace's `*Ms` keys ({@link RunResultTrace}), so live and restored agree. Phases (dns…download)
 * are sequential; `wireMs` is libcurl's transfer time, `queueWaitMs` the generator overhead (total
 * − wire), both optional for older traces. `engineMs` (#2132) is Vayu's own cost: elapsed less
 * transfer and scripts, not a phase, not in `totalMs`, not `queueWaitMs`. `scriptMs` (#3676) is the
 * scripts' time (pre-request and test, `pm.sendRequest` included), in none of `totalMs`, `wireMs`,
 * `engineMs`; `0` without scripts. Both absent for streams, auth-failure replies and older rows.
 */
export interface ResponseTiming {
	totalMs: number;
	wireMs?: number;
	queueWaitMs?: number;
	engineMs?: number;
	scriptMs?: number;
	dnsMs: number;
	connectMs: number;
	tlsMs: number;
	firstByteMs: number;
	downloadMs: number;
}

/**
 * One header line as written: a response line as sent (#2460, value trimmed and nothing else) or a
 * request line as it goes out (#2466). Repeats are repeated lines, which a folded map cannot hold.
 */
export interface HeaderLine {
	name: string;
	value: string;
}

/**
 * A followed redirect response (#2461) with every header line: the answer's headers hold the last
 * hop only, so a `Set-Cookie` or `Location` here is nowhere else (as sent, not as the jar kept).
 * `url` and `schemeDowngrade` (#2949) are absent from older engines: `url` is the request the hop
 * answered (the requested URL, then each `Location` resolved, credential query values blanked; `""`
 * if libcurl had none), `schemeDowngrade` that it was `https` and the next `http`.
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
	 * Hops followed before this response, in order; `serialize(Response)` always sends the key,
	 * `[]` when none (always with `followRedirects: false`), absent before #2461.
	 * `responseFromExecuteResult`'s `receivedRedirects` reads empty as absent.
	 */
	redirects?: RedirectHop[];
	/**
	 * Response header lines in wire order; always sent, `[]` when none. `headers` folds them
	 * (lowercased, repeats joined with ", "), losing repeats and the server's case.
	 * `receivedHeaderLines` (`lib/header-lines.ts`) reads empty as absent.
	 */
	headerLines?: HeaderLine[];
	requestHeaders?: Record<string, string>;
	/**
	 * Request header lines as sent, in wire order (#2466); `requestHeaders` folds them (repeats
	 * joined with ", ", `Cookie` with "; "), losing repeats and the typed spelling. Absent from
	 * older engines; `sentHeaderLines` (`lib/header-lines.ts`) reads empty as absent.
	 */
	requestHeaderLines?: HeaderLine[];
	rawRequest?: string;
	/**
	 * The engine's JSON parse of `bodyRaw`, or `null`: declined (`includeParsedBody: false`, which
	 * the renderer always sends), not JSON, base64, or past 4 MiB. Only
	 * `responseFromExecuteResult`'s guard reads it; the pane builds from `bodyRaw`.
	 */
	body: unknown;
	bodyRaw: string;
	/**
	 * How to read `bodyRaw` (#2458): `"base64"` means non-UTF-8 bytes in padded base64, `body`
	 * null, `bodySize` still bytes. Always present live; absent (an older engine, `useEngine`'s
	 * synthetic failure) is `"utf8"`. Decode via `decodeResponseBody`, never by hand.
	 */
	bodyEncoding?: "utf8" | "base64";
	bodySize: number;
	timing: ResponseTiming;
	errorCode?: string;
	errorMessage?: string;
	/**
	 * The negotiated protocol (`serialize(Response)`), `""` when none, never omitted; the display
	 * string space of `ResponseState.httpVersion`, not the request's `HttpVersion`: do not unify.
	 */
	httpVersion?: string;
	/**
	 * Asked for `http2`, negotiated older; computed by the engine (`http_version_downgraded`), the
	 * only side holding both halves. Never re-derive it from the tab's setting: a replay or
	 * restored response sits beside request state that may have changed.
	 */
	httpVersionDowngraded?: boolean;
	/**
	 * Why the request went without its authentication: a mode the engine stores but does not
	 * execute (`digest`, `ntlm`, ...; #2474), an empty bearer token or nameless API key (#3203), or
	 * a typed Authorization header so no OAuth 2.0 token was fetched (#3202). One sentence from
	 * `record_auth_provenance`, which also writes `trace.request.authNotice`. Absent with nothing
	 * to say or from older engines, and on a streaming send, answered before it exists (the trace
	 * has it).
	 */
	authNotice?: string;
	/**
	 * What the engine did that the response does not show (#3307): a jar cookie left off `Cookie`,
	 * or a `Set-Cookie` libcurl discarded. Never fails the send. Always present live (`[]` if
	 * none), so absent means an engine too old to warn; a streaming `202` has none, the pane takes
	 * them from the stored trace at stream end (#3315).
	 */
	warnings?: ExchangeWarning[];
	/**
	 * The registry entry presented, `host` or `host:port`, `""` if none matched (#707); always
	 * present live, so absent is an old engine.
	 */
	clientCertificate?: string;
	/**
	 * Reading stopped at `maxDesignResponseBodyBytes` (Settings → Limits, default 32MB), so `body`
	 * / `bodyRaw` / `bodySize` are the prefix (#1157); status and headers are the server's, so it
	 * is a success with a flag. Always present live (absent is an old engine). Not the trace's
	 * `bodyTruncated` (storage shortening a body read whole): a re-send recovers that, not this.
	 */
	bodyCapped?: boolean;
}

export interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
	/**
	 * Which script called `pm.test` (#810). Absent is `"test"`: before #810 only post-request
	 * assertions were listed. The phase keeps a pre-request assertion from reading as one about the
	 * response.
	 */
	source?: ScriptSource;
	/** The level whose script asserted (#2522); absent means the request's own. */
	scope?: ElementScope;
}

/** Which `console.*` method a script line came from. Engine spellings. */
export type ConsoleLevel = "log" | "info" | "warn" | "error";

/**
 * Which of a request's two scripts produced a console line or assertion; the engine's spellings.
 */
export type ScriptSource = "pre" | "test";

/**
 * A console line; `source`/`level` are fields, not a `"[pre] "` prefix any log line could forge.
 */
export interface ConsoleLogEntry {
	source: ScriptSource;
	/**
	 * The level whose script printed the line (#2522), not {@link level} (the `console.*` method);
	 * absent is the request's own.
	 */
	scope?: ElementScope;
	level: ConsoleLevel;
	message: string;
	/** On a `pm.sendRequest` summary line: its record's index in `scriptRequests` (#3633). */
	scriptRequest?: number;
}

export interface SanityResult extends HttpResponse {
	requestId?: string;
	testResults?: TestResult[];
	/** This send's non-script element outcomes (#1512), beside `testResults`. */
	elements?: ElementOutcome[];
	/** `string`: an older engine's unstructured line, typed so `parse-logs.ts` needs no cast. */
	consoleLogs?: Array<ConsoleLogEntry | string>;
	preScriptError?: string;
	postScriptError?: string;
	/** Every `pm.sendRequest` the scripts made, pre before test (#3633). */
	scriptRequests?: ScriptRequestRecord[];
	/**
	 * Header names and query parameter the auth block wrote, each absent if none
	 * (`record_auth_provenance`, #1845), the live `RunResultTrace.request.authHeaders`. The Console
	 * masks values under these names (#3634).
	 */
	authHeaders?: string[];
	authQueryParam?: string;
	/**
	 * The method and URL the transfer was dialled with (`record_request_line`, #3650), as the
	 * trace's `request.method`/`url`. A pre-request script can retarget a send, so the Console's
	 * Send row lists these; the URL still holds an auth-written query value, masked by
	 * {@link authQueryParam}. Absent from older engines and from a stream's 202.
	 */
	method?: string;
	url?: string;
	/**
	 * The run this Send was recorded under (#3679), what the Console's "Open run" opens. Absent for
	 * a `transient` Send, older engines and a failed result write. A stream's 202 is no
	 * `SanityResult`; its run comes from `finalizeStreamRun`.
	 */
	runId?: string;
	error?: string;
	/**
	 * The response's schema verdict (#628). Absent when the collection binds no document: no node,
	 * not an unchecked verdict, so "never judged" stays apart from "checked, unreadable".
	 */
	validation?: ResponseValidation;
}

/**
 * A scenario load run's sequence so far on a gate frame (#2823): the stored summary's `scenario`
 * counters plus {@link meanIterationMs} (step percentiles are report-only). Read while workers
 * write, so figures may differ by completions landing between reads.
 */
export interface LiveScenarioProgress {
	/** Iterations started. */
	iterations: number;
	iterationsCompleted: number;
	iterationsAbandoned: number;
	stepsExecuted: number;
	/**
	 * Mean wall clock of completed passes so far, ms, timer waits included (#3570): the report's
	 * `scenario.passDuration.mean` so far. Absent, never `0`, until one completes or on older
	 * engines.
	 */
	meanIterationMs?: number;
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
 * Responses completed in `span` whole seconds from load start, beginning at `second`, by class
 * (#2866): `counts` is 2xx, 3xx, 4xx, 5xx, then any other code (no response included). A gate entry
 * has `span` 1; a folded History tick (`maxPoints`) covers its bucket, so `counts / span` is
 * per-second at either resolution.
 */
export interface StatusSecondEntry {
	second: number;
	span: number;
	counts: [number, number, number, number, number];
}

/**
 * A capacity search's state on a live frame (#2928), wire camelCase. `level` is the concurrency
 * measured (`0` before the first opens); `levelElapsedMs` the time in it (`0` at level `0`, frozen
 * once the search ends); `levelsJudged` counts each measurement of a level; `stopReason`
 * (`capacity.stopReason`) only once ended.
 */
export interface LiveCapacityState {
	level: number;
	levelElapsedMs: number;
	levelsJudged: number;
	stopReason?: string;
}

/**
 * A per-stream distribution over `count` streams; ms for `timeToFirstEvent` and `maxEventGap`,
 * events/s for `eventRate`.
 */
export interface StreamDistribution {
	p50: number;
	p95: number;
	p99: number;
	max: number;
	count: number;
}

export interface LoadTestMetrics {
	timestamp: number;
	elapsed_seconds: number;
	requests_completed: number;
	/** Errors so far (#2124), `http_errors + no_response`: non-2xx/3xx plus no-response. */
	requests_failed: number;
	/** The part of `requests_failed` that got a response. Absent on a tick stored by an older engine. */
	http_errors?: number;
	/** The part of `requests_failed` that got none (status code 0). Absent on a tick stored by an older engine. */
	no_response?: number;
	/** Completions per second over the trailing window (at least 1 s) to this tick (#2393). */
	current_rps: number;
	/**
	 * Dispatches per second over `current_rps`'s window; absent on older ticks, where run-wide
	 * `send_rate` must not stand in.
	 */
	current_send_rate?: number;
	/**
	 * Mean latency and queue wait of that window's completions: `null` if none completed, absent on
	 * older ticks; the run-wide `avg_latency_ms` must not stand in.
	 */
	window_avg_latency_ms?: number | null;
	window_avg_queue_wait_ms?: number | null;
	/**
	 * Mean requests on the wire over that window (in-flight time over its span, #3567), `0` when
	 * none were open. `current_concurrency` is an instant a user in a timer wait holds nothing at,
	 * so it flickers between 0 and N (#2821). Absent on older ticks.
	 */
	window_avg_in_flight?: number | null;
	current_concurrency: number;
	/**
	 * Tick latency percentiles: a stored tick's cover its whole second, merged (#2385); a live
	 * frame's only its last ~100 ms, so charts and thresholds go through `utils/tickPercentiles.ts`
	 * (`secondPercentiles`, `cumulativePercentiles`), never these keys. No completion (#2386) is
	 * `null` live, absent stored; older engines stored `0`.
	 */
	latency_p50_ms?: number | null;
	latency_p95_ms?: number | null;
	latency_p99_ms?: number | null;
	/**
	 * Set by `mapSseMetrics` on live frames only: tells a non-gate live frame from a stored tick,
	 * whose `latency_p*_ms` are per second.
	 */
	live?: true;
	/**
	 * Where the run's worker is (#3568), on every live frame; absent from stored ticks and older
	 * engines; never inferred.
	 */
	phase?: RunPhase;
	/**
	 * Completions behind `second_p*_ms`, on gate frames only (about one live frame a second, plus
	 * the last); 0 when idle.
	 */
	second_samples?: number;
	/** The gate frame's whole-second percentiles; `null` when `second_samples` is 0. */
	second_p50_ms?: number | null;
	second_p95_ms?: number | null;
	second_p99_ms?: number | null;
	/** Run-so-far percentiles (`avg_latency_ms`'s span), live only; `null` before a sample. */
	cumulative_p50_ms?: number | null;
	cumulative_p95_ms?: number | null;
	cumulative_p99_ms?: number | null;
	/**
	 * Run-so-far latency and phase distributions, gate frames only (#2782): `null` until something
	 * completes, absent elsewhere, so read the latest frame with the key
	 * (`utils/liveDistributions.ts`), not the newest tick. `cumulative_phases` is also absent with
	 * phase histograms off: absent is "not measured", `null` "nothing yet".
	 */
	cumulative_latency?: LiveLatencyDistribution | null;
	cumulative_phases?: LivePhaseDistributions | null;
	/**
	 * A scenario load run's sequence, on gate frames only (#2823): read the latest carrier
	 * (`utils/liveScenario.ts`), not the newest tick.
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
	 * Requests a `constant_rps` pacer owed past its catch-up window and skipped rather than burst
	 * (#2911), and the schedule time they cover; cumulative like `dropped_requests`, absent on
	 * older ticks.
	 */
	skipped_requests?: number;
	stalled_ms?: number;
	/** Mean queue wait over the whole run so far. */
	avg_queue_wait_ms?: number;
	// For the iterations-mode ETA; `requests_expected` is 0 for open-ended modes, which show none.
	requests_sent?: number;
	requests_expected?: number;
	// The tick's full status-code map, the same shape live and stored.
	status_codes?: Record<string, number>;
	/**
	 * Responses completed in the seconds this tick closed, by class (#2866; live `statusSeconds`).
	 * `[]` is a gate that closed none yet; absent on other live frames and older ticks, which tells
	 * the status chart to diff `status_codes` instead.
	 */
	status_seconds?: StatusSecondEntry[];
	/**
	 * The capacity search's state on every live frame of a capacity run (#2928), read by the live
	 * capacity view (#2929, item 2 of #2818). Absent otherwise or from older engines, never zeroed;
	 * never on a stored tick.
	 */
	capacity?: LiveCapacityState;
	/**
	 * A streaming load run's events (#3236): cumulative `stream_events`, `streams_open` at the
	 * sample, `events_per_second` over `current_rps`'s window. On every live frame of such a run
	 * and no other, so `0` is measured and absent is "not measured"; never stored.
	 */
	stream_events?: number;
	streams_open?: number;
	events_per_second?: number;
	/**
	 * Time to first event over completed streams, on gate frames once one completed with a timed
	 * first event, so read the latest carrier (`utils/liveStream.ts`). Not the First byte phase,
	 * which ends at the response headers.
	 */
	stream_time_to_first_event?: StreamDistribution;
	/**
	 * Custom trends, counters and rates so far (#1500); absent, not `{}`, before the first value.
	 * `RunReport.customMetrics`'s shape in snake_case: the stored key is `custom_metrics`, and
	 * `sse-client.ts` renames the live `customMetrics` (as it does `statusCodes`).
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
 * One element's tally in a load run's step (`StepElementTallies::build`, `scenario_load.cpp`):
 * {@link ElementOutcome}'s load sibling, counts over every user and iteration. One count per
 * sequential outcome word (#3051), so `missing` (an extractor found nothing) and `error` (a check
 * could not run) stand alone. `deferred` (#2144) is a `script.post` left to the post-run replay,
 * its verdicts in {@link RunReport.testValidation}; never `skipped`, which did not run (an
 * un-inlined `script.pre`, a disabled element). `required` is `true` only for an extractor whose
 * miss fails the step. Reports before #2144 count the replay as `skipped`, before #3051 lack the
 * five newer keys; both keep their numbers.
 */
export interface RunScenarioStepElementTally {
	id: string;
	kind: string;
	name?: string;
	origin?: ElementOrigin;
	required?: true;
	passed: number;
	failed: number;
	missing?: number;
	error?: number;
	skipped: number;
	deferred?: number;
	/**
	 * What an inline script element threw and each failing `pm.test` (#3127): the first 10
	 * distinct, each cut at 500 bytes. Absent, never `[]`, when none or on older rows.
	 */
	messages?: ElementTallyMessage[];
	/** Entries a full {@link messages} list turned away; absent when none were. */
	messagesDropped?: number;
	/** The script's console lines, bounded like {@link messages} and absent the same way. */
	console?: ElementTallyConsoleLine[];
	/** Entries a full {@link console} list turned away; absent when none were. */
	consoleDropped?: number;
}

/**
 * A `lifecycle.setup[]` / `teardown[]` row (#3455): {@link ElementOutcome} plus the script's words,
 * bounded like a tally row; `message` carries a failed row's reason (a failing `pm.test` included).
 * `scriptRequests` (#3633, sequential runs) lists every `pm.sendRequest` in call order, separately
 * because the `console` sample folds repeats and cannot index records.
 */
export interface LifecycleElementOutcome
	extends
		ElementOutcome,
		Pick<
			RunScenarioStepElementTally,
			"messages" | "messagesDropped" | "console" | "consoleDropped"
		> {
	scriptRequests?: ScriptRequestRecord[];
}

/** One thing an inline script element reported: the error it threw, or a failing test as `name: message`. */
export interface ElementTallyMessage {
	kind: "error" | "test";
	text: string;
	/** How many times it was reported; absent means once (and on a row from an engine before the field). */
	count?: number;
}

/** One console line an inline script element logged, with the `console.*` method that wrote it. */
export interface ElementTallyConsoleLine {
	level: ConsoleLevel;
	text: string;
	/** How many times it was logged; absent means once (and on a row from an engine before the field). */
	count?: number;
}

/**
 * A plan step's numbers in a scenario load report (`build_step_breakdown`), with identity: by
 * position alone a forty-step breakdown is unreadable.
 */
export interface RunScenarioStepStat {
	/** Position in the plan, 0-based and stable for the run. */
	index: number;
	/** `requests.name` - what the sequence calls this step. */
	name: string;
	/**
	 * An MCP step's `<method> <tool>` (#3829), e.g. `tools/call search`, drawn beside
	 * {@link name}; absent on every other step and before #3829.
	 */
	label?: string;
	requestId: string;
	method: string;
	/** Step executions across every virtual user and iteration. */
	executed: number;
	/**
	 * Error executions by the run's one definition (#2124), {@link httpErrors} +
	 * {@link noResponse}. Only no-response ends an iteration, so this alone does not explain later
	 * steps running less.
	 */
	errors: number;
	/** Of {@link errors}, 4xx/5xx responses; the iteration carries on. Absent before #2134. */
	httpErrors?: number;
	/**
	 * Of {@link errors}, executions with no response (transport error, never sent); these end the
	 * iteration. Absent before #2134.
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
	 * Executions sent with an unresolved `{{token}}` (#1503), counted since load mode runs no
	 * residual pass; 0 is an honest none.
	 */
	unresolvedTokens?: number;
	/** Extractor misses (#3053), one per missing extractor; absent, never `0`. */
	extractorMisses?: number;
	/**
	 * `"skipped"` for a step with a pre-request script, which load mode never runs
	 * ({@link RunReport.scenario}); absent otherwise.
	 */
	preRequestScript?: "skipped";
	/**
	 * This step's post-request script, replayed after the run against this step's responses (#450).
	 * Absent when it asserted nothing or never had a sampled response: not "zero failed", which is
	 * why the engine omits it rather than write zeros.
	 */
	tests?: {
		/** Sampled responses the script was replayed against. */
		sampled: number;
		passed: number;
		failed: number;
		/**
		 * The replay's console lines whatever its verdict (#3127): the first 10 distinct, shaped
		 * like {@link RunScenarioStepElementTally.console}; absent, never `[]`, if none or on older
		 * engines.
		 */
		console?: ElementTallyConsoleLine[];
		/** Occurrences a full {@link console} list turned away; absent when none were. */
		consoleDropped?: number;
	};
	/**
	 * This step's non-script elements tallied over every user and iteration (#1495); absent with
	 * none compiled or run; a never-run element is omitted, not zero, as for
	 * {@link unresolvedTokens} and {@link tests}.
	 */
	elements?: RunScenarioStepElementTally[];
}

/**
 * A `control.transaction` name's percentiles (#1515): a folder's members summed per pass; beside,
 * not in, {@link RunScenarioStepStat}, as it spans a folder.
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

/**
 * A load run's assertion block (#3537): every failed check its verdict reads, one shape for both
 * load kinds, on the report ({@link RunReport.assertions}) and the row
 * ({@link LoadResultSummary.assertions}). Underivable members are absent, not `0`: an older run has
 * only `exact` (and `sampled` if single-request). Read via `reportAssertionsOf` /
 * `rowAssertionsOf`.
 */
export interface RunAssertions {
	/** Every `assert.*` outcome, required `extract.*` miss and inline `pm.test` call. */
	exact?: AssertionPopulation;
	/** The deferred `pm.test` replay over the sampled responses (`testValidation`). */
	sampled?: AssertionPopulation;
	/** Element executions that ended in error: an inline script that threw, an element that could not run. */
	errored?: number;
	/** `lifecycle.teardown` rows whose outcome is `failed` or `error`. */
	teardownFailed?: number;
}

/** `RunReport.summary.errorClasses` (#3828): each class only when the run counted one. */
export interface ErrorClassCounts {
	transport?: number;
	protocol?: number;
	tool?: number;
	/** `protocol` split by JSON-RPC `error.code`; `"other"` for a code outside the reserved and server bands. */
	protocolCodes?: Record<string, number>;
}

export interface RunReport {
	/**
	 * What this run did not do (#1503): requests sent with an unresolved `{{token}}` (load mode
	 * runs no residual pass), a pre-request script that mode never runs, a per-host connection
	 * limit raised above its setting (#2394), requests libcurl re-sent on a new connection (#2799),
	 * `Set-Cookie` headers dropped (`cookies_dropped`, #3307). Named, never refused (a literal `{{`
	 * may be deliberate), so a green run and one sent unauthenticated differ. Absent, not empty, if
	 * none.
	 */
	warnings?: Array<{
		code: string;
		message: string;
		/**
		 * `unresolved_tokens`: requests affected; `connection_replayed`: requests re-sent;
		 * `cookies_dropped`: `Set-Cookie` headers dropped (the message states the count, never a
		 * name); `rate_limited_dominant` (#3782): the 429s; `retry_after_backoff`: the waited-out
		 * responses.
		 */
		count?: number;
		names?: string[];
		steps?: number;
		/** `per_host_limit_raised` (#2394): the setting, and the limit the run used. */
		configured?: number;
		effective?: number;
		/** `think_timer_skipped_open_loop` (#3541): the enabled timers skipped. */
		timers?: number;
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
		/**
		 * A collection run's identity from its snapshot, on every such report, finished or not
		 * (#3569), shaped like the list row's `scenario`. Unlike {@link RunReport.scenario}, built
		 * from the stored summary and absent for an unfinished run. Absent for single-request runs.
		 */
		scenario?: RunScenarioSummary;
		configuration?: {
			mode?: string;
			duration?: string;
			targetRps?: number;
			concurrency?: number;
			/** `iterations` asked: requests (single request) or passes (collection run, #3570). */
			iterations?: number;
			startConcurrency?: number;
			rampUpDuration?: string;
			timeout?: number;
			comment?: string;
			/** Carried-over `thresholds` keys as sent (#2195); absent when none or older. */
			carriedBudgets?: string[];
			/**
			 * A `capacity` run's step length as started (#2925) and the p99 budget searched; absent
			 * for other modes and when left at the default (the effective budget is
			 * {@link RunReport.capacity}'s `sloMs`). `CapacitySummary` reads `stepDuration`
			 * (#2927); nothing reads `sloMs` yet, and #2819 (the export's run table) is the next
			 * reader of both.
			 */
			stepDuration?: string;
			sloMs?: number;
			/**
			 * The requested protocol ({@link RunConfigSnapshot.httpVersion}), always set by
			 * `build_run_report_config` (`add_http_version`) despite the `?`; a loose `string` like
			 * its siblings since nothing is validated at runtime, so narrow with `isHttpVersion`
			 * first.
			 */
			httpVersion?: string;
			/** Sent by the engine since 0.11.0; not rendered anywhere yet. */
			followRedirects?: boolean;
			/** Sent by the engine since 0.11.0; not rendered anywhere yet. */
			maxRedirects?: number;
			/** See {@link RunSummary.acceptEncoding} (issue #1488). */
			acceptEncoding?: boolean;
			/**
			 * Whether `Expect: 100-continue` was allowed (#2516); only the baseline comparison
			 * reads it (absent as `false`); not on {@link RunSummary}.
			 */
			expectContinue?: boolean;
			/** `data` rows bound (#993); the rows are never stored. Absent without a data file. */
			dataRowCount?: number;
			/**
			 * File name and SHA-256 (#2051), not a path; absent without a file or on older runs.
			 */
			dataFileName?: string;
			dataFileHash?: string;
			/** Whether its numbers were read as numbers (issue #2540); absent means read as text. */
			dataFileCastNumbers?: boolean;
		};
		/**
		 * The document this run was measured against (#637), from its plan's snapshot, not today's
		 * binding. Absent for unbound and single-request runs: not measured is not measured against
		 * nothing.
		 */
		openapi?: {
			specId: string;
			specHash: string;
			/**
			 * The binding came from an ancestor of the run's collection (#716): an OpenAPI import
			 * binds the root and files requests in tag folders, so a tag folder's run is measured
			 * against the whole document. Absent means its own binding;
			 * {@link RunReport.coverage}'s block prints one line if set.
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
		 * Requests a Stop cancelled unanswered (#2136): no error and in no other count
		 * (`totalRequests`, status codes, `errorRate`). Absent from older engines, meaning none.
		 */
		cancelledRequests?: number;
		/**
		 * That Stop landed in the natural-end drain and cancelled requests (#3538): the answered
		 * ones are not the run, so `reportOutcome` leaves it unjudged.
		 */
		drainCut?: { cancelled: number };
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
		 * Load start to when submitting stopped, before the drain (#2392); absent on older runs,
		 * whose `sendRate` divided by `testDuration`.
		 */
		sendingDurationSeconds?: number;
		/**
		 * Completions when sending ended (#2882): over `sendingDurationSeconds`, a received rate on
		 * `sendRate`'s window. 0 is measured; absent on older runs.
		 */
		completedWhileSending?: number;
		/**
		 * Seconds from run entry to load start, `script.setup` included. Absent on runs stored
		 * before the split from `cleanupOverhead`, whose figure was the teardown time: never read
		 * it as setup.
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
		 * `constant_rps` only (#2911): requests skipped after a generator stall and the schedule ms
		 * they cover; absent on older runs, meaning none.
		 */
		skippedRequests?: number;
		stalledMs?: number;
		/** Absent where not recorded: `partial` or `summaryMissing` below, or a collection run (#2963). */
		avgQueueWaitMs?: number;
		bytesSent?: number;
		bytesReceived?: number;
		throughputBytesPerSec?: number;
		/**
		 * Transfers that asked for HTTP/2 and got older: the one `summary` figure about validity,
		 * not performance; non-zero means latency and throughput were measured on another protocol
		 * than `metadata.configuration.httpVersion` names (#215). `0` is "none recorded": engines
		 * from 0.15.0 always emit it, even when the summary predates the count or the report came
		 * from samples. Absent (an older sidecar) reads as `0`. Weaker than the per-response flag,
		 * exact per exchange.
		 */
		httpVersionDowngraded?: number;
		/**
		 * Requests libcurl re-sent on a new connection after a reused one was dropped or refused
		 * unanswered (#2799); each counts once in `totalRequests`, so the target got that plus
		 * this. The app shows the `connection_replayed` warning; the number is for MCP and exports.
		 * Unlike `httpVersionDowngraded`, `0` counted none and absent is an older or sample-built
		 * report.
		 */
		connectionReplays?: number;
		/**
		 * A failed load run reconciled after a crash (#2895): counts, `errorRate`, `statusCodes`,
		 * `avgRps`, duration and bytes are the last tick's totals, a floor; no `latency`,
		 * `peakConcurrency` or `avgQueueWaitMs` (not recorded, #2963). Absent means false.
		 */
		partial?: boolean;
		/**
		 * A failed load run with no summary at all (#2895: a crash before the first tick, a worker
		 * that never wrote one). Counts are the stored sampled results' (0 if none), not run totals
		 * or measurements; no `latency`, `peakConcurrency` or `avgQueueWaitMs`. Absent means false.
		 * Not the report's top-level `partial` (still in flight).
		 */
		summaryMissing?: boolean;
		/**
		 * Failed `mcp` replies by class (#3828): `transport` (no reply), `protocol` (JSON-RPC
		 * error), `tool` (`isError` result), each key only when counted. `protocolCodes` splits
		 * `protocol` by `error.code` (codes outside the reserved and server bands are `"other"`; an
		 * error without an integer code is in no bucket, so they can sum below it). `{}` counted
		 * none (every non-`mcp` run); absent is an older run, "not recorded", never 0.
		 */
		errorClasses?: ErrorClassCounts;
	};
	/**
	 * Absent when never recorded (`summary.partial`/`summaryMissing`, a collection run where no
	 * step sent); not zero (`formatLatencyOrDash`).
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
	 * Two independent halves: read each by its key, as treating presence as proof of either renders
	 * a phases-only report as five zeroed averages. `phases` come from histograms of every
	 * completion, absent only with `phaseHistograms` off, no success or an older run. The `avg*`
	 * are those histograms' means (#2782); without `phases`, or on older runs, they average the
	 * retained trace sample (1-in-N successes `save_timing_breakdown` keeps, plus slow outliers),
	 * absent with none.
	 */
	timingBreakdown?: {
		avgDnsMs?: number;
		avgConnectMs?: number;
		avgTlsMs?: number;
		avgFirstByteMs?: number;
		avgDownloadMs?: number;
		/**
		 * Whole-run percentiles per phase over every completion, not the trace sample; `count`
		 * matches across the five (fed together).
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
	 * A streaming run's completions (#576); absent is a run that did not stream, not one that got
	 * nothing, so the engine omits it rather than writing zeros.
	 *
	 * - `events` is per completion (500 streams of ~40 events: p50 near 40, not 20000);
	 *   `eventsPerSecond` is the whole-run rate on `rps`'s clock. Both, since one long stream and
	 *   250 short ones can share a rate.
	 * - `capped` counts completions a cap ended; all of them means the run measured its own bounds,
	 *   which the dashboard says.
	 * - `timeToFirstEvent` is not `phases.firstByte` (response headers): a gateway answering 200 at
	 *   once and then thinking is fast there, slow here (#3234). Absent with no timed event.
	 * - `maxEventGap` and `eventRate` (#3776): per-stream pacing that `eventsPerSecond` blends
	 *   away, over streams with two timed events; absent, never 0, otherwise.
	 * - `timeToFirstMatch` (#3774): `timeToFirstEvent` stopped at the first content marker, so a
	 *   preamble API's first token shows its real wait; absent, never 0, if nothing matched.
	 *
	 * `maxEventGap`, `eventRate` and `timeToFirstMatch` are report-only: no live frame carries
	 * them.
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
		/** Milliseconds, over the completions that delivered a timed event (`count`). */
		timeToFirstEvent?: StreamDistribution;
		/** Milliseconds, over the completions whose stream carried the first content marker (`count`). */
		timeToFirstMatch?: StreamDistribution;
		/** Milliseconds: each stream's largest pause between two consecutive events. */
		maxEventGap?: StreamDistribution;
		/** Events per second: each stream's own rate, the events after its first over first to last arrival. */
		eventRate?: StreamDistribution;
	};
	testValidation?: {
		samplesTested: number;
		testsPassed: number;
		testsFailed: number;
		successRate: number;
		/**
		 * The deferred replay's console lines whatever its verdict (#3127), single-request runs
		 * only (scenario: {@link RunScenarioStepStat.tests}); absent if none.
		 */
		console?: ElementTallyConsoleLine[];
		/** Occurrences a full {@link console} list turned away; absent when none were. */
		consoleDropped?: number;
	};
	/**
	 * The server-vitals scrape's record ({@link RunMonitorConfig}); absent means nothing was
	 * monitored, not zeros. The history view fetches `GET /runs/:id/monitor` on `samples`: an
	 * all-miss run has a section and a miss count but no series.
	 */
	monitor?: {
		samples: number;
		/** Scrapes that got no 2xx answer: the URL or the endpoint is at fault. */
		failures: number;
		/**
		 * 2xx answers with none of the requested names: the names are at fault (#3120). Absent on
		 * older runs, whose `failures` include them.
		 */
		noMatchScrapes?: number;
		/**
		 * The latest failure's cause (`HTTP <status>` or a fixed phrase: "timed out",
		 * "unreachable", ...); absent until one, and on older runs.
		 */
		lastError?: string;
		series: Record<string, { min: number; max: number; avg: number; count: number }>;
	};
	/**
	 * The verdict against the declared budgets ({@link RunThresholds}), pass/fail's aggregate half:
	 * `testValidation` replays per response and cannot assert a p99 or error rate. Absent means no
	 * budgets, not "passed nothing". `metric` is a loose `string`: a newer sidecar may judge a
	 * metric this build has no label for.
	 */
	thresholdValidation?: {
		checks: {
			metric: string;
			limit: number;
			/** Absent when `evaluated` is false - there is no measurement to show. */
			actual?: number;
			passed: boolean;
			/**
			 * False when the run had no sample for this metric (#1484), which would read as 0ms and
			 * pass an "at most" ceiling; absent (older reports) reads as evaluated.
			 */
			evaluated?: boolean;
			/**
			 * `maxAssertionFailureRatePct` only (#2892): the budget judges the worse of two
			 * populations, and an evaluated check names both. Exact: every `assert.*`, unmatched
			 * required `extract.*` and inline `pm.test`; sampled: the deferred `pm.test` replay
			 * over 1 in `sampleRate`. Absent before #2892 (`actual` is then the blended rate) and
			 * when unevaluated.
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
	 * The load run's assertion block (#3537): both populations, errored element executions and
	 * failed teardowns, judged or not. Absent when nothing asserted or errored, for sequential
	 * collection runs, and from older engines (`reportAssertionsOf` then derives it).
	 */
	assertions?: RunAssertions;
	/**
	 * Custom trends, counters and rates recorded via `metric.record` or `pm.metrics.trend` /
	 * `.counter` / `.rate` (#1500), keyed by the chosen name, hence an open key set. Absent, never
	 * `{}`, when none. A `"trend"` has the percentiles; a `"counter"` (running total) or `"rate"`
	 * (0-100 percent true) only `value`.
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
	 * Operations of the bound contract this run exercised and declared responses it saw (#629).
	 * **Absent, never zeros**, when not measured against a contract (unbound, single-request, or a
	 * document stored before the operation index). Computed against `metadata.openapi`'s planned
	 * document, so a later sync cannot rewrite an old report. **Exact**: counted per send and
	 * response, not from the bounded `results[]` sample.
	 */
	coverage?: RunCoverage;
	/**
	 * Responses checked against the bound document's schemas (#682, #681). **Absent, never zeros**,
	 * when nothing was checked (unbound, single-request, no response schemas). Same planned
	 * document as {@link RunReport.coverage}, read when the plan resolved. **`exact` says what the
	 * numbers are**: a load run checks its reservoirs at run end (a schema walk per completion
	 * would cost throughput), so it is sampled and renderers must say so; a collection run checks
	 * every step.
	 */
	schemaValidation?: RunSchemaValidation;
	/**
	 * `script.setup` / `script.teardown` outcomes (#1499), run once at `run.start` / `run.end` on
	 * the collection. A key exists only when its phase ran an element (`[]` would claim one ran);
	 * absent when neither is declared and for single-request runs.
	 */
	lifecycle?: {
		setup?: LifecycleElementOutcome[];
		teardown?: LifecycleElementOutcome[];
	};
	/**
	 * A single-request run's element outcomes over every submission (#1594, #1641), in
	 * {@link RunScenarioStepElementTally}'s shape like {@link RunScenarioStepStat.elements}. Absent
	 * for scenario runs (tallies under {@link RunReport.scenario}; never both) and with no
	 * `requestElements` or none run.
	 */
	elements?: RunScenarioStepElementTally[];
	/**
	 * OAuth 2.0 renewals during the run: the engine refreshes header-placed tokens mid-run and
	 * records each, so a run outliving its token is no unexplained 401 storm; `refreshFailures`
	 * with `lastError` explains 401s in `statusCodes` (the old credential kept). Absent when
	 * refresh was impossible (no OAuth 2.0, a non-expiring or query-placed token,
	 * `autoRefreshToken` off, an older sidecar), not "never needed".
	 */
	auth?: {
		/** Seconds into the run at which each successful refresh landed. */
		refreshes: { atSeconds: number }[];
		refreshFailures: number;
		lastError?: string;
	};
	/**
	 * A capacity run's adaptive search: the highest concurrency held within the latency budget,
	 * where it gave out, and per-level evidence; absent for other modes (a fixed target measures a
	 * point). No absent field is a zero: `maxHealthy*` is absent when the first level breached,
	 * `knee*` when the search ended other than by `slo_exceeded` or `errors_exceeded`, the error
	 * share (`maxErrorPct`, `kneeErrorPct`, `levels[].errorPct`, percent 0-100) when the engine did
	 * not judge errors. `saturation*`, only for `stopReason: "plateau"`, is the lowest healthy
	 * level within the plateau gain of the best throughput; older plateaus lack it, and their
	 * `maxHealthy*` is the last level tried, past where throughput stopped growing. `stopReason` is
	 * a loose `string`: a newer sidecar may stop for a reason this build cannot name.
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
	 * Records each bounded store thinned away. Past its cap a store replaces a uniformly chosen
	 * incumbent (reservoir retention), so survivors describe the whole run; all zeros means traces
	 * and tested responses are complete. Not about `results`, which the report route picks
	 * failures-first ({@link RunReport.resultsStored}, {@link RunReport.resultsCap}). Absent (an
	 * older summary or sidecar) is not "nothing dropped", so the UI asserts no completeness.
	 */
	sampling?: {
		/**
		 * Errors past `maxStoredErrors`: counted everywhere, no stored record. On older runs and
		 * design-mode collection runs `errors.types` is built from stored records, so this is what
		 * it missed; elsewhere `errors.types` is exact, so compare its sum with the no-response
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
		 * The **byte** budget (`max_response_sample_bytes`) ended a sample, which the count cannot
		 * show: both bounds report through it, but only this one breaks uniformity (the count cap
		 * displaces, a spent budget stops admitting), so the run is graded on the bodies that fit.
		 * Absent (older runs) is not `false` (`SampleRetentionNote`).
		 */
		responseSampleBudgetSpent?: boolean;
		/**
		 * Per-status exemplars refused with the store full (`max_exemplar_results`); non-zero only
		 * with more distinct codes than that.
		 */
		exemplarsDropped?: number;
		/** Samples with bodies dropped once `maxSampleBytes` ran out (headers, metadata kept). */
		sampleBodiesDropped?: number;
		/**
		 * Captured exchanges stored: non-zero means headers and bodies are held **verbatim**
		 * (capture never redacts), which the Samples tab warns on. Absent on older runs.
		 */
		responseBodiesCaptured?: number;
	};
	/**
	 * The sequence, on scenario reports only (omitted, not zeros, elsewhere). `stepsStored` vs
	 * `stepsExecuted` reads `results[]`: past `maxScenarioStoredSteps` fewer rows are kept, every
	 * non-passing one among them, so non-zero `stepsDropped` means missing successes, never
	 * failures.
	 */
	scenario?: {
		/**
		 * Iterations asked for (on a load run, started). `iterationsCompleted` +
		 * `iterationsAbandoned` fall short when a deadline or Stop cut some off: the Steps tab's
		 * "Iterations cut short".
		 */
		iterations: number;
		/** Iterations that finished - fewer when the run was stopped or errored. */
		iterationsCompleted: number;
		/** Step executions the run performed, whether or not their rows survived. */
		stepsExecuted: number;
		/**
		 * The outcomes (four on a load run, plus `stopped` on a collection run) are disjoint and
		 * sum to `stepsExecuted` (#2824), a load run counting per execution as a collection run
		 * does; engine 0.45.0 and earlier stored the old load meaning (`failed` was `httpErrors`,
		 * `passed` held skips).
		 */
		passed: number;
		/**
		 * Executions answered but failing an assertion; a 4xx or 5xx no assertion rejected is
		 * `passed` (`httpErrors` and `summary.failedRequests` count it).
		 */
		failed: number;
		/** Steps a controller or `pm.execution.skipRequest()` stopped before the wire. */
		skipped: number;
		/**
		 * Executions with no response, a thrown script (#2947) or an unhonourable jump (#2974), on
		 * both kinds. A thrown script does not end a load iteration, so there it is not
		 * `noResponse`'s sum: `iterationsAbandoned` is the abort count.
		 */
		errored: number;
		/**
		 * Steps a Stop or shutdown cut short (#3397), collection runs only; in no failure count,
		 * and the five sum to `stepsExecuted`. Absent (older) is `0`.
		 */
		stopped?: number;
		/**
		 * A scenario load run's exact assertions (#2820): every `assert.*` outcome, required
		 * `extract.*` miss and inline `pm.test`, per completion. Kept out of `passed`/`failed` and
		 * the error rate (HTTP-only), so assertions all failing on `200`s read 0% errors with
		 * non-zero `failed` here. An un-inlined script's sampled replay is `testValidation`.
		 * Absent, never `{0, 0}`, for none, for collection runs and older reports; read via
		 * `exactAssertionsOf`.
		 */
		assertions?: { passed: number; failed: number };
		/** Step rows the run kept - the length `results[]` should have. */
		stepsStored: number;
		stepsDropped: number;
		/**
		 * Plan positions errors cost a collection run (#2526): per iteration an `errored` step
		 * ended, the positions after it left untried, so a short run does not read as complete.
		 * Collection runs only; absent, not `0`, on load and older reports, saying nothing.
		 */
		stepsNotRun?: number;
		/**
		 * The run's `stopOnError`, echoed: the same counts describe a different run under it
		 * (#2526); absent with `stepsNotRun`.
		 */
		stopOnError?: boolean;
		/**
		 * Load mode only (#357): what `concurrency` meant, the number of virtual users each walking
		 * the plan with its own cookies. Its presence tells a scenario load report from a
		 * design-mode one, which has no users or breakdown and reports steps as `results[]` rows.
		 */
		virtualUsers?: number;
		/**
		 * Iterations a no-response step ended before the last step (an HTTP error does not), apart
		 * from `iterationsCompleted`: it explains a breakdown thinning towards the end.
		 */
		iterationsAbandoned?: number;
		/**
		 * Per-step latency and counts in plan order, load mode only: a scenario load run stores no
		 * per-step rows (one per step, iteration and user), so this is its record.
		 */
		steps?: RunScenarioStepStat[];
		/**
		 * Completed passes' duration, ms (#3570): a user's wall clock first step to last, timer
		 * waits included; abandoned passes untimed. Absent with none completed, design-mode runs,
		 * older engines.
		 */
		passDuration?: {
			count: number;
			mean: number;
			min: number;
			p50: number;
			p95: number;
			p99: number;
			max: number;
		};
		/**
		 * Every `control.transaction` name closed at least once (#1515), beside `steps` as it spans
		 * a folder; absent, never `[]`, if none.
		 */
		transactions?: RunTransactionSummary[];
	};
	/**
	 * Rows stored before the report's cap, beside `results` as `sampling` is optional; absent from
	 * older engines (#2210), not "nothing cut", so the UI says nothing.
	 */
	resultsStored?: number;
	/**
	 * The `results` cap: 100 for a single-request run, {@link RunReport.resultsStored} for a
	 * scenario run. Only `resultsStored > resultsCap` signals a selection: failures first (outside
	 * 2xx/3xx, status `0` included), then successes, listed by `timestamp`; not a uniform sample.
	 */
	resultsCap?: number;
	results?: Array<{
		/** Row id, the join to {@link RunSample.resultId}; absent before 0.15.0. */
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
 * A sampled load result's captured response (`GET /runs/:id/samples`), kept out of
 * {@link RunReport}: the report loads every result row per fetch and the dashboard polls it, so
 * bodies come only when a sample is expanded. Join on `resultId`.
 */
export interface RunSample {
	resultId: number;
	response: {
		headers: Record<string, string>;
		/**
		 * The stored body; absent when {@link RunSample.response.binary} is set, so a non-text body
		 * never reads as a response string.
		 */
		body?: string;
		/**
		 * `"base64"`: the stored bytes (not valid UTF-8, or holding a zero byte) in standard
		 * base64; absent or `"utf8"` is text. Decode via `decodeResponseBody`; never print a base64
		 * `body`.
		 */
		bodyEncoding?: "utf8" | "base64";
		/** Size of the body as received, before any truncation. */
		bodyBytes: number;
		/** `body` is a prefix; the response was larger than `maxSampleBodyBytes`. */
		bodyTruncated?: boolean;
		/** The capture budget ran out first, so only headers were kept; not an empty body. */
		bodyDropped?: boolean;
		/** Stored as a descriptor: size and content type, no bytes. */
		binary?: boolean;
		contentType?: string;
		/**
		 * The sample's stream (#657), parsed from the stored body by the live path's parser so the
		 * list means what the Events tab's does. Absent (not empty) for non-streams and rows before
		 * the wire count. `totalEvents` is that wire count, true even when `bodyTruncated` cut the
		 * parsed bytes; `eventsTruncated` covers that cut and the `sseMaxStoredEvents` cap. No
		 * `endReason`: under load, nothing per sample says whether a server close or one of two
		 * caps ended it.
		 */
		events?: Omit<RunResultStreamEvents, "endReason" | "startedAt">;
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
 * What startup did about a database it could not open (#922); every outcome but the first loses
 * data (the user returns to an empty workspace):
 *
 * - `restored_from_backup`: the `<db>.bak` passed validation and replaced it; only work since that
 *   backup is gone.
 * - `started_fresh_quarantined`: no backup, so it was moved aside for a fresh one (#984).
 * - `backup_also_corrupt`: the backup failed too and was left alone, not written over it.
 * - `deleted_corrupt`: **deleted** (by engines before #984, or after a failed quarantine rename);
 *   nothing to recover.
 *
 * The first three leave the bytes on disk at `quarantinedPath`.
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
	 * Where the unopenable database was moved (the file `sqlite3 <path> .recover` reads); absent
	 * for `deleted_corrupt` and pre-quarantine engines, so test it, never derive it from `outcome`.
	 */
	quarantinedPath?: string;
}

export interface EngineHealth {
	status: "ok";
	version: string;
	/** The `workers` setting in effect: the configured count, else the detected cores. */
	workers: number;
	/**
	 * Present only when this startup restored or deleted the database (`EngineRecovery`); absent on
	 * a clean start, a first run included.
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
	/** `text`: a multi-line `string` (a pasted PEM bundle, #706), so a textarea. */
	type: "integer" | "string" | "boolean" | "number" | "enum" | "text";
	label: string;
	description: string;
	category: string;
	default: string;
	min?: string;
	max?: string;
	/**
	 * The running engine keeps the old value until restarted; typed and always sent
	 * (`config_entry_json`), so nothing parses "(Requires Restart)" out of prose.
	 */
	requiresRestart: boolean;
	/**
	 * An internal with no everyday use (a lock pragma, a watchdog backoff), collapsed under
	 * "Advanced" at its category's bottom.
	 */
	advanced: boolean;
	/**
	 * Extra search terms the key, label and description never say ("ram" for `dbCacheSize`,
	 * "deadline" for `defaultTimeout`); always sent, `[]` if none. **Never rendered**, the
	 * deliberate exception to "written but never read": `buildSettingsIndex`
	 * (`lib/settings-index.ts`) reads it.
	 */
	keywords: string[];
	/**
	 * What a numeric value measures (`"ms"`, `"sec"`, `"days"`, `"bytes"` today); absent is a
	 * count, the key omitted rather than `null` (like `min` / `max` / `options`). Rendered once, as
	 * the input's suffix, so a description must not repeat it (the engine guards its seeds).
	 * `"bytes"` also formats value, range hint and default; other units show verbatim, so an
	 * unknown one shows.
	 */
	unit?: string;
	updatedAt: number;
	/**
	 * On `type: "enum"` entries only; the engine omits it (never `null`/`[]`) when stored options
	 * fail to parse (`routes/config.cpp`), so missing means nothing to offer, not a bug.
	 */
	options?: { value: string; label: string }[];
	/**
	 * A boolean entry in the same category this one is meaningless without (`correlationIdHeader`
	 * names `correlationIdEnabled`); `SettingsMain` nests the dependent under it, disabled while it
	 * reads `"false"`. Catalogue only, never sent on `POST /config`.
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
 * Engine settings categories, a copy of `seed_default_config`'s set; `ENGINE_SETTINGS_CATEGORIES`
 * gives each its sidebar row. An entry whose category is in neither is left out of the search
 * index, not shown under a missing heading.
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
 * The MCP guardrails, redeclared from `electron/mcp/config.ts` (the renderer cannot import
 * `electron/`) for Settings and the preload typings.
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
	 * Ceiling on an iterations-mode run's `iterations`, which `maxDurationSeconds` cannot bound.
	 */
	maxIterations: number;
	/** Ceiling on `maxResponseSamples`, the responses a load run keeps for sampled replay. */
	maxResponseSamples: number;
	/** When false (default), collection/environment write tools are disabled. */
	allowWrites: boolean;
	/**
	 * Off by default: `update_engine_config` refuses the `proxy*` keys and `customCaCertificates`,
	 * even with writes on.
	 */
	allowNetworkSettings: boolean;
	/**
	 * Off by default: MCP reads withhold secrets, auth and cookie values, proxy URL credentials.
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
 * Why an enabled server is not listening; mirrors `electron/mcp/status.ts`'s type, pinned by
 * `status.conformance.test.ts`.
 */
export interface McpStartError {
	/** `EADDRINUSE`: another program holds the port. `EACCES`: the OS refused the bind. */
	code: "EADDRINUSE" | "EACCES" | "other";
	message: string;
}

export interface McpStatus {
	running: boolean;
	/** The endpoint of the port in force while not running: it names the port, it is not usable. */
	url: string;
	/** Whether the MCP server is enabled (may be enabled-but-not-running on error). */
	enabled: boolean;
	/** The configured MCP port, the value for the port field (#3580). */
	port: number;
	/**
	 * The configured port awaits an engine restart (`url` names the one in force); main derives it,
	 * so it survives a reload.
	 */
	restartRequired: boolean;
	/** Enabled, not yet listening, not failed: nothing to report or retry (#3579). */
	starting: boolean;
	/** Set while the server is enabled and its last start failed. */
	error?: McpStartError;
	/** Where a Settings change set an unreadable `mcp-config.json` aside; absent if readable. */
	corruptCopy?: string;
	/** Why the port stored in `mcp-config.json` was unusable and the default is in use. */
	storedPortError?: string;
}

/**
 * The `mcp:setPort` answer, mirroring `McpSetPortResult` in `electron/mcp/status.ts`; `message`
 * says why a port was refused.
 */
export type McpSetPortResult = { ok: true; status: McpStatus } | { ok: false; message: string };

/** Clients Vayu can register itself with via their own CLI (one-click connect). */
export type McpConnectClient = "claude" | "vscode";

export interface McpConnectResult {
	ok: boolean;
	/**
	 * `"cli-not-found"`: the client's CLI is missing, so show the snippet; `"not-running"`: no
	 * listener, so nothing to register.
	 */
	reason?: "cli-not-found" | "error" | "unsupported" | "not-running";
	message?: string;
	/** Set when the client already had this endpoint registered, so nothing was run. */
	alreadyConnected?: boolean;
}

/**
 * A data family an MCP call can change, mirroring `MCP_DATA_ENTITIES`
 * (`electron/mcp/tools/contract.ts`), which owns the list but cannot be imported here
 * (`tsconfig.node.json`); the duplicate is pinned by
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
 * The `mcp:data-changed` payload: invalidation only, the renderer refetches through its query layer
 * (key mapping: `lib/mcp-invalidation.ts`).
 */
export interface McpDataChangedEvent {
	entity: McpDataEntity;
	/** The collection the call named, when it named one. */
	collectionId?: string;
	/** The saved request the call named, when it named one. */
	requestId?: string;
	/**
	 * The history run named; only tools that rewrite or remove an existing run send it (`stop_run`,
	 * `set_run_baseline`, `delete_run`).
	 */
	runId?: string;
	/**
	 * The webhook inbox named; only tools acting on an existing one send it (`stop_webhook_inbox`,
	 * `delete_webhook_inbox`, `clear_inbox_captures`, `update_inbox_response`).
	 */
	inboxId?: string;
	/** The mock server named: only `stop_mock_server` (`start_mock_server` has no id yet). */
	mockId?: string;
	/**
	 * The run this call started and the service watching it (#1419), the one field that is no scope
	 * hint: `useRunWatchers` attaches that stream to a run no app surface started, giving an
	 * agent's run the OS progress, keep-awake hold and finished notification without its tab open.
	 * Only on `start_load_run`'s and `run_collection`'s `run` event; other `run` tools name
	 * existing runs.
	 */
	startedRun?: StartedRun;
}

/**
 * A run an MCP call started; `kind` picks the owning service, since load and collection runs
 * publish different frames and the wrong one is a permanently empty view.
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
	 * Template entries only (`kind` 28): `context` keeps a `pm.response` template out of a
	 * pre-request editor, `group` is its heading. Both are the engine's: its completion table is
	 * the one source, and a renderer list would drift.
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
 * The `pm.*` TypeScript declarations, generated from the same completion table
 * (`GET /scripting/types`); they give Monaco hovers, signature help and typo diagnostics.
 * Generated, not hand-written: a local `pm.d.ts` would redeclare a surface the engine owns.
 */
export interface ScriptTypeDefinitionsResponse {
	version: string;
	engine: string;
	/** Model URI the declarations are registered under - `ts:vayu/pm.d.ts`. */
	libUri: string;
	/** The `.d.ts` source itself. */
	typeDefinitions: string;
}
