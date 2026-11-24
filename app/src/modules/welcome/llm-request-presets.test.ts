/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two LLM request templates (#3778), held to what a request created from
 * one has to be: a stream the builder reads as a stream, headers it owns the
 * way its own toggle would write them, and elements the engine accepts.
 *
 * The element schemas come from `engine/tests/fixtures/element-kinds.json`,
 * which the engine's own tests write off the live registry. Held in
 * `ENGINE_READING_GUARDS` (`@/lib/routed-inputs.testkit`) so CI routes an edit
 * to it back to this suite.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { ACCEPT_HEADER, SSE_ACCEPT, STREAM_TEXT_PATH_PRESETS } from "@/constants/request";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { isSupportedJsonPath, missingRequiredKeys, validateElementConfig } from "@/lib/elements";
import { streamPatch } from "@/modules/request-builder/utils/auto-header";
import type { ElementKindSchema, KeyValueItem } from "@/types";
import {
	ANTHROPIC_MESSAGES_PRESET,
	LLM_REQUEST_TEMPLATES,
	OPENAI_CHAT_COMPLETION_PRESET,
} from "./llm-request-presets";

const [FIXTURE_PATH] = ENGINE_READING_GUARDS.llmRequestPresets.paths.map(fromRepoRoot);
const KINDS = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ElementKindSchema[];

/** What a template's user defines once: the host, the key and the model. */
const TEMPLATE_VARIABLES = ["baseUrl", "apiKey", "model"];

function bodyJson(preset: { body?: { mode: string; content?: string } }) {
	if (preset.body?.mode !== "json" || preset.body.content === undefined) {
		throw new Error("not a JSON body");
	}
	return JSON.parse(preset.body.content) as Record<string, unknown>;
}

const withIds = (headers: readonly { key: string }[] | undefined): KeyValueItem[] =>
	(headers ?? []).map((row, index) => ({ ...(row as KeyValueItem), id: `row-${index}` }));

describe("the OpenAI-compatible chat completion template", () => {
	const preset = OPENAI_CHAT_COMPLETION_PRESET;

	it("posts to the chat completions path under the host variable, with a bearer key", () => {
		expect(preset).toMatchObject({
			name: "Chat completion (OpenAI-compatible)",
			method: "POST",
			url: "{{baseUrl}}/chat/completions",
			auth: { mode: "bearer", token: "{{apiKey}}" },
		});
	});

	it("streams, and reads the reply's text off the OpenAI-compatible path", () => {
		expect(preset.stream).toBe(true);
		expect(preset.streamTextPath).toBe(STREAM_TEXT_PATH_PRESETS[0].path);
	});

	it("sends a JSON body that asks for a stream with the usage counts", () => {
		expect(preset.bodyType).toBe("json");
		expect(bodyJson(preset)).toEqual({
			model: "{{model}}",
			stream: true,
			stream_options: { include_usage: true },
			messages: [{ role: "user", content: expect.any(String) }],
		});
	});

	it("declares the JSON and event-stream headers", () => {
		expect(preset.headers).toEqual([
			{ key: "Content-Type", value: "application/json", enabled: true, source: "body-mode" },
			{ key: ACCEPT_HEADER, value: SSE_ACCEPT, enabled: true, source: "stream" },
		]);
	});

	it("closes on an assertion that the body carried the [DONE] sentinel", () => {
		expect(preset.elements).toEqual([
			{
				id: expect.any(String),
				kind: "assert.contains",
				enabled: true,
				config: { field: "body", mode: "contains", text: "[DONE]" },
			},
		]);
	});
});

describe("the Anthropic-style messages template", () => {
	const preset = ANTHROPIC_MESSAGES_PRESET;

	it("posts to the messages path under the host variable, with the key in x-api-key", () => {
		expect(preset).toMatchObject({
			name: "Messages (Anthropic-style)",
			method: "POST",
			url: "{{baseUrl}}/v1/messages",
			auth: { mode: "apikey", key: "x-api-key", value: "{{apiKey}}", in: "header" },
		});
	});

	it("streams, and reads the reply's text off the Anthropic path", () => {
		expect(preset.stream).toBe(true);
		expect(preset.streamTextPath).toBe(STREAM_TEXT_PATH_PRESETS[1].path);
	});

	it("sends a JSON body with the token cap the API requires", () => {
		expect(preset.bodyType).toBe("json");
		expect(bodyJson(preset)).toEqual({
			model: "{{model}}",
			max_tokens: expect.any(Number),
			stream: true,
			messages: [{ role: "user", content: expect.any(String) }],
		});
		expect(bodyJson(preset).max_tokens).toBeGreaterThan(0);
	});

	it("declares the version, JSON and event-stream headers", () => {
		expect(preset.headers).toEqual([
			{ key: "anthropic-version", value: "2023-06-01", enabled: true },
			{ key: "Content-Type", value: "application/json", enabled: true, source: "body-mode" },
			{ key: ACCEPT_HEADER, value: SSE_ACCEPT, enabled: true, source: "stream" },
		]);
	});

	it("closes on message_stop, since Anthropic never sends [DONE]", () => {
		expect(preset.elements).toEqual([
			{
				id: expect.any(String),
				kind: "assert.contains",
				enabled: true,
				config: { field: "body", mode: "contains", text: "message_stop" },
			},
		]);
	});
});

describe.each(LLM_REQUEST_TEMPLATES)("the $id template", ({ preset }) => {
	it("is one the builder reads as it would its own Event stream toggle", () => {
		const headers = withIds(preset.headers);

		// Turning the stream on finds its Accept row already there, so nothing
		// is added twice.
		expect(streamPatch({ headers }, true).headers).toBe(headers);

		// Turning it off takes back the Accept row and no other.
		const off = streamPatch({ headers }, false).headers;
		expect(off.map((row) => row.key)).toEqual(
			headers.map((row) => row.key).filter((key) => key !== ACCEPT_HEADER)
		);
	});

	it("names a stream text path the engine's JSONPath subset reads", () => {
		expect(preset.streamTextPath).toBeTruthy();
		expect(isSupportedJsonPath(preset.streamTextPath ?? "")).toBe(true);
	});

	it("keeps body mode and body type in step", () => {
		expect(preset.bodyType).toBe(preset.body?.mode);
	});

	it("needs only the host, key and model variables", () => {
		const text = JSON.stringify([preset.url, preset.auth, preset.body, preset.headers]);
		const used = [...text.matchAll(VARIABLE_PATTERN)].map((match) => match[1]);
		expect(new Set(used)).toEqual(new Set(TEMPLATE_VARIABLES));
	});

	it("carries elements the engine's schema accepts, under distinct ids", () => {
		const elements = preset.elements ?? [];
		expect(elements.length).toBeGreaterThan(0);
		for (const element of elements) {
			expect(missingRequiredKeys(element, KINDS), element.id).toEqual([]);
			expect(validateElementConfig(element, KINDS), element.id).toEqual({});
		}
		expect(new Set(elements.map((e) => e.id)).size).toBe(elements.length);
	});
});

describe("the template roster", () => {
	it("lists both templates once, under distinct ids and names", () => {
		expect(LLM_REQUEST_TEMPLATES.map((t) => t.preset)).toEqual([
			OPENAI_CHAT_COMPLETION_PRESET,
			ANTHROPIC_MESSAGES_PRESET,
		]);
		const ids = LLM_REQUEST_TEMPLATES.map((t) => t.id);
		const names = LLM_REQUEST_TEMPLATES.map((t) => t.preset.name);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(names).size).toBe(names.length);
	});

	it("scanned a fixture that knows the kind the templates assert with", () => {
		expect(KINDS.some((k) => k.kind === "assert.contains")).toBe(true);
	});
});
