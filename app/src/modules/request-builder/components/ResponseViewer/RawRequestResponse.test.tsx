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
 * The Raw tab used to print `HTTP/1.1` on the response status line no matter
 * what actually negotiated - the last hardcoded protocol claim in the app
 * (Task 14). This renders the component the way `ResponseViewer` does and
 * asserts the negotiated protocol - not a hardcoded guess - is what shows.
 * It also covers the large-body cap and the memoised build (#3138).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LARGE_BODY_BYTES } from "@/components/shared/response-viewer";
import { markLines } from "@/lib/http-language";
import RawRequestResponse from "./RawRequestResponse";

// Monaco does not run under jsdom - render the raw text plainly so the
// assertions below check real content, not an empty editor shell.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="raw-content">{value}</div>,
}));

// Wrapped, not replaced: `markLines` runs once per build, which is how the
// memo test below counts builds.
vi.mock("@/lib/http-language", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/http-language")>();
	return { ...actual, markLines: vi.fn(actual.markLines) };
});

function response(overrides: Partial<Parameters<typeof RawRequestResponse>[0]["response"]> = {}) {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "text/plain" },
		body: "hi",
		...overrides,
	};
}

describe("RawRequestResponse", () => {
	it("shows the negotiated protocol on the status line, not a hardcoded one", () => {
		render(<RawRequestResponse rawRequest="" response={response({ httpVersion: "HTTP/2" })} />);

		expect(screen.getByTestId("raw-content").textContent).toContain("HTTP/2 200 OK");
	});

	it("falls back to HTTP/1.1 when no protocol was negotiated at all", () => {
		render(<RawRequestResponse rawRequest="" response={response({ httpVersion: "" })} />);

		expect(screen.getByTestId("raw-content").textContent).toContain("HTTP/1.1 200 OK");
	});

	it("defaults to HTTP/1.1 when the response carries no httpVersion field", () => {
		render(<RawRequestResponse rawRequest="" response={response()} />);

		expect(screen.getByTestId("raw-content").textContent).toContain("HTTP/1.1 200 OK");
	});

	it("prints the body as received, not the indented pane copy (#2459)", () => {
		const received = '{"z":1,"id":9007199254740993,"z":2}';
		render(
			<RawRequestResponse
				rawRequest=""
				response={response({
					headers: { "content-type": "application/json" },
					body: '{\n  "z": 2,\n  "id": 9007199254740992\n}',
					bodyRaw: received,
				})}
			/>
		);

		const text = screen.getByTestId("raw-content").textContent ?? "";
		expect(text).toContain(`< ${received}`);
		expect(text).not.toContain("9007199254740992");
	});

	it("prints the pane text where no bodyRaw was recorded", () => {
		render(<RawRequestResponse rawRequest="" response={response({ body: "just a body" })} />);

		expect(screen.getByTestId("raw-content").textContent).toContain("< just a body");
	});

	it("prints one line for a body with no text view, never its base64 (#2458)", () => {
		render(
			<RawRequestResponse
				rawRequest=""
				response={response({
					headers: { "content-type": "image/png" },
					body: "",
					rawBytes: { data: new Uint8Array(3), isText: false },
				})}
			/>
		);

		expect(screen.getByTestId("raw-content").textContent).toContain(
			"< [3 B of binary data, not shown as text. Download it from the Body tab.]"
		);
	});

	it("prints a decoded text body as its text", () => {
		render(
			<RawRequestResponse
				rawRequest=""
				response={response({
					body: "café",
					rawBytes: { data: new Uint8Array([0x63, 0x61, 0x66, 0xe9]), isText: true },
				})}
			/>
		);

		expect(screen.getByTestId("raw-content").textContent).toContain("< café");
	});

	it("prints the header lines as received, a repeated one on each of its lines (#2460)", () => {
		render(
			<RawRequestResponse
				rawRequest=""
				response={response({
					headers: { "set-cookie": "a=1, b=2" },
					headerLines: [
						{ name: "Set-Cookie", value: "a=1" },
						{ name: "Set-Cookie", value: "b=2" },
					],
				})}
			/>
		);

		const text = screen.getByTestId("raw-content").textContent ?? "";
		expect(text).toContain("< Set-Cookie: a=1");
		expect(text).toContain("< Set-Cookie: b=2");
		expect(text).not.toContain("set-cookie: a=1, b=2");
	});

	it("prints the folded map for a response with no lines (#2460)", () => {
		render(
			<RawRequestResponse
				rawRequest=""
				response={response({ headers: { "set-cookie": "a=1, b=2" } })}
			/>
		);

		expect(screen.getByTestId("raw-content").textContent).toContain("< set-cookie: a=1, b=2");
	});

	describe("a large body (#3138)", () => {
		const tail = "TAIL";
		const big = "a".repeat(LARGE_BODY_BYTES) + tail;

		it("prints only the first LARGE_BODY_BYTES of it and says so", () => {
			render(<RawRequestResponse rawRequest="" response={response({ body: big })} />);

			const text = screen.getByTestId("raw-content").textContent ?? "";
			expect(text).toContain("< " + "a".repeat(LARGE_BODY_BYTES));
			expect(text).not.toContain(tail);
			// The status line and header are small; the body is the cap, no more.
			expect(text.length).toBeLessThan(LARGE_BODY_BYTES + 1024);
			expect(screen.getByText("Large response")).toBeInTheDocument();
			expect(screen.getByText(/Only the first 2\.0 MB is shown here/)).toBeInTheDocument();
			expect(screen.queryByText(/Formatting is off/)).toBeNull();
		});

		it("caps bodyRaw, the string Raw prints, whatever the pane copy holds", () => {
			render(
				<RawRequestResponse
					rawRequest=""
					response={response({ body: "short", bodyRaw: big })}
				/>
			);

			expect(screen.getByTestId("raw-content").textContent).not.toContain(tail);
			expect(screen.getByText("Large response")).toBeInTheDocument();
		});

		it("shows no notice and the whole body at exactly the limit", () => {
			const atLimit = "a".repeat(LARGE_BODY_BYTES);
			render(<RawRequestResponse rawRequest="" response={response({ body: atLimit })} />);

			expect(screen.getByTestId("raw-content").textContent).toContain("< " + atLimit);
			expect(screen.queryByText("Large response")).toBeNull();
		});

		it("does not cut or announce a binary body, which prints as one line", () => {
			render(
				<RawRequestResponse
					rawRequest=""
					response={response({
						body: big,
						rawBytes: { data: new Uint8Array(3), isText: false },
					})}
				/>
			);

			expect(screen.queryByText("Large response")).toBeNull();
			expect(screen.getByTestId("raw-content").textContent).toContain("binary data");
		});
	});

	describe("rebuilding", () => {
		const builds = () => vi.mocked(markLines).mock.calls.length;

		it("does not rebuild for a re-render with the same inputs", () => {
			const headers = { "content-type": "text/plain" };
			const first = response({ headers, body: "a".repeat(64) });
			const { rerender } = render(<RawRequestResponse rawRequest="" response={first} />);
			const before = builds();

			// A new response object, the same fields: what the parent hands over.
			rerender(<RawRequestResponse rawRequest="" response={{ ...first }} />);

			expect(builds()).toBe(before);
		});

		it("rebuilds when the body changes", () => {
			const headers = { "content-type": "text/plain" };
			const { rerender } = render(
				<RawRequestResponse rawRequest="" response={response({ headers, body: "one" })} />
			);
			const before = builds();

			rerender(
				<RawRequestResponse rawRequest="" response={response({ headers, body: "two" })} />
			);

			expect(builds()).toBeGreaterThan(before);
			expect(screen.getByTestId("raw-content").textContent).toContain("< two");
		});
	});
});
