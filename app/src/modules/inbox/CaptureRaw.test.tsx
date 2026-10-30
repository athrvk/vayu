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
 * A capture whose body the engine spelled as base64 (#3109) is shown as bytes.
 *
 * Printing the base64 would put a wall of letters in the Raw view that reads as
 * a payload and is not one. The view names the size instead, Download writes
 * the exact stored bytes, and Copy takes the base64 spelling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useToastStore } from "@/stores";
import type { InboxCapture } from "@/types";
import { CaptureRaw } from "./CaptureRaw";
import { binaryBodyPlaceholder, captureBinaryBytes } from "./utils";

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = btoa(String.fromCharCode(...PNG_HEAD));
const URL_ = "http://127.0.0.1:4100/hooks/upload";

function capture(overrides: Partial<InboxCapture> = {}): InboxCapture {
	return {
		id: 12,
		inboxId: "inbox_a",
		receivedAt: 1700000000000,
		method: "POST",
		path: "/hooks/upload",
		query: "",
		headers: { "Content-Type": "image/png" },
		body: PNG_BASE64,
		bodyEncoding: "base64",
		bodyBytes: PNG_HEAD.length,
		bodyTruncated: false,
		remoteAddr: "127.0.0.1",
		...overrides,
	};
}

const writeText = vi.fn<(value: string) => Promise<void>>();
let blobs: Blob[];
let downloads: string[];

beforeEach(() => {
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
	blobs = [];
	downloads = [];
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
		blobs.push(blob as Blob);
		return `blob:test-${blobs.length}`;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement
	) {
		downloads.push(this.download);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const raw = () => document.querySelector("pre")!.textContent ?? "";

describe("a base64 capture body", () => {
	it("is not printed as text; the Raw view names its size", () => {
		render(<CaptureRaw capture={capture()} url={URL_} />);

		expect(raw()).toContain("POST /hooks/upload HTTP/1.1");
		expect(raw()).toContain("[8 B of binary data, not shown as text.]");
		expect(raw()).not.toContain(PNG_BASE64);
		// The placeholder is not a body: a Content-Length for its own text would
		// state a size the sender never sent.
		expect(raw()).not.toContain("Content-Length");
	});

	it("reports the received size and the kept prefix when truncated", () => {
		render(
			<CaptureRaw
				capture={capture({ bodyBytes: 3 * 1024 * 1024, bodyTruncated: true })}
				url={URL_}
			/>
		);

		expect(raw()).toContain(
			"[Binary data, not shown as text: the first 8 B of 3.0 MB was kept.]"
		);
	});

	it("downloads the exact stored bytes, typed and named by the Content-Type", async () => {
		render(<CaptureRaw capture={capture()} url={URL_} />);

		fireEvent.click(screen.getByRole("button", { name: "Download body" }));

		expect(blobs).toHaveLength(1);
		expect(blobs[0].type).toBe("image/png");
		expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(PNG_HEAD);
		expect(downloads).toEqual(["capture-12.png"]);
	});

	it("falls back to an octet-stream .bin download when no type was sent", () => {
		render(<CaptureRaw capture={capture({ headers: {} })} url={URL_} />);

		fireEvent.click(screen.getByRole("button", { name: "Download body" }));

		expect(blobs[0].type).toBe("application/octet-stream");
		expect(downloads).toEqual(["capture-12.bin"]);
	});

	it("copies the base64 spelling", async () => {
		render(<CaptureRaw capture={capture()} url={URL_} />);

		fireEvent.click(screen.getByRole("button", { name: "Copy as base64" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(PNG_BASE64));
	});

	it("shows the size and offers no download when the base64 does not decode", () => {
		// '!' is outside the base64 alphabet: atob throws, and a render must not.
		render(<CaptureRaw capture={capture({ body: "not*base64!" })} url={URL_} />);

		expect(raw()).toContain("[8 B of binary data, not shown as text.]");
		expect(screen.queryByRole("button", { name: "Download body" })).toBeNull();
		expect(screen.getByRole("button", { name: "Copy as base64" })).toBeInTheDocument();
	});
});

describe("a utf8 capture body", () => {
	it("prints the text, with no binary actions", () => {
		render(
			<CaptureRaw
				capture={capture({
					body: '{"id":7}',
					bodyEncoding: "utf8",
					bodyBytes: 8,
					headers: { "Content-Type": "application/json" },
				})}
				url={URL_}
			/>
		);

		expect(raw()).toContain('{"id":7}');
		expect(raw()).toContain("Content-Length: 8");
		expect(screen.queryByRole("button", { name: "Download body" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Copy as base64" })).toBeNull();
	});
});

describe("captureBinaryBytes", () => {
	it("decodes a base64 body and leaves a utf8 one alone", () => {
		expect(captureBinaryBytes(capture())).toEqual(PNG_HEAD);
		expect(captureBinaryBytes(capture({ bodyEncoding: "utf8" }))).toBeNull();
	});

	it("answers null instead of throwing for base64 that does not decode", () => {
		expect(captureBinaryBytes(capture({ body: "***" }))).toBeNull();
	});

	it("ignores a text Content-Type: bytes the engine called binary stay bytes", () => {
		const latin1 = btoa(String.fromCharCode(0x63, 0x61, 0x66, 0xe9));
		const bytes = captureBinaryBytes(
			capture({ body: latin1, headers: { "Content-Type": "text/plain; charset=iso-8859-1" } })
		);
		expect(Array.from(bytes ?? [])).toEqual([0x63, 0x61, 0x66, 0xe9]);
	});
});

describe("binaryBodyPlaceholder", () => {
	it("says the received size, and the prefix only when truncated", () => {
		expect(binaryBodyPlaceholder({ bodyBytes: 2048, bodyTruncated: false }, 2048)).toBe(
			"[2.0 KB of binary data, not shown as text.]"
		);
		expect(binaryBodyPlaceholder({ bodyBytes: 4096, bodyTruncated: true }, 2048)).toBe(
			"[Binary data, not shown as text: the first 2.0 KB of 4.0 KB was kept.]"
		);
		// A truncated body that did not decode has no held size to name.
		expect(binaryBodyPlaceholder({ bodyBytes: 4096, bodyTruncated: true }, undefined)).toBe(
			"[4.0 KB of binary data, not shown as text.]"
		);
	});
});
