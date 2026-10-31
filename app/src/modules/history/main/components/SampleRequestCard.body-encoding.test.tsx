/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A captured sample's `bodyEncoding` (#3159). `GET /runs/:id/samples` sends a
 * body with a zero byte or non-UTF-8 bytes as base64; the card decodes it
 * rather than handing the viewer the base64 string.
 *
 * Mutation-check: pass `captured.response.body` straight to the viewer in
 * `SampleRequestCard.tsx` (skip `capturedBody`) and the text and binary cases
 * fail; hold `bodyEncoding` back from `decodeResponseBody` in `sample-body.ts`
 * and the same two fail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import SampleRequestCard from "./SampleRequestCard";
import type { SampleResult } from "../../types";
import type { RunSample } from "@/types/domain";

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: (props: Record<string, unknown>) => {
		editorProps.current = props;
		return <div data-testid="code-editor" />;
	},
}));

const SAMPLE: SampleResult = { timestamp: 1_700_000_000_000, statusCode: 200, latencyMs: 5 };

const base64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

function renderCaptured(response: Partial<RunSample["response"]>) {
	return render(
		<SampleRequestCard
			sample={SAMPLE}
			index={0}
			isExpanded
			onToggle={() => {}}
			captured={{ resultId: 1, response: { headers: {}, bodyBytes: 0, ...response } }}
		/>
	);
}

beforeEach(() => {
	editorProps.current = null;
});

describe("SampleRequestCard body encoding (#3159)", () => {
	it("shows a base64 text body as the text it decodes to, zero byte and all", () => {
		// "ok", a zero byte, "end": text the engine could only send as base64.
		renderCaptured({
			headers: { "content-type": "text/plain" },
			body: base64([0x6f, 0x6b, 0x00, 0x65, 0x6e, 0x64]),
			bodyEncoding: "base64",
		});

		expect(editorProps.current?.value).toBe("ok\u0000end");
	});

	it("reads a base64 text body through the charset its Content-Type declares", () => {
		renderCaptured({
			headers: { "content-type": "text/plain; charset=iso-8859-1" },
			body: base64([0x63, 0x61, 0x66, 0xe9]),
			bodyEncoding: "base64",
		});

		expect(editorProps.current?.value).toBe("café");
	});

	it("shows a base64 body of a non-text type as binary, never as base64", () => {
		renderCaptured({
			headers: { "content-type": "application/octet-stream" },
			body: base64([0xff, 0xfe, 0x00, 0x01]),
			bodyEncoding: "base64",
		});

		expect(editorProps.current).toBeNull();
		expect(screen.getByText("Binary data, 4 B")).toBeInTheDocument();
	});

	it.each([
		["a utf8 body", { bodyEncoding: "utf8" as const }],
		["a body from an engine that names no encoding", {}],
	])("leaves %s as its own text", (_name, encoding) => {
		// Valid base64 on purpose: text must not be decoded.
		renderCaptured({
			headers: { "content-type": "text/plain" },
			body: "aGVsbG8=",
			...encoding,
		});

		expect(editorProps.current?.value).toBe("aGVsbG8=");
	});

	it("says so when a body marked base64 does not decode, and keeps the headers", () => {
		renderCaptured({
			headers: { "content-type": "text/plain" },
			body: "not base64!",
			bodyEncoding: "base64",
		});

		expect(screen.getByText("Couldn't read the body")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: /Headers/ })).toBeInTheDocument();
	});
});
