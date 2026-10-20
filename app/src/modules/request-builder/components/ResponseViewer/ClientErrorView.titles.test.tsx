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
 * Codes the engine sends with `status: 0` that are not a network failure.
 *
 * Each of these used to fall through to "Couldn't get a response", which
 * blames the network for a token Vayu couldn't fetch, a method/body pair it
 * refused, or a data row it couldn't bind (docs/ux-writing.md, "Errors have
 * three sources").
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ClientErrorView from "./ClientErrorView";

describe("ClientErrorView headings for non-network codes", () => {
	it.each([
		["AUTH_FAILED", "Couldn't get an OAuth 2.0 token", /Auth tab's token settings/],
		["AUTH_REQUIRED", "This request needs an OAuth 2.0 token", /Open the Auth tab/],
		["INVALID_METHOD", "Couldn't send - the method doesn't allow this", /Remove the body/],
		["DATA_BINDING_FAILED", "Couldn't bind the data row", /column names in the data file/],
	])("names %s rather than a missing response", (code, title, hint) => {
		render(<ClientErrorView errorCode={code} errorMessage="detail" />);

		expect(screen.getByText(title)).toBeInTheDocument();
		expect(screen.getByText(hint)).toBeInTheDocument();
		expect(screen.queryByText("Couldn't get a response")).not.toBeInTheDocument();
	});
});

// An engine that answered with an HTTP error of its own is not a target that
// never answered (#2458): a bodiless 500 reads as `UNKNOWN_ERROR` with the
// status line as its message, and an explained one as `internal_error`.
// Mutation check: drop either from ErrorTitles and it falls back to
// "Couldn't get a response".
describe("ClientErrorView heading for an engine that answered with an error", () => {
	it.each([
		["UNKNOWN_ERROR", "HTTP 500: Internal Server Error"],
		["internal_error", "Execution failed: something threw"],
	])("names the engine for %s, and shows what it said", (code, message) => {
		render(<ClientErrorView errorCode={code} errorMessage={message} />);

		expect(screen.getByText("Vayu's engine answered with an error")).toBeInTheDocument();
		expect(screen.getByText(message)).toBeInTheDocument();
		expect(screen.getByText(/Vayu's failure, not the server's/)).toBeInTheDocument();
		expect(screen.queryByText("Couldn't get a response")).not.toBeInTheDocument();
	});
});

// The engine answers INVALID_URL both for a URL it cannot parse and for one it
// parsed and refused by scheme, so the heading has to be true of both. The
// engine also answers it for its own port, a host with no ASCII name and a
// redirect to another scheme, so the tip says Vayu couldn't use the URL rather
// than asserting that its scheme is the fault.
// Mutation check: restore "Couldn't parse the URL" and the refused-scheme case
// reads as a parse failure; restore the old tip, "The URL has to start with
// http:// or https://.", and the hint assertion fails.
const INVALID_URL_HINT =
	"Vayu couldn't use that URL. It has to start with http:// or https://, and a space or other raw character has to be percent-encoded.";

describe("ClientErrorView heading for INVALID_URL", () => {
	it.each([
		["a URL that does not parse", "URL using bad/illegal format or missing URL"],
		[
			"a URL the engine will not send to",
			"Cannot send this request: Vayu does not send requests to its own engine port 9876 on this machine",
		],
		[
			"a scheme the engine refuses",
			"Cannot send this request: scheme 'file' is not supported - only http and https URLs can be sent",
		],
	])("names the send, not a cause, for %s", (_case, message) => {
		render(<ClientErrorView errorCode="INVALID_URL" errorMessage={message} />);

		expect(screen.getByText("Couldn't send to this URL")).toBeInTheDocument();
		expect(screen.getByText(message)).toBeInTheDocument();
		expect(screen.getByText(INVALID_URL_HINT)).toBeInTheDocument();
		expect(screen.queryByText("Couldn't parse the URL")).not.toBeInTheDocument();
		expect(screen.queryByText("Couldn't get a response")).not.toBeInTheDocument();
	});
});

// The engine answers a redirect loop and an undecodable body under their own
// codes (#2462); both used to arrive as CONNECTION_FAILED and read as an
// unreachable server.
// Mutation-check: delete the TOO_MANY_REDIRECTS (or BAD_CONTENT_ENCODING) entry
// from ErrorTitles or ErrorHints and the row falls back to "Couldn't get a
// response" or loses its tip.
describe("ClientErrorView for the redirect and encoding codes", () => {
	it.each([
		[
			"TOO_MANY_REDIRECTS",
			"Too many redirects",
			/Raise Maximum redirects in this request's Settings tab, or turn off Follow redirects/,
		],
		[
			"BAD_CONTENT_ENCODING",
			"Couldn't decode the response",
			/Set Accept-Encoding to identity in the Headers tab/,
		],
	])("names %s rather than an unreachable server", (code, title, hint) => {
		render(<ClientErrorView errorCode={code} errorMessage="detail" />);

		expect(screen.getByText(title)).toBeInTheDocument();
		expect(screen.getByText(hint)).toBeInTheDocument();
		expect(screen.queryByText("Couldn't connect to the server")).not.toBeInTheDocument();
		expect(screen.queryByText("Couldn't get a response")).not.toBeInTheDocument();
	});

	// Mutation-check: map TOO_MANY_REDIRECTS back to "Couldn't connect to the
	// server" and the first assertion fails; drop the CONNECTION_FAILED entry and
	// the second does.
	it("still reads CONNECTION_FAILED as a server that could not be reached", () => {
		render(<ClientErrorView errorCode="CONNECTION_FAILED" errorMessage="Connection refused" />);

		expect(screen.getByText("Couldn't connect to the server")).toBeInTheDocument();
		expect(screen.getByText(/Nothing answered at that address/)).toBeInTheDocument();
		expect(screen.queryByText("Too many redirects")).not.toBeInTheDocument();
		expect(screen.queryByText("Couldn't decode the response")).not.toBeInTheDocument();
	});
});

describe("ClientErrorView glyphs", () => {
	const glyph = (code: string) => {
		const { container, unmount } = render(
			<ClientErrorView errorCode={code} errorMessage="x" />
		);
		const cls = container.querySelector("svg.lucide")?.getAttribute("class") ?? "";
		unmount();
		return (
			cls.split(/\s+/).find((c) => /^lucide-(?!lightbulb)/.test(c) && c !== "lucide") ?? ""
		);
	};

	it("gives Vayu's own failures a glyph no network failure uses", () => {
		const network = [
			"TIMEOUT",
			"SSL_ERROR",
			"PROXY_ERROR",
			"INVALID_URL",
			"CONNECTION_FAILED",
			"DNS_ERROR",
			"TOO_MANY_REDIRECTS",
			"BAD_CONTENT_ENCODING",
		].map(glyph);
		const own = ["ENGINE_ERROR", "INTERNAL_ERROR", "UNKNOWN_ERROR", "internal_error"].map(
			glyph
		);

		expect(glyph("CONNECTION_FAILED")).toBe("lucide-server-off");
		expect(own).toEqual(Array(4).fill("lucide-server-crash"));
		for (const g of own) expect(network).not.toContain(g);
	});

	// Mutation-check: delete either getErrorIcon case and that code falls to the
	// generic alert glyph, which the fallback comparison below catches. The glyph
	// names are not pinned: lucide renames icons across versions (FileWarning
	// renders as lucide-file-exclamation-point in 1.35).
	it("gives a redirect loop and an undecodable body glyphs of their own", () => {
		const fallback = glyph("SOMETHING_UNMAPPED");
		const redirects = glyph("TOO_MANY_REDIRECTS");
		const encoding = glyph("BAD_CONTENT_ENCODING");

		expect(redirects).not.toBe(encoding);
		expect([redirects, encoding]).not.toContain(fallback);
		expect([redirects, encoding]).not.toContain("lucide-server-off");
	});
});
