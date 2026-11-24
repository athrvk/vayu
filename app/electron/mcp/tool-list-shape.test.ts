/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tool-list-shape.test.ts
 * @brief Holds `tools/list` to the shape that keeps it under its ceilings
 *        (#2441, #3747; the ceilings are in `tool-list-budget.test.ts`).
 *
 * A rule that tool descriptions would repeat lives once in the server
 * instructions, and a tool carries a one-line pointer. A long argument
 * description is stated on one argument and every other argument sharing it
 * points there (`asOn`), unless `SHARED_ARGUMENT_DESCRIPTIONS` names it with the
 * reason.
 */

import { describe, it, expect } from "vitest";
import { environmentIdInput } from "./tools/input-schemas.js";
import {
	MIN_LISTED_TOOLS,
	SESSIONS,
	argumentDescriptions,
	listTools,
} from "./tool-list.testkit.js";

/** A sentence this long, repeated across tools, is a rule that belongs in the instructions. */
const LONG_SENTENCE_CHARS = 150;
const MAX_TOOLS_PER_LONG_SENTENCE = 3;

/** An argument description this long is stated on one argument; the others point at it. */
const LONG_ARGUMENT_CHARS = 80;

/** Argument descriptions repeated on purpose, each with the reason it is. */
const SHARED_ARGUMENT_DESCRIPTIONS = new Map<string, string>([
	[
		environmentIdInput.description ?? "",
		"#2480: every tool that takes environmentId states the one default at the argument, so a preview and a send cannot come to describe different ones (tools/variables.tools.test.ts pins it)",
	],
]);

/** What a pointer description names: the tool whose same-named argument says it in full. */
const POINTER = /^As on `(\w+)`/;

/** Each sentence of 150+ characters with the names of the tools whose description holds it. */
function longSentenceUsers(descriptions: [string, string][]): Map<string, string[]> {
	const users = new Map<string, string[]>();
	for (const [name, text] of descriptions) {
		const sentences = new Set(
			text.split(". ").filter((sentence) => sentence.length >= LONG_SENTENCE_CHARS)
		);
		for (const sentence of sentences)
			users.set(sentence, [...(users.get(sentence) ?? []), name]);
	}
	return users;
}

describe.each(SESSIONS)(
	"tools/list shape, host $host, writes $allowWrites, reveal $revealSecretsToAgents",
	(session) => {
		it(`repeats no ${LONG_SENTENCE_CHARS}+ character sentence in more than ${MAX_TOOLS_PER_LONG_SENTENCE} descriptions`, async () => {
			const { tools } = await listTools(session);
			const descriptions = tools.map((tool): [string, string] => [
				tool.name,
				tool.description ?? "",
			]);
			// A scan over empty descriptions would pass forever.
			expect(tools.length).toBeGreaterThan(MIN_LISTED_TOOLS);
			expect(descriptions.filter(([, text]) => text.length > 0).length).toBe(tools.length);

			const repeated = [...longSentenceUsers(descriptions)]
				.filter(([, names]) => names.length > MAX_TOOLS_PER_LONG_SENTENCE)
				.map(
					([sentence, names]) =>
						`${names.length} tools (${names.join(", ")}): ${sentence}`
				);
			expect(repeated).toEqual([]);
		});

		it(`states each ${LONG_ARGUMENT_CHARS}+ character argument description on one argument`, async () => {
			const { tools } = await listTools(session);
			const descriptions = tools.flatMap(argumentDescriptions);
			// A walk that found nothing would pass forever.
			expect(descriptions.length).toBeGreaterThan(0);

			const holders = new Map<string, string[]>();
			for (const { where, text } of descriptions) {
				if (text.length < LONG_ARGUMENT_CHARS || SHARED_ARGUMENT_DESCRIPTIONS.has(text))
					continue;
				holders.set(text, [...(holders.get(text) ?? []), where]);
			}
			const repeated = [...holders]
				.filter(([, where]) => where.length > 1)
				.map(([text, where]) => `${where.length} arguments (${where.join(", ")}): ${text}`);
			expect(repeated).toEqual([]);
		});

		it("points every `As on` description at a listed tool stating that member", async () => {
			const { tools } = await listTools(session);
			const descriptions = tools.flatMap(argumentDescriptions);
			const pointers = descriptions.filter(({ text }) => POINTER.test(text));
			expect(pointers.length).toBeGreaterThan(0);

			const stated = new Set(
				descriptions
					.filter(({ text }) => !POINTER.test(text))
					.map(({ tool, member }) => `${tool}:${member}`)
			);
			const dangling = pointers
				.filter(({ text, member }) => !stated.has(`${POINTER.exec(text)?.[1]}:${member}`))
				.map(({ where, text }) => `${where}: ${text}`);
			expect(dangling).toEqual([]);
		});
	}
);

describe("tools/list argument walk", () => {
	// The argument scan checks a fraction of the list if the walk stops at the
	// top level; each keyword it descends through reaches a description.
	it.each(["properties", "items", "anyOf", "additionalProperties"])(
		"walk argument schemas through %s",
		async (keyword) => {
			const { tools } = await listTools({
				host: "app",
				allowWrites: true,
				revealSecretsToAgents: false,
			});
			const reached = tools
				.flatMap(argumentDescriptions)
				.filter(({ via }) => via.has(keyword));
			expect(reached.length).toBeGreaterThan(0);
		}
	);
});

describe("tools/list while reveal is on", () => {
	it.each([false, true])("carries no withholding wording, writes %s", async (allowWrites) => {
		const { tools } = await listTools({
			host: "app",
			allowWrites,
			revealSecretsToAgents: true,
		});
		expect(tools.length).toBeGreaterThan(0);
		const offenders = tools
			.filter((tool) => /Withheld|<redacted>/.test(tool.description ?? ""))
			.map((tool) => tool.name);
		expect(offenders).toEqual([]);
	});
});
