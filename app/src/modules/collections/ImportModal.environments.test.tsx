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
 * A Postman environment export is the only import whose result has no
 * collections, which puts two previously unreachable states on screen:
 *
 * 1. The preview tree renders environments. It only ever rendered collections,
 *    so an environment-only import previewed as an empty box.
 * 2. With "Import environments & variables" off, the parse yields nothing at
 *    all. Import would have created nothing and closed the modal - a silent
 *    no-op. It is blocked, and the toggle that recovers it is in the same footer.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/services/api", () => ({ apiService: { importFetch: vi.fn() } }));

import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";

const environmentFile = readFileSync(
	join(__dirname, "../../services/importers/__fixtures__/postman-environment.json"),
	"utf8"
);

const globalsFile = readFileSync(
	join(__dirname, "../../services/importers/__fixtures__/postman-globals.json"),
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

async function pasteAndPreview(raw: string) {
	selectTab(/Paste JSON/i);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: raw } });
	fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
	await waitFor(() => expect(screen.getByRole("button", { name: /^Import/i })).toBeVisible());
}

beforeEach(() => {
	useImportModalStore.setState({ isOpen: true });
});

describe("ImportModal with a Postman environment export", () => {
	it("previews the environment and its variable count", async () => {
		renderModal();
		await pasteAndPreview(environmentFile);

		expect(screen.getByText("Postman Environment")).toBeVisible();
		expect(screen.getByText("Sample Staging")).toBeVisible();
		expect(screen.getByText("5 variables")).toBeVisible();
		expect(
			screen.getByText(/0 requests · 0 folders · 0 examples · 1 environments/)
		).toBeVisible();
	});

	it("keeps Import enabled - an environment-only import is a real import", async () => {
		renderModal();
		await pasteAndPreview(environmentFile);

		expect(screen.getByRole("button", { name: /^Import/i })).toBeEnabled();
	});

	it("blocks Import and says why once environments are excluded", async () => {
		renderModal();
		await pasteAndPreview(environmentFile);

		fireEvent.click(screen.getByLabelText(/Import environments/i));

		expect(screen.getByRole("button", { name: /^Import/i })).toBeDisabled();
		expect(screen.getByText(/No collections in this file/i)).toBeVisible();
		expect(screen.queryByText("Sample Staging")).toBeNull();
	});

	it("recovers when the option is turned back on", async () => {
		renderModal();
		await pasteAndPreview(environmentFile);

		const envs = screen.getByLabelText(/Import environments/i);
		fireEvent.click(envs);
		fireEvent.click(envs);

		expect(screen.getByRole("button", { name: /^Import/i })).toBeEnabled();
		expect(screen.getByText("Sample Staging")).toBeVisible();
		expect(screen.queryByText(/No collections in this file/i)).toBeNull();
	});
});

/**
 * A globals export produces neither collections nor environments - only the
 * `globals` record - so every count-driven surface has to read that field too or
 * the preview reports an empty import for a file that will write four variables.
 */
describe("ImportModal with a Postman globals export", () => {
	it("previews the globals destination and its variable count", async () => {
		renderModal();
		await pasteAndPreview(globalsFile);

		expect(screen.getByText("Postman Globals")).toBeVisible();
		// Named for the destination scope, not the workspace the file came from.
		expect(screen.getByText("Globals")).toBeVisible();
		expect(screen.queryByText("Sample Workspace Globals")).toBeNull();
		expect(screen.getByText("4 variables")).toBeVisible();
		expect(screen.getByText(/0 environments · 4 globals/)).toBeVisible();
	});

	it("keeps Import enabled - a globals-only import is a real import", async () => {
		renderModal();
		await pasteAndPreview(globalsFile);

		expect(screen.getByRole("button", { name: /^Import/i })).toBeEnabled();
		expect(screen.queryByText(/Nothing to import/i)).toBeNull();
	});

	it("states that existing globals survive the merge", async () => {
		renderModal();
		await pasteAndPreview(globalsFile);

		expect(screen.getByText(/Existing globals are kept/i)).toBeVisible();
	});

	it("blocks Import once variables are excluded, and recovers", async () => {
		renderModal();
		await pasteAndPreview(globalsFile);

		const envs = screen.getByLabelText(/Import environments/i);
		fireEvent.click(envs);
		expect(screen.getByRole("button", { name: /^Import/i })).toBeDisabled();
		expect(screen.queryByText("4 variables")).toBeNull();

		fireEvent.click(envs);
		expect(screen.getByRole("button", { name: /^Import/i })).toBeEnabled();
		expect(screen.getByText("4 variables")).toBeVisible();
	});
});
