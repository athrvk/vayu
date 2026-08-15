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
 * The Spec tab's Sync section (issue #654).
 *
 * What this has to prove is mostly what it does *not* do: checking a document
 * writes nothing, so the write half (#655) inherits a diff that was safe to
 * compute. Beyond that - the up-to-date short-circuit is byte equality against
 * the stored document, every count is stated including the zeros, and a binding
 * with no origin says what to do about it instead of failing quietly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Request, SpecDocument } from "@/types";

const importFetch = vi.fn();
const updateRequest = vi.fn();
const updateCollection = vi.fn();
const createRequest = vi.fn();
const deleteRequest = vi.fn();
const createSpec = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		importFetch: (url: string) => importFetch(url),
		updateRequest,
		updateCollection,
		createRequest,
		deleteRequest,
		createSpec,
	},
}));

vi.mock("@/hooks/useSpecDocumentLimit", () => ({
	useSpecDocumentLimit: () => ({ maxBytes: 10 * 1024 * 1024 }),
}));

const { default: SpecSync } = await import("./SpecSync");

const doc = (summary: string, extra: Record<string, unknown> = {}): string =>
	JSON.stringify({
		openapi: "3.0.0",
		info: { title: "Pets API" },
		servers: [{ url: "https://api.example.com" }],
		paths: { "/pets": { get: { operationId: "listPets", summary, ...extra } } },
	});

const BOUND = doc("List pets");

const spec = (
	content: string,
	sourceUrl: string | null = "https://api.example.com/spec.json"
): SpecDocument => ({
	id: "spec_1",
	content,
	sourceUrl,
	fetchedAt: 1_700_000_000_000,
	hash: "abc123",
});

const request = (overrides: Partial<Request> = {}): Request =>
	({
		id: "req_1",
		collectionId: "col_1",
		name: "List pets",
		description: "",
		method: "GET",
		url: "{{baseUrl}}/pets",
		params: [],
		headers: [],
		body: { mode: "none" },
		bodyType: "none",
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		stream: false,
		specOperation: { operationId: "listPets", method: "GET", path: "/pets" },
		order: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}) as Request;

const check = () => fireEvent.click(screen.getByRole("button", { name: /check for changes/i }));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("SpecSync", () => {
	it("reports up to date when the document comes back byte for byte", async () => {
		importFetch.mockResolvedValue({ content: BOUND });
		render(<SpecSync spec={spec(BOUND)} specFile={undefined} requests={[request()]} />);

		check();

		expect(await screen.findByText(/up to date/i)).toBeTruthy();
		expect(screen.queryByText(/the document has changed/i)).toBeNull();
	});

	it("states every count, zeros included, when the document has changed", async () => {
		importFetch.mockResolvedValue({ content: doc("List all the pets") });
		render(<SpecSync spec={spec(BOUND)} specFile={undefined} requests={[request()]} />);

		check();

		expect(await screen.findByText(/the document has changed/i)).toBeTruthy();
		expect(
			screen.getByText(
				/0 new operations · 0 requests whose operation is gone · 1 changed · 0 unchanged/i
			)
		).toBeTruthy();
		expect(screen.getByText("name")).toBeTruthy();
	});

	it("marks a field the user edited, and leaves one only the document moved unmarked", async () => {
		importFetch.mockResolvedValue({
			content: doc("List pets", {
				parameters: [{ name: "limit", in: "query", required: true, example: "50" }],
			}),
		});
		render(
			<SpecSync
				spec={spec(BOUND)}
				specFile={undefined}
				requests={[request({ name: "My pets call" })]}
			/>
		);

		check();

		expect(await screen.findByText(/the document has changed/i)).toBeTruthy();
		// The name is the user's (the document still says "List pets"); the URL is
		// the document's, and neither is described as the other.
		const flags = screen.getAllByText(/edited here/i);
		expect(flags).toHaveLength(1);
		expect(screen.getByText("url")).toBeTruthy();
	});

	it("writes nothing at all while checking", async () => {
		importFetch.mockResolvedValue({ content: doc("List all the pets") });
		render(<SpecSync spec={spec(BOUND)} specFile={undefined} requests={[request()]} />);

		check();

		await screen.findByText(/the document has changed/i);
		for (const write of [
			updateRequest,
			updateCollection,
			createRequest,
			deleteRequest,
			createSpec,
		]) {
			expect(write).not.toHaveBeenCalled();
		}
		expect(screen.getByText(/nothing has been changed/i)).toBeTruthy();
	});

	it("says what to do when the binding records no origin to read from", async () => {
		render(<SpecSync spec={spec(BOUND, null)} specFile={undefined} requests={[request()]} />);

		check();

		expect(await screen.findByText(/Bind it again/i)).toBeTruthy();
		expect(importFetch).not.toHaveBeenCalled();
	});

	it("surfaces the engine's message when the re-fetch fails", async () => {
		importFetch.mockRejectedValue(new Error("Fetch failed: 404 Not Found"));
		render(<SpecSync spec={spec(BOUND)} specFile={undefined} requests={[request()]} />);

		check();

		expect(await screen.findByText(/404 Not Found/)).toBeTruthy();
	});

	it("declares a surface everywhere it draws a rule", async () => {
		// The declaration half of the `--rule` contract: `border-rule` under no
		// declared surface falls back to the `:root` default, which inside a card
		// is invisible in dark. Rendered rather than scanned, and the count is
		// asserted so this cannot pass by finding nothing.
		importFetch.mockResolvedValue({ content: doc("List all the pets") });
		const { container } = render(
			<SpecSync spec={spec(BOUND)} specFile={undefined} requests={[request()]} />
		);

		check();
		await screen.findByText(/the document has changed/i);

		const ruled = container.querySelectorAll(".border-rule");
		expect(ruled.length).toBeGreaterThan(1);
		for (const element of ruled) {
			expect(element.className).toMatch(/surface-(card|sunken)/);
		}
	});

	it("cannot be checked until the stored document has loaded", async () => {
		render(<SpecSync spec={undefined} specFile={undefined} requests={[request()]} />);

		const button = screen.getByRole("button", { name: /check for changes/i });
		expect(button.hasAttribute("disabled")).toBe(true);
		await waitFor(() => {
			expect(screen.getByText(/has to load before it can be compared/i)).toBeTruthy();
		});
	});
});
