/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file dynamic-variables.ts
 * @brief Dynamic variables (`{{$guid}}`, `{{$timestamp}}`, …) for the MCP client.
 *
 * The main-process twin of `app/src/lib/dynamic-variables.ts`. It is a copy
 * because `electron/` shares no module graph with `app/src/` (see the docblock
 * in `resolve.ts`), and it is the same deliberate duplication the variable and
 * auth resolution already carry: **the two must change together** (CLAUDE.md),
 * and `resolve.test.ts` fails if their name sets drift apart.
 *
 * Everything about the semantics lives in the renderer copy's docblock; the
 * short version is that each entry is called once per `{{…}}` occurrence, a
 * user-defined variable of the same name wins, and a name this table does not
 * have is left written as `{{$name}}` rather than resolving to an empty string.
 */

/** One generator: the name as written (with `$`), what it makes, and how. */
export interface DynamicVariable {
	/** Name including the leading `$`, e.g. `"$guid"`. */
	name: string;
	/** One line describing the value - kept in step with the renderer copy. */
	description: string;
	/** Called once per occurrence. Never returns the same value by design. */
	generate: () => string;
}

function randomInt(minInclusive: number, maxInclusive: number): number {
	const span = maxInclusive - minInclusive + 1;
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return minInclusive + (buf[0] % span);
}

function pick(items: readonly string[]): string {
	return items[randomInt(0, items.length - 1)];
}

/** RFC 4122 v4 over `getRandomValues` - same construction as the renderer copy. */
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

/** The supported set - same names, same order as the renderer copy. */
export const DYNAMIC_VARIABLES: readonly DynamicVariable[] = [
	{ name: "$guid", description: "UUID v4", generate: uuidV4 },
	{ name: "$randomUUID", description: "UUID v4", generate: uuidV4 },
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
	{ name: "$randomFirstName", description: "First name", generate: firstName },
	{ name: "$randomLastName", description: "Last name", generate: lastName },
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

/** True for a name written as a dynamic variable, known to this table or not. */
export function isDynamicVariableName(name: string): boolean {
	return name.startsWith("$");
}

/** True only for a name this table can generate - `$guid` yes, `$guidd` no. */
export function isKnownDynamicVariable(name: string): boolean {
	return BY_NAME.has(name);
}

/**
 * Generate a value for `name` (including the `$`), or `null` when the table does
 * not have it - the caller leaves an unknown `{{$typo}}` written as it stands.
 */
export function resolveDynamicVariable(name: string): string | null {
	return BY_NAME.get(name)?.generate() ?? null;
}
