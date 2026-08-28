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
 * engine-side, and the engine does no `{{…}}` interpolation. This table is a
 * genuine second implementation of `engine/src/http/request_composer.cpp`'s
 * C++ table, held in parity with it only by the shared conformance fixture
 * (`engine/tests/fixtures/variable-resolution-conformance.json`) and by
 * matching value shapes - there is no shared source.
 */

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
 * Deliberately not `lib/id.ts`'s `generateUUID`, which is `Math.random`-based:
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

const DIGITS = "0123456789";
const HEX_DIGITS = "0123456789abcdef";

const CITIES = [
	"Spinkahaven",
	"North Berenice",
	"Lake Gerardo",
	"East Jessyca",
	"Port Rico",
	"New Halle",
	"South Rylan",
	"West Kaley",
	"Fort Amir",
	"Port Adrien",
] as const;

const STREET_NAMES = [
	"Harvey Streets",
	"Kuhlman Junction",
	"Rippin Field",
	"Bahringer Turnpike",
	"Lockman Isle",
	"Konopelski Mount",
	"Schuppe Village",
	"Reilly Circle",
	"Torphy Fords",
	"Larson Union",
] as const;

const COUNTRIES = [
	"Bahamas",
	"Norway",
	"Lao People's Democratic Republic",
	"Guinea-Bissau",
	"Chile",
	"Iceland",
	"Nepal",
	"Uruguay",
	"Slovenia",
	"Rwanda",
] as const;

const COUNTRY_CODES = ["CV", "NO", "LA", "GW", "CL", "IS", "NP", "UY", "SI", "RW"] as const;

const WORDS = [
	"withdrawal",
	"synergistic",
	"sticky",
	"copying",
	"grocery",
	"bandwidth",
	"override",
	"haptic",
	"protocol",
	"matrix",
] as const;

const LOREM_WORDS = [
	"lorem",
	"ipsum",
	"dolor",
	"sit",
	"amet",
	"consectetur",
	"adipisicing",
	"elit",
	"sed",
	"eiusmod",
	"tempor",
	"incidunt",
	"labore",
	"dolore",
	"magna",
	"aliqua",
	"vel",
	"repellat",
	"nobis",
	"voluptas",
	"molestias",
	"consequuntur",
	"quod",
	"perspiciatis",
] as const;

const COLORS = [
	"red",
	"fuchsia",
	"grey",
	"cyan",
	"maroon",
	"olive",
	"teal",
	"azure",
	"lime",
	"plum",
] as const;

const USER_AGENTS = [
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
] as const;

const ABBREVIATIONS = [
	"SQL",
	"PCI",
	"JSON",
	"HTTP",
	"XML",
	"API",
	"TCP",
	"SSL",
	"JBOD",
	"AGP",
] as const;

const CURRENCY_CODES = [
	"CDF",
	"USD",
	"EUR",
	"GBP",
	"JPY",
	"INR",
	"BRL",
	"ZAR",
	"AUD",
	"SEK",
] as const;

const PRODUCT_ADJECTIVES = [
	"Handmade",
	"Refined",
	"Rustic",
	"Ergonomic",
	"Intelligent",
	"Practical",
	"Sleek",
	"Generic",
] as const;

const PRODUCT_MATERIALS = ["Concrete", "Steel", "Wooden", "Cotton", "Granite", "Rubber"] as const;

const PRODUCT_NOUNS = [
	"Tuna",
	"Chair",
	"Table",
	"Keyboard",
	"Shirt",
	"Bike",
	"Ball",
	"Soap",
] as const;

const JOB_DESCRIPTORS = [
	"International",
	"Regional",
	"Global",
	"Central",
	"National",
	"District",
	"Corporate",
	"Dynamic",
] as const;

const JOB_AREAS = [
	"Creative",
	"Operations",
	"Marketing",
	"Applications",
	"Accounts",
	"Data",
	"Research",
	"Infrastructure",
] as const;

const JOB_TYPES = [
	"Liaison",
	"Manager",
	"Engineer",
	"Analyst",
	"Architect",
	"Consultant",
	"Coordinator",
	"Strategist",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

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

function joinWords(items: readonly string[], count: number): string {
	return Array.from({ length: count }, () => pick(items)).join(" ");
}

function loremSentence(): string {
	const sentence = joinWords(LOREM_WORDS, randomInt(4, 9));
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function loremSentences(count: number): string {
	return Array.from({ length: count }, () => loremSentence()).join(" ");
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * `Date.prototype.toString`'s exact format, but pinned to UTC: the engine twin
 * has no user's zone, so both sides must spell the same string regardless of
 * where this runs. Neither `toString`, `toUTCString` nor `toLocaleString`
 * produces it - hence building it field by field off the UTC getters.
 */
function jsDateString(date: Date): string {
	const weekday = WEEKDAYS[date.getUTCDay()];
	const month = MONTHS[date.getUTCMonth()];
	const day = pad2(date.getUTCDate());
	const year = date.getUTCFullYear();
	const hours = pad2(date.getUTCHours());
	const minutes = pad2(date.getUTCMinutes());
	const seconds = pad2(date.getUTCSeconds());
	return `${weekday} ${month} ${day} ${year} ${hours}:${minutes}:${seconds} GMT+0000 (Coordinated Universal Time)`;
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
	{
		name: "$randomPhoneNumber",
		description: "Ten-digit phone number",
		generate: () =>
			`${randomInt(200, 999)}-${randomString(3, DIGITS)}-${randomString(4, DIGITS)}`,
	},
	{
		name: "$randomCity",
		description: "City name",
		generate: () => pick(CITIES),
	},
	{
		name: "$randomStreetAddress",
		description: "Street address",
		generate: () => `${randomInt(100, 9999)} ${pick(STREET_NAMES)}`,
	},
	{
		name: "$randomCountry",
		description: "Country name",
		generate: () => pick(COUNTRIES),
	},
	{
		name: "$randomCountryCode",
		description: "ISO 3166-1 alpha-2 country code",
		generate: () => pick(COUNTRY_CODES),
	},
	{
		name: "$randomDatePast",
		description: "Datetime within the past year",
		generate: () => jsDateString(new Date(Date.now() - randomInt(1, 365 * 86400) * 1000)),
	},
	{
		name: "$randomDateFuture",
		description: "Datetime within the next year",
		generate: () => jsDateString(new Date(Date.now() + randomInt(1, 365 * 86400) * 1000)),
	},
	{
		name: "$randomDateRecent",
		description: "Datetime within the past week",
		generate: () => jsDateString(new Date(Date.now() - randomInt(1, 7 * 86400) * 1000)),
	},
	{
		name: "$randomWord",
		description: "One word",
		generate: () => pick(WORDS),
	},
	{
		name: "$randomWords",
		description: "Three to five words",
		generate: () => joinWords(WORDS, randomInt(3, 5)),
	},
	{
		name: "$randomLoremWord",
		description: "One lorem ipsum word",
		generate: () => pick(LOREM_WORDS),
	},
	{
		name: "$randomLoremWords",
		description: "Three lorem ipsum words",
		generate: () => joinWords(LOREM_WORDS, 3),
	},
	{
		name: "$randomLoremSentence",
		description: "One lorem ipsum sentence",
		generate: loremSentence,
	},
	{
		name: "$randomLoremSentences",
		description: "Two to six lorem ipsum sentences",
		generate: () => loremSentences(randomInt(2, 6)),
	},
	{
		name: "$randomLoremParagraph",
		description: "A lorem ipsum paragraph",
		generate: () => loremSentences(randomInt(3, 5)),
	},
	{
		name: "$randomColor",
		description: "Color name",
		generate: () => pick(COLORS),
	},
	{
		name: "$randomHexColor",
		description: "Hex color, e.g. #47594a",
		generate: () => `#${randomString(6, HEX_DIGITS)}`,
	},
	{
		name: "$randomUserAgent",
		description: "Browser user-agent string",
		generate: () => pick(USER_AGENTS),
	},
	{
		name: "$randomDomainName",
		description: "Domain under a reserved example domain",
		generate: () => `${pick(FIRST_NAMES).toLowerCase()}.${pick(DOMAINS)}`,
	},
	{
		name: "$randomAbbreviation",
		description: "Abbreviation, e.g. SQL",
		generate: () => pick(ABBREVIATIONS),
	},
	{
		name: "$randomPrice",
		description: "Price between 0.00 and 1000.00",
		generate: () => {
			const cents = randomInt(0, 100000);
			return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
		},
	},
	{
		name: "$randomCurrencyCode",
		description: "ISO 4217 currency code",
		generate: () => pick(CURRENCY_CODES),
	},
	{
		name: "$randomProductName",
		description: "Product name",
		generate: () =>
			`${pick(PRODUCT_ADJECTIVES)} ${pick(PRODUCT_MATERIALS)} ${pick(PRODUCT_NOUNS)}`,
	},
	{
		name: "$randomJobTitle",
		description: "Job title",
		generate: () => `${pick(JOB_DESCRIPTORS)} ${pick(JOB_AREAS)} ${pick(JOB_TYPES)}`,
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
