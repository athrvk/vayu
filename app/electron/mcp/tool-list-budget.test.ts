/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tool-list-budget.test.ts
 * @brief Holds `tools/list`, and the server instructions that ship with it, to
 *        fixed byte ceilings (#2441, #3558).
 *
 * Every session pays for the whole list before it does anything, and an agent's
 * context is the scarce resource. The ceilings are the owner's, not the diff's:
 * constants that do not follow the code, one for a session with writes off and
 * one for writes on, applied to both hosts and both reveal settings. A change
 * that needs bytes removes bytes somewhere else; it never raises a ceiling.
 * They are interim values that only move down, and #3751 is where they reach
 * their final ones.
 *
 * The instructions have a ceiling of their own, so text moved out of the
 * descriptions into them cannot escape the budget. The shapes that keep the
 * list small are checked in `tool-list-shape.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { TOOLS, isListed } from "./tools.js";
import {
	MIN_LISTED_TOOLS,
	SESSIONS,
	WRITES_AND_REVEAL,
	listTools,
	type ListedTool,
	type Session,
} from "./tool-list.testkit.js";
import type { McpHost } from "./tools/contract.js";

/** Serialized `tools/list` bytes a session may not exceed. */
const CEILING_WRITES_OFF = 156_000;
const CEILING_WRITES_ON = 226_000;

/** UTF-8 bytes the server instructions of any one session may not exceed. */
const INSTRUCTIONS_CEILING = 8_100;

const LARGEST_TOOLS_SHOWN = 5;

const ceilingFor = ({ allowWrites }: Session) =>
	allowWrites ? CEILING_WRITES_ON : CEILING_WRITES_OFF;

const byteLength = (value: unknown) =>
	Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");

/** The tools taking the most room, largest first, as `name (bytes)`. */
function largestTools(tools: ListedTool[]): string {
	return tools
		.map((tool) => ({ name: tool.name, bytes: byteLength(tool) }))
		.sort((a, b) => b.bytes - a.bytes)
		.slice(0, LARGEST_TOOLS_SHOWN)
		.map(({ name, bytes }) => `${name} (${bytes} B)`)
		.join(", ");
}

const describeSession = ({ host, allowWrites, revealSecretsToAgents }: Session) =>
	`host ${host}, writes ${allowWrites}, reveal ${revealSecretsToAgents}`;

describe.each(SESSIONS)(
	"tools/list size budget, host $host, writes $allowWrites, reveal $revealSecretsToAgents",
	(session) => {
		it("lists the tools the registry declares for the session", async () => {
			const { tools, config } = await listTools(session);
			const declared = TOOLS.filter((tool) => isListed(tool, config)).map(
				(tool) => tool.name
			);
			expect(declared.length).toBeGreaterThan(MIN_LISTED_TOOLS);
			expect(tools.map((tool) => tool.name)).toEqual(declared);
		});

		it("stays under the fixed byte ceiling", async () => {
			const { tools } = await listTools(session);
			const bytes = byteLength(tools);
			const ceiling = ceilingFor(session);
			expect(bytes).toBeGreaterThan(0);
			const overshoot = Math.max(0, bytes - ceiling);
			expect(
				bytes,
				`tools/list for ${describeSession(session)} is ${bytes} B, ${overshoot} B over its ` +
					`${ceiling} B ceiling. Largest tools: ${largestTools(tools)}. ` +
					"fixed ceiling (#3558): remove bytes, do not raise"
			).toBeLessThanOrEqual(ceiling);
		});

		it("keeps the server instructions under their own ceiling", async () => {
			const { instructions } = await listTools(session);
			const bytes = byteLength(instructions);
			expect(bytes).toBeGreaterThan(0);
			expect(
				bytes,
				`server instructions for ${describeSession(session)} are ${bytes} B, ` +
					`${Math.max(0, bytes - INSTRUCTIONS_CEILING)} B over their ${INSTRUCTIONS_CEILING} B ` +
					"ceiling. fixed ceiling (#3558): remove bytes, do not raise"
			).toBeLessThanOrEqual(INSTRUCTIONS_CEILING);
		});
	}
);

describe("tools/list budgets", () => {
	// The CLI's remedy wording is longer than the app's, so measuring the app
	// twice would pass every CLI session; the two lists have to differ.
	it.each(WRITES_AND_REVEAL)(
		"measure the cli host's own wording, writes %s, reveal %s",
		async (allowWrites, revealSecretsToAgents) => {
			const serialized = async (host: McpHost) =>
				JSON.stringify(
					(await listTools({ host, allowWrites, revealSecretsToAgents })).tools
				);
			expect(await serialized("cli")).not.toBe(await serialized("app"));
		}
	);
});
