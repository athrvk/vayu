/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Request templates for the two wire shapes most LLM APIs speak (#3778): an
 * OpenAI-compatible chat completion and an Anthropic-style messages call. Each
 * is a streaming POST with the auth, headers, body, stream text path and a
 * closing assertion already in place, so the first send reads as a reply.
 *
 * The three things that differ per account - the host, the key and the model -
 * are `{{baseUrl}}`, `{{apiKey}}` and `{{model}}`, so a template runs after the
 * user defines those variables and carries no secret or model name of its own.
 * There is no price table or model list here: a catalogue goes stale, and cost
 * is a recipe (`docs/app/testing-an-llm-api.md`).
 *
 * Headers are stored rows marked with the setting that owns them (`stream` for
 * `Accept`, `body-mode` for `Content-Type`), the same markers `auto-header.ts`
 * writes, so turning Event stream off or changing the body mode takes back
 * exactly what the template put there and leaves the user's own rows alone.
 *
 * Element ids are literals: a preset is a module constant, and an id only has
 * to be unique within the one request it is stored on.
 */

import type { RequestPreset } from "@/hooks/useNewRequest";
import { ACCEPT_HEADER, SSE_ACCEPT, STREAM_TEXT_PATH_PRESETS } from "@/constants/request";
import type { ElementDef, KeyValueEntry } from "@/types";

const JSON_CONTENT_TYPE: KeyValueEntry = {
	key: "Content-Type",
	value: "application/json",
	enabled: true,
	source: "body-mode",
};

const EVENT_STREAM_ACCEPT: KeyValueEntry = {
	key: ACCEPT_HEADER,
	value: SSE_ACCEPT,
	enabled: true,
	source: "stream",
};

function jsonBody(payload: unknown): NonNullable<RequestPreset["body"]> {
	return { mode: "json", content: JSON.stringify(payload, null, 2) };
}

function bodyContains(id: string, text: string): ElementDef {
	return {
		id,
		kind: "assert.contains",
		enabled: true,
		config: { field: "body", mode: "contains", text },
	};
}

const HELLO_MESSAGE = [{ role: "user", content: "Say hello in one sentence." }];

/**
 * `stream_options.include_usage` makes the last event carry the token counts
 * that `metric.record`'s `eventJsonpath` source reads.
 */
export const OPENAI_CHAT_COMPLETION_PRESET: RequestPreset = {
	name: "Chat completion (OpenAI-compatible)",
	method: "POST",
	url: "{{baseUrl}}/chat/completions",
	auth: { mode: "bearer", token: "{{apiKey}}" },
	headers: [JSON_CONTENT_TYPE, EVENT_STREAM_ACCEPT],
	body: jsonBody({
		model: "{{model}}",
		stream: true,
		stream_options: { include_usage: true },
		messages: HELLO_MESSAGE,
	}),
	bodyType: "json",
	stream: true,
	streamTextPath: STREAM_TEXT_PATH_PRESETS[0].path,
	elements: [bodyContains("el_llm_stream_done", "[DONE]")],
};

/** Anthropic closes with a `message_stop` event, and sends no `[DONE]`. */
export const ANTHROPIC_MESSAGES_PRESET: RequestPreset = {
	name: "Messages (Anthropic-style)",
	method: "POST",
	url: "{{baseUrl}}/v1/messages",
	auth: { mode: "apikey", key: "x-api-key", value: "{{apiKey}}", in: "header" },
	headers: [
		{ key: "anthropic-version", value: "2023-06-01", enabled: true },
		JSON_CONTENT_TYPE,
		EVENT_STREAM_ACCEPT,
	],
	body: jsonBody({
		model: "{{model}}",
		max_tokens: 1024,
		stream: true,
		messages: HELLO_MESSAGE,
	}),
	bodyType: "json",
	stream: true,
	streamTextPath: STREAM_TEXT_PATH_PRESETS[1].path,
	elements: [bodyContains("el_llm_stream_stop", "message_stop")],
};

/**
 * What the sidebar's template menu and the palette list, from one roster so a
 * template added here appears in both. `id` keys the palette command.
 */
export const LLM_REQUEST_TEMPLATES: readonly { id: string; preset: RequestPreset }[] = [
	{ id: "chat-completion", preset: OPENAI_CHAT_COMPLETION_PRESET },
	{ id: "messages", preset: ANTHROPIC_MESSAGES_PRESET },
];
