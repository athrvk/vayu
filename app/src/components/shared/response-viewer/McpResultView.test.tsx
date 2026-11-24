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
 * The MCP tool result above the raw reply (#3841): each block kind drawn as
 * what it is, the `isError` banner, `structuredContent` as a JSON body, and the
 * cases where the view steps aside for the raw body alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: (props: Record<string, unknown>) => {
		editorProps.current = props;
		return <div data-testid="code-editor" />;
	},
}));

import McpResultView from "./McpResultView";

// A one-pixel PNG: the bytes only have to decode, jsdom draws nothing.
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const reply = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

let createdBlobs: Blob[];

beforeEach(() => {
	editorProps.current = null;
	createdBlobs = [];
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
		createdBlobs.push(blob as Blob);
		return `blob:test-${createdBlobs.length}`;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete (window as { electronAPI?: unknown }).electronAPI;
});

describe("McpResultView content blocks", () => {
	it("shows a text block as text, markup left inert", () => {
		const { container } = render(
			<McpResultView
				body={reply({ content: [{ type: "text", text: "Sunny <b>and</b> warm" }] })}
			/>
		);

		expect(screen.getByText("Sunny <b>and</b> warm")).toBeInTheDocument();
		expect(container.querySelector("b")).toBeNull();
	});

	it("draws an image block from its bytes", async () => {
		render(
			<McpResultView
				body={reply({
					content: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }],
				})}
			/>
		);

		const img = await screen.findByAltText("Image from the tool result");
		await waitFor(() => expect(img).toHaveAttribute("src", "blob:test-1"));
		expect(createdBlobs[0].type).toBe("image/png");
		expect(createdBlobs[0].size).toBeGreaterThan(0);
	});

	it.each([
		["a type that is not an image", "text/html", PNG_BASE64],
		["data that is not base64", "image/png", "not base64 !!"],
	])("names an image it will not draw: %s", (_name, mimeType, data) => {
		render(<McpResultView body={reply({ content: [{ type: "image", mimeType, data }] })} />);

		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.getByText(/This image can't be shown/)).toBeInTheDocument();
		expect(createdBlobs).toHaveLength(0);
	});

	it("names an audio block and its size without a player", () => {
		const { container } = render(
			<McpResultView
				body={reply({ content: [{ type: "audio", mimeType: "audio/wav", data: "QUJD" }] })}
			/>
		);

		expect(screen.getByText(/Audio \(audio\/wav\), 3 B/)).toBeInTheDocument();
		expect(container.querySelector("audio")).toBeNull();
	});

	it("makes an http(s) resource link a button that opens it outside the window", () => {
		const openExternalUrl = vi.fn().mockResolvedValue(undefined);
		(window as { electronAPI?: unknown }).electronAPI = { openExternalUrl };
		const { container } = render(
			<McpResultView
				body={reply({
					content: [
						{
							type: "resource_link",
							uri: "https://example.test/doc",
							name: "doc",
							mimeType: "text/html",
						},
					],
				})}
			/>
		);

		fireEvent.click(screen.getByRole("button", { name: "https://example.test/doc" }));

		expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/doc");
		expect(container.querySelector("a")).toBeNull();
		expect(screen.getByText("doc")).toBeInTheDocument();
	});

	it.each(["javascript:alert(1)", "file:///etc/passwd", "not a url"])(
		"shows %j as text, with nothing to click",
		(uri) => {
			const { container } = render(
				<McpResultView
					body={reply({ content: [{ type: "resource_link", uri, name: "x" }] })}
				/>
			);

			expect(screen.getByText(uri)).toBeInTheDocument();
			expect(screen.queryByRole("button")).toBeNull();
			expect(container.querySelector("a")).toBeNull();
		}
	);

	it("shows an embedded text resource under its URI", () => {
		render(
			<McpResultView
				body={reply({
					content: [
						{
							type: "resource",
							resource: {
								uri: "file:///a.txt",
								mimeType: "text/plain",
								text: "file body",
							},
						},
					],
				})}
			/>
		);

		expect(screen.getByText("file:///a.txt")).toBeInTheDocument();
		expect(screen.getByText("file body")).toBeInTheDocument();
	});

	it("names an embedded binary resource by size", () => {
		render(
			<McpResultView
				body={reply({
					content: [
						{ type: "resource", resource: { uri: "file:///a.bin", blob: "QUJD" } },
					],
				})}
			/>
		);

		expect(screen.getByText(/Binary content, 3 B/)).toBeInTheDocument();
	});

	it("says a block it cannot draw is in the raw reply", () => {
		render(<McpResultView body={reply({ content: [{ type: "video", url: "x" }] })} />);

		expect(screen.getByText(/Content of type "video"/)).toBeInTheDocument();
	});
});

describe("McpResultView isError", () => {
	it("shows a blocking banner above the content when the tool reported an error", () => {
		render(
			<McpResultView
				body={reply({ isError: true, content: [{ type: "text", text: "City not found" }] })}
			/>
		);

		const banner = screen.getByText("Tool reported an error");
		expect(banner.closest("div")?.parentElement?.className).toMatch(/border-destructive/);
		expect(screen.getByText("City not found")).toBeInTheDocument();
		expect(
			banner.compareDocumentPosition(screen.getByText("City not found")) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it("shows no banner for a result that did not set isError", () => {
		render(<McpResultView body={reply({ content: [{ type: "text", text: "fine" }] })} />);

		expect(screen.queryByText("Tool reported an error")).toBeNull();
	});

	it("shows a JSON-RPC error with its code in the same banner tier", () => {
		render(
			<McpResultView
				body={JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					error: { code: -32602, message: "Unknown tool" },
				})}
			/>
		);

		expect(screen.getByText("Server returned an error")).toBeInTheDocument();
		expect(screen.getByText(/Unknown tool \(code -32602\)/)).toBeInTheDocument();
	});
});

describe("McpResultView structuredContent", () => {
	it("shows it as a JSON body beside the content", () => {
		render(
			<McpResultView
				body={reply({
					content: [{ type: "text", text: "72F" }],
					structuredContent: { temperature: 72 },
				})}
			/>
		);

		expect(screen.getByText("Structured content")).toBeInTheDocument();
		expect(editorProps.current?.language).toBe("json");
		expect(JSON.parse(String(editorProps.current?.value))).toEqual({ temperature: 72 });
	});

	it("shows no structured section for a result without it", () => {
		render(<McpResultView body={reply({ content: [{ type: "text", text: "72F" }] })} />);

		expect(screen.queryByText("Structured content")).toBeNull();
		expect(screen.getByText("72F")).toBeInTheDocument();
		expect(editorProps.current).toBeNull();
	});
});

describe("McpResultView event stream", () => {
	it("reads the final response from a text/event-stream body", () => {
		const progress = { jsonrpc: "2.0", method: "notifications/progress", params: {} };
		const final = {
			jsonrpc: "2.0",
			id: 1,
			result: { content: [{ type: "text", text: "from sse" }] },
		};
		const body = `event: message\ndata: ${JSON.stringify(progress)}\n\nevent: message\ndata: ${JSON.stringify(final)}\n\n`;

		render(<McpResultView body={body} />);

		expect(screen.getByText("from sse")).toBeInTheDocument();
	});
});

describe("McpResultView steps aside", () => {
	const readable = reply({ content: [{ type: "text", text: "visible" }] });

	it("draws the result for a readable reply", () => {
		render(<McpResultView body={readable} />);

		expect(screen.getByLabelText("MCP result")).toBeInTheDocument();
	});

	it("draws nothing for a reply the engine capped or storage cut", () => {
		render(<McpResultView body={readable} incomplete />);

		expect(screen.queryByLabelText("MCP result")).toBeNull();
	});

	it("draws nothing for a body that has no text view", () => {
		render(
			<McpResultView
				body={readable}
				rawBytes={{ data: new Uint8Array([1, 2, 3]), isText: false }}
			/>
		);

		expect(screen.queryByLabelText("MCP result")).toBeNull();
	});

	it("draws a text base64 body", () => {
		render(
			<McpResultView body={readable} rawBytes={{ data: new Uint8Array([1]), isText: true }} />
		);

		expect(screen.getByLabelText("MCP result")).toBeInTheDocument();
	});

	it.each([
		["malformed", '{"result":'],
		["not a tool result", reply({ tools: [] })],
		["empty", ""],
	])("draws nothing for a body that is %s", (_name, body) => {
		render(<McpResultView body={body} />);

		expect(screen.queryByLabelText("MCP result")).toBeNull();
	});

	it("reads bodyRaw, the reply as received, when it differs from body", () => {
		render(<McpResultView body="indented copy" bodyRaw={readable} />);

		expect(screen.getByText("visible")).toBeInTheDocument();
	});
});
