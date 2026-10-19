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
 * The body pane for a body that is not text (issue #2458).
 *
 * The image branch used to build `data:${type};base64,${body}` out of a body
 * no engine path ever sent as base64, so it was dead code; and SVG took it
 * because `image/` was matched before `+xml`. The bytes are `rawBytes` now,
 * decoded once by the funnels, and these assert the pane draws from them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
	decodeResponseBody,
	type ResponseBytes,
} from "@/modules/request-builder/utils/response-bytes";

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: (props: Record<string, unknown>) => {
		editorProps.current = props;
		return <div data-testid="code-editor" />;
	},
}));

import ResponseBody from "./ResponseBody";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

let blobs: Map<string, Blob>;
let revoked: string[];

beforeEach(() => {
	editorProps.current = null;
	blobs = new Map();
	revoked = [];
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
		const url = `blob:test-${blobs.size}`;
		blobs.set(url, blob as Blob);
		return url;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
		revoked.push(url);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const bytesOf = (data: Uint8Array<ArrayBuffer>, isText = false): ResponseBytes => ({
	data,
	isText,
});

describe("an image the engine sent as base64", () => {
	it("draws the image from its own bytes", async () => {
		const { container } = render(
			<ResponseBody
				body=""
				rawBytes={bytesOf(PNG)}
				headers={{ "content-type": "image/png" }}
			/>
		);

		const src = container.querySelector("img")?.getAttribute("src") ?? "";
		const blob = blobs.get(src);
		expect(blob, "the <img> src must be an object URL this pane created").toBeDefined();
		expect(blob!.type).toBe("image/png");
		expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PNG);
		expect(screen.getByText("Image (PNG), 10 B")).toBeInTheDocument();
	});

	it("revokes the object URL when the preview goes", () => {
		const { container, unmount } = render(
			<ResponseBody
				body=""
				rawBytes={bytesOf(PNG)}
				headers={{ "content-type": "image/png" }}
			/>
		);
		const src = container.querySelector("img")?.getAttribute("src");

		unmount();
		expect(revoked).toEqual([src]);
	});

	it("keeps the actions slot, so the image can be downloaded", () => {
		render(
			<ResponseBody
				body=""
				rawBytes={bytesOf(PNG)}
				headers={{ "content-type": "image/png" }}
				actions={<button type="button">Download response</button>}
			/>
		);

		expect(screen.getByRole("button", { name: "Download response" })).toBeInTheDocument();
	});
});

describe("SVG", () => {
	it("is shown as XML in the editor, not drawn", () => {
		const { container } = render(
			<ResponseBody
				body="<svg xmlns='http://www.w3.org/2000/svg'/>"
				headers={{ "content-type": "image/svg+xml" }}
			/>
		);

		expect(container.querySelector("img")).toBeNull();
		expect(editorProps.current?.language).toBe("xml");
	});
});

describe("bytes with no text view", () => {
	it("says what they are and how many, with no editor", () => {
		render(
			<ResponseBody
				body=""
				rawBytes={bytesOf(new Uint8Array([0, 1, 2]))}
				headers={{ "content-type": "application/octet-stream" }}
				actions={<span />}
			/>
		);

		expect(screen.getByText("Binary data, 3 B")).toBeInTheDocument();
		expect(screen.getByText(/Download saves it/)).toBeInTheDocument();
		expect(editorProps.current).toBeNull();
	});

	it("takes the funnel's verdict over a type the header would call text", () => {
		render(
			<ResponseBody
				body=""
				rawBytes={bytesOf(new Uint8Array([0, 1]))}
				headers={{ "content-type": "application/x-unheard-of" }}
			/>
		);

		expect(screen.getByText("Binary data, 2 B")).toBeInTheDocument();
		expect(screen.queryByText(/Download/)).toBeNull();
	});

	it("keeps an Office document as bytes to download, though its subtype spells xml", () => {
		const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		const { text, bytes } = decodeResponseBody({
			bodyRaw: btoa(String.fromCharCode(0x50, 0x4b, 0x03, 0x04, 0x00, 0xff)),
			bodyEncoding: "base64",
			headers: { "content-type": contentType },
		});
		render(
			<ResponseBody
				body={text}
				rawBytes={bytes}
				headers={{ "content-type": contentType }}
				actions={<button type="button">Download response</button>}
			/>
		);

		expect(screen.getByText("Binary data, 6 B")).toBeInTheDocument();
		expect(screen.getByText(/Download saves it/)).toBeInTheDocument();
		expect(editorProps.current).toBeNull();
	});

	it("names a PDF and its size", () => {
		render(
			<ResponseBody
				body=""
				rawBytes={bytesOf(new Uint8Array([0x25, 0x50, 0x44, 0x46]))}
				headers={{ "content-type": "application/pdf" }}
			/>
		);

		expect(screen.getByText("PDF document, 4 B")).toBeInTheDocument();
	});
});

describe("text decoded from bytes", () => {
	it("shows the decoding, and says when bytes were replaced", () => {
		render(
			<ResponseBody
				body={"ok�"}
				rawBytes={{
					data: new Uint8Array([0x6f, 0x6b, 0xff]),
					isText: true,
					notice: { charset: "utf-8", unknownLabel: "x-made-up", replaced: true },
				}}
				headers={{ "content-type": "text/plain; charset=x-made-up" }}
			/>
		);

		expect(editorProps.current?.value).toBe("ok�");
		expect(screen.getByText('Unknown charset "x-made-up"')).toBeInTheDocument();
		expect(screen.getByText(/shown as utf-8 instead/)).toBeInTheDocument();
	});
});
