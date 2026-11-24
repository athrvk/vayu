/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool } from "../tools.js";
import {
	fakeClient,
	ctxWith,
	firstText,
	ELEMENT_KINDS,
	SCRIPT_COMPLETIONS,
} from "../tools.testkit.js";

describe("list_element_kinds", () => {
	const client = () => fakeClient({ getElementKinds: vi.fn().mockResolvedValue(ELEMENT_KINDS) });

	test("lists a summary row per kind, without the config schemas", async () => {
		const res = await dispatchTool("list_element_kinds", {}, ctxWith(client()));

		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toEqual({
			kinds: [
				{
					kind: "assert.status",
					category: "assert",
					phases: ["step.after"],
					label: "Status code",
				},
				{
					kind: "timer.think",
					category: "timer",
					phases: ["step.after"],
					label: "Think time",
				},
			],
		});
	});

	test("with a kind, answers that kind's entry and its configSchema", async () => {
		const res = await dispatchTool(
			"list_element_kinds",
			{ kind: "timer.think" },
			ctxWith(client())
		);

		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toEqual(ELEMENT_KINDS[1]);
		expect(res.structuredContent?.configSchema).toEqual(ELEMENT_KINDS[1].configSchema);
	});

	test("an unknown kind is an input error that names the registered kinds", async () => {
		const res = await dispatchTool(
			"list_element_kinds",
			{ kind: "extract.jsonpath" },
			ctxWith(client())
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('"extract.jsonpath"');
		expect(firstText(res)).toContain("assert.status, timer.think");
		const { error } = res.structuredContent as { error: { class: string } };
		expect(error.class).toBe("input");
	});

	test("an engine that answers no catalogue is an error, not an empty list", async () => {
		const res = await dispatchTool(
			"list_element_kinds",
			{},
			ctxWith(fakeClient({ getElementKinds: vi.fn().mockResolvedValue([]) }))
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/no kind entries/);
	});
});

describe("get_script_api", () => {
	const client = () =>
		fakeClient({ getScriptCompletions: vi.fn().mockResolvedValue(SCRIPT_COMPLETIONS) });

	test("without q, lists every name with its signature and no documentation", async () => {
		const res = await dispatchTool("get_script_api", {}, ctxWith(client()));

		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toEqual({
			version: 2,
			engine: "0.0.0-test",
			completions: [
				{ label: "pm.test", detail: "pm.test(name: string, fn: () => void): typeof pm" },
				{ label: "pm.crypto.sha256", detail: "pm.crypto.sha256(data: string): string" },
				{ label: "btoa" },
			],
		});
	});

	test("with q, answers the entries that mention it, documentation included", async () => {
		const res = await dispatchTool("get_script_api", { q: "SHA-256" }, ctxWith(client()));

		expect(res.isError).toBeFalsy();
		expect(res.structuredContent?.completions).toEqual([
			{
				label: "pm.crypto.sha256",
				detail: "pm.crypto.sha256(data: string): string",
				documentation: "Synchronous SHA-256, hex encoded.",
			},
		]);
	});

	test("q matches a label, a signature and documentation alike", async () => {
		const labels = async (q: string) => {
			const res = await dispatchTool("get_script_api", { q }, ctxWith(client()));
			return (res.structuredContent?.completions as Array<{ label: string }>).map(
				(entry) => entry.label
			);
		};

		expect(await labels("btoa")).toEqual(["btoa"]);
		expect(await labels("typeof pm")).toEqual(["pm.test"]);
		expect(await labels("signing")).toEqual(["btoa"]);
		expect(await labels("no such name")).toEqual([]);
	});

	test("a blank q is an input error, never the whole documented surface", async () => {
		const reads = client();
		const res = await dispatchTool("get_script_api", { q: "  " }, ctxWith(reads));

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/"q" must not be blank/);
		expect(reads.getScriptCompletions).not.toHaveBeenCalled();
	});
});
