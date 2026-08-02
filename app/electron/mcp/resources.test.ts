/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file resources.test.ts
 * @brief Covers the script-sandbox resource added for issue #233. The load-
 *        bearing assertion is the anti-drift one: the resource's contents must
 *        come from what the engine served, so a hand-maintained list of pm.*
 *        names in the app would fail these tests rather than quietly going
 *        stale the way the app's own quick-reference panel did.
 */

import { describe, expect, test, vi } from "vitest";
import { STATIC_RESOURCES, projectScriptingSurface } from "./resources.js";
import type { ToolContext } from "./tools.js";
import type { EngineClient } from "./engine-client.js";

/** One completion in the engine's shape - Monaco fields and all. */
function engineEntry(label: string, extra: Record<string, unknown> = {}) {
	return {
		label,
		kind: 1,
		insertText: `${label}(\${1:arg})`,
		insertTextRules: 4,
		sortText: `1_${label}`,
		filterText: `.${label}`,
		detail: `${label}(arg: string): string`,
		documentation: `What ${label} does.`,
		...extra,
	};
}

function scriptingResource() {
	const r = STATIC_RESOURCES.find((s) => s.uri === "vayu://scripting/completions");
	if (!r) throw new Error("scripting resource is not registered");
	return r;
}

function contextWith(completionsPayload: unknown, getScriptCompletions = vi.fn()) {
	getScriptCompletions.mockResolvedValue(completionsPayload);
	return {
		ctx: { client: { getScriptCompletions } as unknown as EngineClient } as ToolContext,
		getScriptCompletions,
	};
}

describe("projectScriptingSurface", () => {
	test("keeps the fields that mean something outside an editor", () => {
		const surface = projectScriptingSurface({
			version: "1.0.0",
			engine: "quickjs",
			completions: [engineEntry("pm.crypto.sha256")],
		});

		expect(surface.version).toBe("1.0.0");
		expect(surface.engine).toBe("quickjs");
		expect(surface.completions).toEqual([
			{
				label: "pm.crypto.sha256",
				detail: "pm.crypto.sha256(arg: string): string",
				documentation: "What pm.crypto.sha256 does.",
			},
		]);
	});

	test("drops Monaco's own fields - snippet placeholders and the kind enum", () => {
		const surface = projectScriptingSurface({
			completions: [engineEntry("pm.test")],
		});

		const [entry] = surface.completions;
		for (const monacoOnly of [
			"kind",
			"insertText",
			"insertTextRules",
			"sortText",
			"filterText",
		]) {
			expect(entry).not.toHaveProperty(monacoOnly);
		}
	});

	test("keeps snippet entries - their label and documentation still name a capability", () => {
		const surface = projectScriptingSurface({
			completions: [
				engineEntry("Sign the outgoing request", {
					kind: 28,
					detail: "Script template",
					documentation: "HMAC-sign the request from a pre-request script.",
				}),
			],
		});

		expect(surface.completions).toHaveLength(1);
		expect(surface.completions[0].documentation).toContain("HMAC-sign");
	});

	test("omits detail / documentation when the engine sent none, rather than emitting undefined", () => {
		const surface = projectScriptingSurface({ completions: [{ label: "pm" }] });

		expect(surface.completions[0]).toEqual({ label: "pm" });
	});

	test("skips entries with no usable label instead of offering a nameless API", () => {
		const surface = projectScriptingSurface({
			completions: [{ label: "" }, { kind: 1 }, null, "pm.test", engineEntry("pm.expect")],
		});

		expect(surface.completions.map((c) => c.label)).toEqual(["pm.expect"]);
	});

	// A partial surface is worse than an error: an agent reads a short list as
	// "the sandbox cannot do that" and never attempts what is missing.
	test.each([
		["a payload that is not an object", "not json"],
		["a payload with no completions key", { version: "1.0.0" }],
		["a completions value that is not an array", { completions: { label: "pm" } }],
		["null", null],
	])("throws loudly on %s", (_label, payload) => {
		expect(() => projectScriptingSurface(payload)).toThrow(/scripting\/completions/);
	});
});

describe("vayu://scripting/completions resource", () => {
	test("serves whatever the engine's completions endpoint returned", async () => {
		// A name the app has never heard of: only a resource that actually reads
		// the engine can produce it, so a hardcoded list here fails.
		const { ctx, getScriptCompletions } = contextWith({
			version: "1.0.0",
			engine: "quickjs",
			completions: [engineEntry("pm.somethingTheAppHasNeverHeardOf")],
		});

		const surface = (await scriptingResource().read(ctx)) as {
			completions: Array<{ label: string }>;
		};

		expect(getScriptCompletions).toHaveBeenCalledTimes(1);
		expect(surface.completions.map((c) => c.label)).toEqual([
			"pm.somethingTheAppHasNeverHeardOf",
		]);
	});

	test("a name the engine stops serving disappears from the resource", async () => {
		const { ctx } = contextWith({ completions: [engineEntry("pm.test")] });

		const surface = (await scriptingResource().read(ctx)) as {
			completions: Array<{ label: string }>;
		};

		expect(surface.completions.map((c) => c.label)).not.toContain("pm.crypto.sha256");
	});

	test("forwards the cancellation signal to the engine client", async () => {
		const { ctx, getScriptCompletions } = contextWith({ completions: [] });
		const controller = new AbortController();

		await scriptingResource().read(ctx, controller.signal);

		expect(getScriptCompletions).toHaveBeenCalledWith(controller.signal);
	});

	test("propagates an engine failure rather than serving an empty surface", async () => {
		const ctx = {
			client: {
				getScriptCompletions: vi.fn().mockRejectedValue(new Error("engine is down")),
			} as unknown as EngineClient,
		} as ToolContext;

		await expect(scriptingResource().read(ctx)).rejects.toThrow("engine is down");
	});
});
