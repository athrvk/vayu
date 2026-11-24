/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file server.schema-dialect.test.ts
 * @brief `tools/list` names no JSON Schema dialect on a tool schema, because
 *        2020-12 is what a client assumes without one (#3748).
 */

import { describe, it, expect } from "vitest";
import { stripDefaultSchemaDialect } from "./server.js";
import { HOSTS, listTools } from "./tool-list.testkit.js";

describe("tools/list schema dialect (#3748)", () => {
	const DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

	describe.each(HOSTS)("on the %s host", (host) => {
		it.each([false, true])(
			"names no dialect on any tool schema, writes %s",
			async (allowWrites) => {
				const { tools } = await listTools({
					host,
					allowWrites,
					revealSecretsToAgents: false,
				});
				const schemas = tools.flatMap((tool) =>
					[tool.inputSchema, tool.outputSchema].filter((schema) => schema !== undefined)
				);
				// A scan over no schemas would pass forever; every tool has an input schema.
				expect(schemas.length).toBeGreaterThan(tools.length);
				expect(schemas.filter((schema) => "$schema" in schema)).toEqual([]);
			}
		);
	});

	describe("stripDefaultSchemaDialect", () => {
		const otherDialect = "http://json-schema.org/draft-07/schema#";

		it("drops the 2020-12 key from input and output schemas, and only that key", () => {
			const out = stripDefaultSchemaDialect({
				tools: [
					{
						name: "t",
						inputSchema: { $schema: DIALECT_2020_12, type: "object" },
						outputSchema: { $schema: DIALECT_2020_12, type: "object" },
					},
				],
			});
			expect(out).toEqual({
				tools: [
					{
						name: "t",
						inputSchema: { type: "object" },
						outputSchema: { type: "object" },
					},
				],
			});
		});

		it("keeps a schema that declares another dialect", () => {
			const tool = {
				name: "t",
				inputSchema: { $schema: otherDialect, type: "object" },
				outputSchema: { $schema: DIALECT_2020_12, type: "object" },
			};
			const [out] = stripDefaultSchemaDialect({ tools: [tool] }).tools;
			expect(out.inputSchema).toEqual({ $schema: otherDialect, type: "object" });
			expect(out.outputSchema).toEqual({ type: "object" });
		});

		it("accepts a tool without an outputSchema, and an answer without tools", () => {
			const [out] = stripDefaultSchemaDialect({
				tools: [{ name: "t", inputSchema: { $schema: DIALECT_2020_12 } }],
			}).tools;
			expect(out).toEqual({ name: "t", inputSchema: {} });
			expect("outputSchema" in out).toBe(false);
			expect(stripDefaultSchemaDialect({ nextCursor: "c" })).toEqual({ nextCursor: "c" });
		});

		it("leaves a property named $schema alone", () => {
			const inputSchema = {
				$schema: DIALECT_2020_12,
				properties: { $schema: { $schema: DIALECT_2020_12, type: "string" } },
			};
			const [out] = stripDefaultSchemaDialect({ tools: [{ name: "t", inputSchema }] }).tools;
			expect(out.inputSchema).toEqual({
				properties: { $schema: { $schema: DIALECT_2020_12, type: "string" } },
			});
		});

		it("does not mutate its input", () => {
			const answer = {
				tools: [{ name: "t", inputSchema: { $schema: DIALECT_2020_12, type: "object" } }],
			};
			const before = structuredClone(answer);
			stripDefaultSchemaDialect(answer);
			expect(answer).toEqual(before);
		});
	});
});
