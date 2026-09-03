/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request-reference walk: which `{{variable}}` names a request uses, and the
 * binder-versus-composer field-set split the column audit depends on (#1308).
 */

import { describe, it, expect } from "vitest";
import { bindableStrings, referencedVariableNames } from "./request-references";
import type { RequestReferenceSource } from "./request-references";
import type { FormFieldEntry, KeyValueEntry, RequestBody } from "@/types";

const kv = (key: string, value: string): KeyValueEntry => ({ key, value, enabled: true });

function source(overrides: Partial<RequestReferenceSource> = {}): RequestReferenceSource {
	return {
		url: "",
		params: [],
		headers: [],
		body: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		resolvedAuth: { mode: "none" },
		...overrides,
	};
}

describe("referencedVariableNames - what the request uses", () => {
	it("walks every templated field in first-seen order", () => {
		const fileField: FormFieldEntry = {
			key: "{{fkey}}",
			value: "{{fval}}",
			enabled: true,
			type: "file",
			src: "{{fsrc}}",
			fileName: "{{fname}}",
			contentType: "{{fct}}",
		};
		const body: RequestBody = { mode: "form-data", fields: [fileField] };

		const names = referencedVariableNames(
			source({
				url: "https://{{host}}/{{version}}",
				params: [kv("{{pkey}}", "{{pval}}")],
				headers: [kv("{{hkey}}", "{{hval}}")],
				body,
				resolvedAuth: { mode: "bearer", token: "{{authtok}}" },
				preRequestScript: 'pm.environment.get("scriptvar");',
			})
		);

		expect(names).toEqual([
			"host",
			"version",
			"pkey",
			"pval",
			"hkey",
			"hval",
			"fkey",
			"fval",
			"fsrc",
			"fname",
			"fct",
			"authtok",
			"scriptvar",
		]);
	});

	it("counts a name once, at its first appearance", () => {
		const names = referencedVariableNames(
			source({
				url: "https://{{host}}/{{host}}",
				headers: [kv("x-host", "{{host}}")],
			})
		);
		expect(names).toEqual(["host"]);
	});

	it("includes both halves of basic auth, after the request fields", () => {
		const names = referencedVariableNames(
			source({
				url: "https://{{host}}",
				resolvedAuth: { mode: "basic", username: "{{user}}", password: "{{pass}}" },
			})
		);
		expect(names).toEqual(["host", "user", "pass"]);
	});

	it("reads a pm.*.get() name but not a {{name}} typed in script text", () => {
		// The engine never interpolates a script (D16): the `{{tmplonly}}` reaches
		// the script verbatim and reads nothing, so it is not a reference; the
		// `pm.environment.get` call really reads its name.
		const names = referencedVariableNames(
			source({
				preRequestScript: 'const literal = "{{tmplonly}}";',
				postRequestScript: 'pm.environment.get("realvar");',
			})
		);
		expect(names).toEqual(["realvar"]);
	});

	it("does not read a pm.iterationData row name - that is the data contract", () => {
		const names = referencedVariableNames(
			source({ preRequestScript: 'pm.iterationData.get("plan");' })
		);
		expect(names).toEqual([]);
	});

	it("excludes data.* columns and $dynamic generators", () => {
		// `{{data.col}}` is a data-contract column and `{{$guid}}` resolves from the
		// generator table - neither is a variable the ladder defines, so neither is
		// a reference the section should mark undefined.
		const names = referencedVariableNames(
			source({ url: "https://{{host}}/{{data.col}}/{{$guid}}" })
		);
		expect(names).toEqual(["host"]);
	});

	it("returns nothing for a request that references nothing", () => {
		expect(referencedVariableNames(source({ url: "https://example.com" }))).toEqual([]);
	});
});

describe("bindableStrings - the binder-versus-composer field set", () => {
	const fileField: FormFieldEntry = {
		key: "name",
		value: "val",
		enabled: true,
		type: "file",
		src: "{{fsrc}}",
		fileName: "{{fname}}",
		contentType: "{{fct}}",
	};
	const body: RequestBody = { mode: "form-data", fields: [fileField] };

	it("leaves a form-data file part's src/fileName/contentType out by default (the data binder's set)", () => {
		const strings = bindableStrings(source({ body }));
		expect(strings).not.toContain("{{fsrc}}");
		expect(strings).not.toContain("{{fname}}");
		expect(strings).not.toContain("{{fct}}");
		// The name and value are still walked, as the binder walks them.
		expect(strings).toContain("name");
		expect(strings).toContain("val");
	});

	it("includes them when asked (the composer's set)", () => {
		const strings = bindableStrings(source({ body }), { includeFileFields: true });
		expect(strings).toContain("{{fsrc}}");
		expect(strings).toContain("{{fname}}");
		expect(strings).toContain("{{fct}}");
	});
});
