/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Dynamic variables - `{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}`, …
 *
 * A `{{name}}` starting with `$` is not looked up in any scope; it names a
 * **generator** that is called where it is written. Postman and Bruno both have
 * these, so a collection imported from either arrives full of them - and before
 * this table they resolved to an empty string, which made a broken import look
 * like a working one.
 *
 * Two rules the implementation turns on:
 *
 * - **Per occurrence, not per request.** Every entry is a function called once
 *   per `{{…}}` match, so two `{{$guid}}` in one body differ. A table of
 *   pre-computed values would satisfy every other test and fail this one, which
 *   is the entire point of a `$guid`.
 * - **A user-defined variable of the same name wins.** The resolver consults its
 *   scope map first and only falls through to this table, so a collection that
 *   already defines a literal `$guid` variable keeps the value it had.
 *
 * **This is app-side, at interpolation time** (see `docs/app/variable-resolution.md`).
 * `pm.variables.get("$guid")` inside a script is *not* covered - scripts run
 * engine-side, and the engine does no `{{…}}` interpolation. This copy is
 * mirrored in `app/electron/mcp/resolve.ts` for the MCP client, which cannot
 * import from `app/src/`; the two must change together (CLAUDE.md), and
 * `resolve.test.ts` compares the two name sets.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";

/** One generator: the name as written (with `$`), what it makes, and how. */
export interface DynamicVariable {
	/** Name including the leading `$`, e.g. `"$guid"`. */
	name: string;
	/** One line for the autocomplete list - what a value looks like. */
	description: string;
	/** Called once per occurrence. Never returns the same value by design. */
	generate: () => string;
}

/**
 * `crypto` rather than `Math.random`: these values stand in for ids and
 * credentials in real requests, and a load test firing thousands of them is
 * exactly where a weak generator's collisions show up. Both hosts provide it -
 * the renderer is a secure context, the MCP main process is Node 22.
 */
function randomInt(minInclusive: number, maxInclusive: number): number {
	const span = maxInclusive - minInclusive + 1;
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return minInclusive + (buf[0] % span);
}

function pick(items: readonly string[]): string {
	return items[randomInt(0, items.length - 1)];
}

/**
 * RFC 4122 v4, built on `getRandomValues` rather than `crypto.randomUUID` so the
 * renderer, the MCP main process and the test environments all take the same
 * path - `randomUUID` needs a secure context and is absent from some of them.
 * Deliberately not `utils/id.ts`'s `generateUUID`, which is `Math.random`-based:
 * that one stamps an `X-Request-ID` header, this one can end up as the primary
 * key a load test writes a few hundred thousand times.
 */
function uuidV4(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PASSWORD_CHARS = `${ALPHANUMERIC}!@#$%^&*_-+=`;

const FIRST_NAMES = [
	"Ada",
	"Ravi",
	"Mina",
	"Jonas",
	"Priya",
	"Elena",
	"Omar",
	"Sofia",
	"Kenji",
	"Nora",
] as const;

const LAST_NAMES = [
	"Lovelace",
	"Iyer",
	"Kowalski",
	"Okafor",
	"Rossi",
	"Nakamura",
	"Haddad",
	"Silva",
	"Novak",
	"Petrov",
] as const;

const COMPANY_WORDS = ["Northwind", "Acme", "Umbra", "Lumen", "Kestrel", "Basalt"] as const;
const COMPANY_SUFFIXES = ["Inc", "LLC", "Group", "Labs", "Systems"] as const;
const DOMAINS = ["example.com", "example.org", "example.net", "test.dev"] as const;

function randomString(length: number, alphabet: string): string {
	let out = "";
	for (let i = 0; i < length; i++) out += alphabet[randomInt(0, alphabet.length - 1)];
	return out;
}

function firstName(): string {
	return pick(FIRST_NAMES);
}

function lastName(): string {
	return pick(LAST_NAMES);
}

/**
 * The set Vayu supports, in the order the autocomplete offers it: the identity
 * and time generators first, because they are what imported collections use
 * most, then the `$random*` faker values.
 *
 * Postman's own list runs to about a hundred faker entries. This is the
 * documented subset rather than a partial copy of the rest: a name that is not
 * here does not silently produce an empty string, it stays written as
 * `{{$name}}` in the outgoing request (see `resolveDynamicVariable`).
 */
export const DYNAMIC_VARIABLES: readonly DynamicVariable[] = [
	{
		name: "$guid",
		description: "UUID v4",
		generate: uuidV4,
	},
	{
		name: "$randomUUID",
		description: "UUID v4",
		generate: uuidV4,
	},
	{
		name: "$timestamp",
		description: "Unix time in seconds",
		generate: () => String(Math.floor(Date.now() / 1000)),
	},
	{
		name: "$isoTimestamp",
		description: "ISO 8601 UTC timestamp",
		generate: () => new Date().toISOString(),
	},
	{
		name: "$randomInt",
		description: "Integer 0 - 1000",
		generate: () => String(randomInt(0, 1000)),
	},
	{
		name: "$randomAlphaNumeric",
		description: "One alphanumeric character",
		generate: () => randomString(1, ALPHANUMERIC),
	},
	{
		name: "$randomBoolean",
		description: '"true" or "false"',
		generate: () => (randomInt(0, 1) === 1 ? "true" : "false"),
	},
	{
		name: "$randomEmail",
		description: "Email address",
		generate: () => `${firstName().toLowerCase()}.${lastName().toLowerCase()}@${pick(DOMAINS)}`,
	},
	{
		name: "$randomFirstName",
		description: "First name",
		generate: firstName,
	},
	{
		name: "$randomLastName",
		description: "Last name",
		generate: lastName,
	},
	{
		name: "$randomFullName",
		description: "Full name",
		generate: () => `${firstName()} ${lastName()}`,
	},
	{
		name: "$randomCompanyName",
		description: "Company name",
		generate: () => `${pick(COMPANY_WORDS)} ${pick(COMPANY_SUFFIXES)}`,
	},
	{
		name: "$randomUrl",
		description: "HTTPS URL",
		generate: () => `https://${pick(COMPANY_WORDS).toLowerCase()}.${pick(DOMAINS)}`,
	},
	{
		name: "$randomIP",
		description: "IPv4 address",
		generate: () => [0, 0, 0, 0].map(() => String(randomInt(0, 255))).join("."),
	},
	{
		name: "$randomPassword",
		description: "15-character password",
		generate: () => randomString(15, PASSWORD_CHARS),
	},
] as const;

const BY_NAME = new Map(DYNAMIC_VARIABLES.map((v) => [v.name, v]));

/**
 * True for a name written as a dynamic variable, whether or not this table has
 * it. The `$` prefix is the user's declaration of intent, and it is what lets a
 * typo be told apart from an undefined ordinary variable.
 */
export function isDynamicVariableName(name: string): boolean {
	return name.startsWith("$");
}

/** True only for a name this table can generate - `$guid` yes, `$guidd` no. */
export function isKnownDynamicVariable(name: string): boolean {
	return BY_NAME.has(name);
}

/**
 * Generate a value for `name` (including the `$`), or `null` when the table
 * does not have it.
 *
 * `null` rather than `""` is the whole contract: the caller leaves an unknown
 * `{{$typo}}` written as it stands, so it reaches the request visibly and the
 * token stays marked unresolved in the UI. An empty string here would recreate
 * the defect this table exists to fix, one typo at a time.
 */
export function resolveDynamicVariable(name: string): string | null {
	return BY_NAME.get(name)?.generate() ?? null;
}

/**
 * Does this string contain at least one *known* dynamic variable?
 *
 * Used by the load-test dialog: interpolation happens once, app-side, before the
 * run payload is sent, so every iteration of a run carries the same generated
 * value. That is a caveat the user has to be told rather than a bug to hide -
 * see `docs/app/variable-resolution.md`.
 */
export function containsDynamicVariable(input: string | undefined | null): boolean {
	if (!input) return false;
	for (const match of input.matchAll(VARIABLE_PATTERN)) {
		if (isKnownDynamicVariable(match[1].trim())) return true;
	}
	return false;
}
