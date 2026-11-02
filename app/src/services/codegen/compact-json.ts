/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A strict JSON reader that answers the text the engine's `nlohmann::dump ()`
 * would write, so a snippet can carry the bytes a JSON-RPC body goes out as.
 *
 * `JSON.parse` + `JSON.stringify` cannot stand in. A JS object hoists
 * integer-like keys (`{"b":1,"1":2}` comes back `1` first) where the engine's
 * `ordered_json` keeps the author's order, and a JS number forgets its spelling
 * (a 20-digit integer loses digits, `1e3` is `1000` where the engine writes
 * `1000.0`). This reader keeps members in a `Map`, whose insertion order is the
 * author's and whose `set` on a repeated key keeps the first position and the
 * last value, as `ordered_json` does, and re-spells numbers the way nlohmann
 * does:
 *
 * - an integer with no fraction or exponent is written as its digits when it
 *   fits a signed or unsigned 64-bit integer (`-0` is `0`), and is a float
 *   otherwise;
 * - a float is written from its shortest round-trip digits: `1.0` stays `1.0`,
 *   `1e3` is `1000.0`, `1e30` is `1e+30`, `1e-5` is `1e-05`, with fixed
 *   notation only while the decimal point sits within 15 places of the digits
 *   and 4 below them (`format_buffer` in nlohmann's `to_chars.hpp`);
 * - a zero is `0.0` or `-0.0`, and a float past the double range (`1e999`) is
 *   not a document at all: nlohmann refuses it as a number overflow.
 *
 * Known residue: nlohmann prints floats with Grisu2, which is not always the
 * shortest round-trip digit string; `toExponential ()` here always is. Floats
 * of 16-17 digits differ in roughly 0.1% of cases, and integers at or above
 * 2^64 with trailing zeros in roughly 10% (`10300000000000000000000` is
 * `1.0300000000000001e+22` from the engine and `1.03e+22` here). Both spellings
 * parse to the same double, so a server reads the same number.
 *
 * The grammar is nlohmann's: RFC 8259 with a tolerated UTF-8 byte-order mark,
 * and no comments or trailing commas. A string holding a lone surrogate is
 * refused, as nlohmann refuses an invalid `\u` pair.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";

/** A value read from the text, with the compact spelling the engine writes it in. */
export type JsonNode =
	| { kind: "object"; text: string; members: Map<string, JsonNode> }
	| { kind: "string" | "other"; text: string };

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** The app's `{{name}}` token, sticky so it matches at the reader's position only. */
const TEMPLATE_TOKEN = new RegExp(VARIABLE_PATTERN.source, "y");
const HEX4 = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES = '"\\/bfnrt';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UINT64_MAX = 18446744073709551615n;
const INT64_MIN = -9223372036854775808n;
/** `std::numeric_limits<double>::digits10`, nlohmann's fixed-notation ceiling. */
const MAX_FIXED_EXPONENT = 15;
const MIN_FIXED_EXPONENT = -4;

/** The text is not one JSON document. Thrown inside the reader, never leaked. */
class Malformed extends Error {}

/** An object as nlohmann writes it: members in order, no whitespace. */
export function compactObject(members: ReadonlyMap<string, JsonNode>): string {
	const parts: string[] = [];
	for (const [key, value] of members) parts.push(`${JSON.stringify(key)}:${value.text}`);
	return `{${parts.join(",")}}`;
}

/** An integer-looking token as nlohmann reads it: 64-bit exactly, a float beyond. */
function integerText(token: string): string | undefined {
	const value = BigInt(token);
	return value >= INT64_MIN && value <= UINT64_MAX ? value.toString() : undefined;
}

function exponentText(exponent: number): string {
	const digits = String(Math.abs(exponent)).padStart(2, "0");
	return `${exponent < 0 ? "-" : "+"}${digits}`;
}

/** A finite, non-zero magnitude as nlohmann's `format_buffer` lays it out. */
function floatDigitsText(magnitude: number): string {
	const [mantissa, exponent] = magnitude.toExponential().split("e");
	const digits = mantissa.replace(".", "");
	const length = digits.length;
	// The value is 0.<digits> x 10^pointAt, as nlohmann's `n`.
	const pointAt = Number(exponent) + 1;

	if (length <= pointAt && pointAt <= MAX_FIXED_EXPONENT) {
		return `${digits}${"0".repeat(pointAt - length)}.0`;
	}
	if (pointAt > 0 && pointAt <= MAX_FIXED_EXPONENT) {
		return `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
	}
	if (pointAt > MIN_FIXED_EXPONENT && pointAt <= 0) {
		return `0.${"0".repeat(-pointAt)}${digits}`;
	}
	const lead = length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
	return `${lead}e${exponentText(pointAt - 1)}`;
}

function floatText(token: string): string {
	const value = Number(token);
	if (!Number.isFinite(value)) throw new Malformed();
	const sign = Object.is(value, -0) || value < 0 ? "-" : "";
	if (value === 0) return `${sign}0.0`;
	return `${sign}${floatDigitsText(Math.abs(value))}`;
}

/** The compact spelling nlohmann writes for a number token. */
function numberText(token: string): string {
	const isIntegerToken = !/[.eE]/.test(token);
	return (isIntegerToken ? integerText(token) : undefined) ?? floatText(token);
}

/** What the reader accepts beyond strict JSON. */
export interface ReadOptions {
	/**
	 * Read a `{{name}}` token in value position as an opaque value written as
	 * typed. The engine resolves tokens before it reads the body, so text that
	 * still holds `[{{a}},{{b}}]` is the document it will read once they are
	 * numbers. Keys and string contents are unaffected: a token is a value only
	 * where a value can start.
	 */
	templateTokens?: boolean;
}

class Reader {
	private i = 0;

	constructor(
		private readonly source: string,
		private readonly maxDepth: number,
		private readonly options: ReadOptions
	) {}

	readDocument(): JsonNode {
		// nlohmann skips one UTF-8 byte-order mark before the document.
		if (this.source.charCodeAt(0) === 0xfeff) this.i = 1;
		const root = this.readValue(0);
		this.skipWhitespace();
		if (this.i !== this.source.length) throw new Malformed();
		return root;
	}

	private skipWhitespace(): void {
		while (WHITESPACE.has(this.source.charCodeAt(this.i))) this.i++;
	}

	private expect(char: string): void {
		this.skipWhitespace();
		if (this.source[this.i] !== char) throw new Malformed();
		this.i++;
	}

	private readValue(depth: number): JsonNode {
		this.skipWhitespace();
		// Before the object case: `{{` opens a token, and no JSON object opens with `{{`.
		const token = this.readTemplateToken();
		if (token) return token;
		const char = this.source[this.i];
		if (char === "{") return this.readObject(depth + 1);
		if (char === "[") return this.readArray(depth + 1);
		if (char === '"') {
			const text = this.readString();
			return { kind: "string", text: JSON.stringify(text) };
		}
		for (const literal of ["true", "false", "null"]) {
			if (!this.source.startsWith(literal, this.i)) continue;
			this.i += literal.length;
			return { kind: "other", text: literal };
		}
		return this.readNumber();
	}

	private readTemplateToken(): JsonNode | undefined {
		if (!this.options.templateTokens) return undefined;
		TEMPLATE_TOKEN.lastIndex = this.i;
		const match = TEMPLATE_TOKEN.exec(this.source);
		if (!match) return undefined;
		this.i += match[0].length;
		return { kind: "other", text: match[0] };
	}

	private enter(depth: number): void {
		if (depth > this.maxDepth) throw new Malformed();
	}

	private readObject(depth: number): JsonNode {
		this.enter(depth);
		this.i++;
		const members = new Map<string, JsonNode>();
		this.skipWhitespace();
		if (this.source[this.i] === "}") {
			this.i++;
			return { kind: "object", text: "{}", members };
		}
		for (;;) {
			this.skipWhitespace();
			if (this.source[this.i] !== '"') throw new Malformed();
			const key = this.readString();
			this.expect(":");
			members.set(key, this.readValue(depth));
			this.skipWhitespace();
			const next = this.source[this.i++];
			if (next === "}") return { kind: "object", text: compactObject(members), members };
			if (next !== ",") throw new Malformed();
		}
	}

	private readArray(depth: number): JsonNode {
		this.enter(depth);
		this.i++;
		const items: string[] = [];
		this.skipWhitespace();
		if (this.source[this.i] === "]") {
			this.i++;
			return { kind: "other", text: "[]" };
		}
		for (;;) {
			items.push(this.readValue(depth).text);
			this.skipWhitespace();
			const next = this.source[this.i++];
			if (next === "]") return { kind: "other", text: `[${items.join(",")}]` };
			if (next !== ",") throw new Malformed();
		}
	}

	/** A string token decoded. The scan finds where the token ends and checks its escapes; `JSON.parse` only decodes what that accepted. */
	private readString(): string {
		const start = this.i++;
		for (;;) {
			const code = this.source.charCodeAt(this.i);
			if (Number.isNaN(code) || code < 0x20) throw new Malformed();
			if (code === 0x22) break;
			if (code !== 0x5c) {
				this.i++;
				continue;
			}
			const escape = this.source[this.i + 1];
			if (escape === "u" && HEX4.test(this.source.slice(this.i + 2, this.i + 6))) {
				this.i += 6;
			} else if (escape !== undefined && SIMPLE_ESCAPES.includes(escape)) {
				this.i += 2;
			} else {
				throw new Malformed();
			}
		}
		this.i++;
		const decoded = JSON.parse(this.source.slice(start, this.i)) as string;
		if (LONE_SURROGATE.test(decoded)) throw new Malformed();
		return decoded;
	}

	private readNumber(): JsonNode {
		NUMBER.lastIndex = this.i;
		const match = NUMBER.exec(this.source);
		if (!match) throw new Malformed();
		this.i += match[0].length;
		return { kind: "other", text: numberText(match[0]) };
	}
}

/**
 * The document in @p source, or undefined when it is not one strict JSON
 * document or a container nests deeper than @p maxDepth (the outermost is 1, as
 * the engine's `parse_ordered_json` counts). A document deep enough to exhaust
 * the stack is unreadable too.
 */
export function readCompactJson(
	source: string,
	maxDepth: number = Number.POSITIVE_INFINITY,
	options: ReadOptions = {}
): JsonNode | undefined {
	try {
		return new Reader(source, maxDepth, options).readDocument();
	} catch (error) {
		if (error instanceof Malformed || error instanceof RangeError) return undefined;
		throw error;
	}
}
