/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	hasJsonTemplateSentinel,
	maskGraphqlTemplates,
	maskJsonTemplates,
	maskJsonTemplatesInPlace,
	rangesOverlap,
	unmaskJsonTemplates,
} from "./templates";

describe("maskGraphqlTemplates", () => {
	it("replaces each token with a same-length GraphQL Name", () => {
		const { masked } = maskGraphqlTemplates("query { user(id: {{userId}}) { name } }");
		expect(masked).toBe("query { user(id: VVVVVVVVVV) { name } }");
		// Length is the whole point: the markers that come back carry offsets into
		// this string and are used against the original.
		expect(masked.length).toBe("query { user(id: {{userId}}) { name } }".length);
	});

	it("reports each token's 1-based span, across lines", () => {
		const { spans } = maskGraphqlTemplates(
			'query {\n  user(id: {{a}}) {\n    name(q: "{{b}}")\n  }\n}'
		);
		expect(spans).toEqual([
			{ startLineNumber: 2, startColumn: 12, endLineNumber: 2, endColumn: 17 },
			{ startLineNumber: 3, startColumn: 14, endLineNumber: 3, endColumn: 19 },
		]);
	});

	it("leaves text without tokens exactly as it was", () => {
		const source = "query { user(id: 1) { name } }";
		expect(maskGraphqlTemplates(source)).toEqual({ masked: source, spans: [] });
	});
});

describe("rangesOverlap", () => {
	const span = { startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 10 };

	it("is true for a range inside the span", () => {
		expect(
			rangesOverlap(
				{ startLineNumber: 2, startColumn: 6, endLineNumber: 2, endColumn: 8 },
				span
			)
		).toBe(true);
	});

	it("is false for a range that only touches its edges", () => {
		expect(
			rangesOverlap(
				{ startLineNumber: 2, startColumn: 10, endLineNumber: 2, endColumn: 12 },
				span
			)
		).toBe(false);
		expect(
			rangesOverlap(
				{ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 },
				span
			)
		).toBe(false);
	});

	it("compares line before column", () => {
		expect(
			rangesOverlap(
				{ startLineNumber: 1, startColumn: 99, endLineNumber: 3, endColumn: 1 },
				span
			)
		).toBe(true);
		expect(
			rangesOverlap(
				{ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 99 },
				span
			)
		).toBe(false);
	});
});

describe("maskJsonTemplates", () => {
	it("makes a token in value position parse, and puts it back", () => {
		const source = '{"limit": {{n}}}';
		const { masked, tokens } = maskJsonTemplates(source);
		expect(tokens).toEqual(["{{n}}"]);
		expect(JSON.parse(masked)).toEqual({ limit: expect.any(String) });
		expect(unmaskJsonTemplates(JSON.stringify(JSON.parse(masked)), tokens)).toBe(
			'{"limit":{{n}}}'
		);
	});

	it("leaves a token that is already inside a string alone", () => {
		// This text is valid JSON as it stands; masking it would break it.
		const source = '{"id": "{{userId}}"}';
		expect(maskJsonTemplates(source)).toEqual({ masked: source, tokens: [] });
	});

	it("masks only the out-of-string tokens when a document mixes both", () => {
		const { masked, tokens } = maskJsonTemplates('{"a": "{{x}}", "b": {{y}}}');
		expect(tokens).toEqual(["{{y}}"]);
		const parsed = JSON.parse(masked) as { a: string; b: string };
		expect(parsed.a).toBe("{{x}}");
		expect(unmaskJsonTemplates(JSON.stringify(parsed), tokens)).toBe('{"a":"{{x}}","b":{{y}}}');
	});

	it("is not fooled by a quote that is escaped inside a string", () => {
		const source = '{"a": "he said \\"{{x}}\\"", "b": {{y}}}';
		const { tokens } = maskJsonTemplates(source);
		expect(tokens).toEqual(["{{y}}"]);
	});

	it("ignores an unterminated or nested brace pair", () => {
		expect(maskJsonTemplates("{{unclosed").tokens).toEqual([]);
		expect(maskJsonTemplates("{{a{b}}").tokens).toEqual([]);
		expect(maskJsonTemplates("{{}}").tokens).toEqual([]);
	});

	it("numbers several tokens so each returns to its own place", () => {
		const { masked, tokens } = maskJsonTemplates('{"a": {{first}}, "b": {{second}}}');
		expect(tokens).toEqual(["{{first}}", "{{second}}"]);
		expect(unmaskJsonTemplates(JSON.stringify(JSON.parse(masked)), tokens)).toBe(
			'{"a":{{first}},"b":{{second}}}'
		);
	});
});

describe("maskJsonTemplatesInPlace", () => {
	it("keeps every offset, because the markers come back as offsets", () => {
		const source = '{\n  "limit": {{n}},\n  "name": "x"\n}';
		const { masked, spans } = maskJsonTemplatesInPlace(source);
		expect(masked).toBe('{\n  "limit": "VVV",\n  "name": "x"\n}');
		expect(masked.length).toBe(source.length);
		expect(JSON.parse(masked)).toEqual({ limit: "VVV", name: "x" });
		expect(spans).toEqual([
			{ startLineNumber: 2, startColumn: 12, endLineNumber: 2, endColumn: 17 },
		]);
	});

	it("masks a token in key position too", () => {
		const { masked } = maskJsonTemplatesInPlace("{{{key}}: 1}");
		expect(JSON.parse(masked)).toEqual({ VVVVV: 1 });
	});

	it("leaves a token that is already inside a string alone", () => {
		const source = '{"id": "{{userId}}"}';
		expect(maskJsonTemplatesInPlace(source)).toEqual({ masked: source, spans: [] });
	});

	it("spans several tokens across lines", () => {
		const { masked, spans } = maskJsonTemplatesInPlace('{\n "a": {{x}},\n "b": {{yy}}\n}');
		expect(JSON.parse(masked)).toEqual({ a: "VVV", b: "VVVV" });
		expect(spans).toEqual([
			{ startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 12 },
			{ startLineNumber: 3, startColumn: 7, endLineNumber: 3, endColumn: 13 },
		]);
	});

	it("leaves text without tokens exactly as it was", () => {
		const source = '{"limit": 5}';
		expect(maskJsonTemplatesInPlace(source)).toEqual({ masked: source, spans: [] });
	});
});

describe("hasJsonTemplateSentinel", () => {
	it("sees a placeholder that nobody unmasked", () => {
		const { masked, tokens } = maskJsonTemplates('{"a": {{x}}}');
		expect(hasJsonTemplateSentinel(JSON.stringify(JSON.parse(masked)))).toBe(true);
		expect(hasJsonTemplateSentinel(unmaskJsonTemplates(masked, tokens))).toBe(false);
	});

	it("does not fire on ordinary text", () => {
		expect(hasJsonTemplateSentinel('{"a":"vayu:tpl:0"}')).toBe(false);
	});
});
