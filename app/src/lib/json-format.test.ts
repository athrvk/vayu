import { describe, expect, it } from "vitest";

import { formatJson } from "./json-format";

describe("formatJson", () => {
	it("indents by two spaces with a space after the colon", () => {
		const out = formatJson('{"a":1,"b":[1,2],"c":{"d":null}}');
		expect(out).toBe(
			[
				"{",
				'  "a": 1,',
				'  "b": [',
				"    1,",
				"    2",
				"  ],",
				'  "c": {',
				'    "d": null',
				"  }",
				"}",
			].join("\n")
		);
	});

	it("keeps member order and every digit of a large integer", () => {
		const out = formatJson('{"z":1,"a":{"id":9007199254740993},"10":2,"2":3}');
		expect(out).toContain("9007199254740993");
		expect(out.indexOf('"z"')).toBeLessThan(out.indexOf('"a"'));
		// Integer-like keys stay where they arrived instead of jumping to the front.
		expect(out.indexOf('"10"')).toBeLessThan(out.indexOf('"2"'));
		expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"10"'));
		expect(out).toBe(
			[
				"{",
				'  "z": 1,',
				'  "a": {',
				'    "id": 9007199254740993',
				"  },",
				'  "10": 2,',
				'  "2": 3',
				"}",
			].join("\n")
		);
	});

	it("keeps both members of a duplicated key", () => {
		expect(formatJson('{"a":1,"a":2}')).toBe('{\n  "a": 1,\n  "a": 2\n}');
	});

	it.each(["1e400", "-0", "0.10", "1E5", "-1.50e+3", "123456789012345678901234567890"])(
		"copies the number %s as written",
		(literal) => {
			expect(formatJson(`[${literal}]`)).toBe(`[\n  ${literal}\n]`);
		}
	);

	it("copies true, false and null", () => {
		expect(formatJson("[true,false,null]")).toBe("[\n  true,\n  false,\n  null\n]");
	});

	it("does not re-escape or re-quote what is inside a string", () => {
		const text = String.raw`{"k":"say \"hi\"\nthen \\ \/ é {not,a:token}"}`;
		expect(formatJson(text)).toBe(`{\n  "k": ${text.slice(5, -1)}\n}`);
	});

	it("tracks an escaped quote so a following comma is structure", () => {
		expect(formatJson(String.raw`["a\"",1]`)).toBe(String.raw`[
  "a\"",
  1
]`);
	});

	it("prints an empty object and array without a line break", () => {
		expect(formatJson("{}")).toBe("{}");
		expect(formatJson("[]")).toBe("[]");
		expect(formatJson('{"a":{},"b":[],"c":[{}]}')).toBe(
			'{\n  "a": {},\n  "b": [],\n  "c": [\n    {}\n  ]\n}'
		);
	});

	it("formats a bare scalar document", () => {
		expect(formatJson("12")).toBe("12");
		expect(formatJson('"x"')).toBe('"x"');
		expect(formatJson("null")).toBe("null");
	});

	it("drops whitespace around and between tokens", () => {
		expect(formatJson(' \n\t{ "a" :\r\n 1 , "b" : [ ] }\n ')).toBe(
			'{\n  "a": 1,\n  "b": []\n}'
		);
	});

	it("is idempotent", () => {
		const once = formatJson('{"a":[1,{"b":2}],"c":"x"}');
		expect(formatJson(once)).toBe(once);
	});

	it("handles a large document in linear time", () => {
		const items = Array.from({ length: 100_000 }, (_, i) => `{"id":${i},"name":"n${i}"}`);
		const text = `[${items.join(",")}]`;
		expect(text.length).toBeGreaterThan(2_000_000);
		const start = performance.now();
		const out = formatJson(text);
		// A quadratic pass over 2MB runs for hours; a linear one measured 1.6s
		// in a loaded full-suite run, so a tight bound here measured the runner.
		expect(performance.now() - start).toBeLessThan(20_000);
		expect(out).toBe(JSON.stringify(JSON.parse(text), null, 2));
	});

	it("bounds nesting instead of building an enormous result", () => {
		const deep = "[".repeat(2000) + "]".repeat(2000);
		expect(formatJson(deep)).toBe(deep);
	});
});

describe("formatJson on input that is not well-formed JSON", () => {
	const malformed = [
		"",
		"   ",
		'{"a":1',
		'{"a":1}}',
		'{"a":1} x',
		"{}{}",
		'{"a":"unterminated}',
		'{"a":"bad \\x escape"}',
		'{"a":"bad \\u12G4"}',
		'{"a":"raw\nnewline"}',
		'{"a":1,}',
		"[1,]",
		"[,1]",
		'{,"a":1}',
		'{"a" 1}',
		'{"a"::1}',
		"{1:2}",
		"{'a':1}",
		'{"a":01}',
		'{"a":+1}',
		'{"a":1.}',
		'{"a":.5}',
		'{"a":1e}',
		'{"a":-}',
		'{"a":tru}',
		'{"a":nul1}',
		'{"a":truex}',
		'{"a":NaN}',
		'{"a":undefined}',
		"[1 2]",
		"[}",
		"{]",
		'{"a":[1}',
		"]",
		"<html></html>",
		"﻿{}",
		'{"a":1}\u0000',
	];

	it("has a non-empty fixture list", () => {
		expect(malformed.length).toBeGreaterThan(20);
	});

	it.each(malformed)("returns %j as received", (text) => {
		expect(formatJson(text)).toBe(text);
	});

	it("agrees with JSON.parse on what is malformed", () => {
		for (const text of malformed) {
			expect(() => JSON.parse(text), JSON.stringify(text)).toThrow();
		}
	});
});

describe("formatJson against JSON.parse", () => {
	const documents = [
		'{"a":1}',
		'{"a":[1,2,{"b":[]}],"c":{"d":{"e":null}}}',
		"[]",
		"[[],[[]],{}]",
		'{"text":"line\\nbreak and \\"quotes\\""}',
		'{"n":[0,0.5,100,-0.00125]}',
		'["é☃", "😀"]',
		"true",
		'{"deep":{"deeper":{"deepest":[1,[2,[3,[4]]]]}}}',
	];

	it("has a non-empty fixture list", () => {
		expect(documents.length).toBeGreaterThan(5);
	});

	it.each(documents)("keeps the value of %s", (text) => {
		const out = formatJson(text);
		expect(out).not.toBe("");
		expect(JSON.parse(out)).toEqual(JSON.parse(text));
	});

	// Spellings the round trip normalises: the point of formatting without it.
	const respelled = ['{"text":"\\u2603\\/"}', '{"n":[-0,1e2,-1.25E-3,1.0]}'];

	it.each(respelled)("keeps the value of %s while keeping its spelling", (text) => {
		const out = formatJson(text);
		expect(JSON.parse(out)).toEqual(JSON.parse(text));
		expect(out).not.toBe(JSON.stringify(JSON.parse(text), null, 2));
		expect(out.replace(/\s+/g, "")).toBe(text);
	});

	it.each(documents)("matches JSON.stringify for %s, where a round trip is lossless", (text) => {
		expect(formatJson(text)).toBe(JSON.stringify(JSON.parse(text), null, 2));
	});
});
