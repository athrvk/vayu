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
 * Two footgun-shaped bugs in the import modal.
 *
 * 1. The two import options lived inside a *single* <label>. A label's control
 *    is its first labelable descendant, so both rows named the environments
 *    checkbox: clicking the words "Import pre-request & test scripts" toggled
 *    environments, and the scripts checkbox had no label of its own at all.
 *
 * 2. `phase === "detecting"` was assigned in two places and read by nothing.
 *    The URL tab is the one asynchronous source, so for the whole round-trip
 *    the Fetch button stayed enabled and unchanged and a second click started a
 *    second fetch racing the first.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const importFetch = vi.fn();
vi.mock("@/services/api", () => ({ apiService: { importFetch: (u: string) => importFetch(u) } }));

import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";

const postman = readFileSync(
	join(__dirname, "../../services/importers/__fixtures__/postman-v21.json"),
	"utf8"
);

function renderModal() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<ImportModal />
		</QueryClientProvider>
	);
}

/** Radix TabsTrigger activates on mousedown, not on a bare synthetic click. */
function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

async function reachPreview() {
	selectTab(/Paste JSON/i);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: postman } });
	fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
	await waitFor(() => expect(screen.getByRole("button", { name: /^Import/i })).toBeVisible());
}

beforeEach(() => {
	importFetch.mockReset();
	useImportModalStore.setState({ isOpen: true });
});

describe("ImportModal option checkboxes", () => {
	it("labels each checkbox separately", async () => {
		renderModal();
		await reachPreview();

		const envs = screen.getByLabelText(/Import environments/i);
		const scripts = screen.getByLabelText(/Import pre-request/i);
		// One <label> around both made these the same element.
		expect(envs).not.toBe(scripts);
	});

	it("toggles the scripts checkbox when its own words are clicked", async () => {
		renderModal();
		await reachPreview();

		const envs = screen.getByLabelText(/Import environments/i) as HTMLInputElement;
		const scripts = screen.getByLabelText(/Import pre-request/i) as HTMLInputElement;
		expect(envs.checked).toBe(true);
		expect(scripts.checked).toBe(true);

		fireEvent.click(screen.getByText(/Import pre-request & test scripts/i));

		expect(scripts.checked).toBe(false);
		// The bug: this one moved instead.
		expect(envs.checked).toBe(true);
	});
});

describe("ImportModal URL fetch while in flight", () => {
	it("shows the fetch is running and refuses a second one", async () => {
		let release!: (v: { content: string }) => void;
		importFetch.mockReturnValue(
			new Promise<{ content: string }>((resolve) => {
				release = resolve;
			})
		);

		renderModal();
		selectTab(/URL/i);
		fireEvent.change(screen.getByPlaceholderText(/petstore/i), {
			target: { value: "https://example.com/openapi.json" },
		});

		const fetchButton = screen.getByRole("button", { name: /^Fetch$/i });
		fireEvent.click(fetchButton);

		const busy = await screen.findByRole("button", { name: /Fetching/i });
		expect(busy).toBeDisabled();

		// A disabled button swallows clicks, so drive the other entry point too:
		// Enter in the URL field called the same handler unguarded.
		fireEvent.keyDown(screen.getByPlaceholderText(/petstore/i), { key: "Enter" });
		fireEvent.click(busy);
		expect(importFetch).toHaveBeenCalledTimes(1);

		release({ content: postman });
		await waitFor(() => expect(screen.getByText(/Postman Collection v2\.1/i)).toBeVisible());
	});
});
