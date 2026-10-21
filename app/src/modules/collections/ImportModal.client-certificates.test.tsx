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
 * A Postman document can name a client certificate on this machine, and the
 * engine turns it into a host-wide registry row when the import is applied. The
 * document chose the host and the path, so the preview lists each candidate and
 * the apply registers only the ones the user ticked (issue #2363).
 *
 * Mutation check: make `ImportOrchestrator.run` send `result.clientCertificates`
 * again and "applies with none ticked" fails - the payload carries both.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";
import { apiService } from "@/services/api";
import type { ImportApplyClientCertificate, ImportApplyRequest } from "@/types";
import type { ImportResult } from "@/services/importers/types";
import { collection, request, result, stubParse } from "./import-preview.testkit";

const API: ImportApplyClientCertificate = {
	host: "api.example.com",
	port: 8443,
	certPath: "/home/me/certs/api.pem",
	keyPath: "/home/me/certs/api.key",
	certFormat: "pem",
	passphrase: "hunter2-never-shown",
};

const BILLING: ImportApplyClientCertificate = {
	host: "billing.example.com",
	certPath: "/home/me/certs/billing.p12",
	certFormat: "p12",
};

function postman(clientCertificates?: ImportApplyClientCertificate[]): ImportResult {
	return result({
		collections: [collection({ name: "API", requests: [request({ name: "Get user" })] })],
		...(clientCertificates ? { clientCertificates } : {}),
	});
}

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

async function previewPasted() {
	renderModal();
	selectTab(/^Paste$/i);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), {
		target: { value: JSON.stringify({ any: "document" }) },
	});
	fireEvent.click(screen.getByRole("button", { name: /Detect and preview/i }));
	await waitFor(() => expect(screen.getByRole("button", { name: /^Import/i })).toBeVisible());
}

/** Every `POST /import/apply` payload, in the order the dialog sent them. */
function stubApply(): ImportApplyRequest[] {
	const sent: ImportApplyRequest[] = [];
	vi.spyOn(apiService, "applyImport").mockImplementation(async (payload) => {
		sent.push(payload);
		const items = [...payload.collections, ...payload.requests, ...payload.environments];
		return {
			idMap: Object.fromEntries(items.map((item) => [item.tempId, `id_${item.tempId}`])),
		};
	});
	return sent;
}

const certificateBox = (name: RegExp) => screen.getByRole("checkbox", { name });

describe("the client certificates an import offers", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		useImportModalStore.setState({ isOpen: true });
	});

	it("lists each candidate with its host and path, all unticked", async () => {
		stubParse(() => postman([API, BILLING]));
		await previewPasted();

		const group = screen.getByRole("group", { name: "Client certificates" });
		const api = within(group).getByRole("checkbox", { name: /api\.example\.com:8443/ });
		const billing = within(group).getByRole("checkbox", { name: /billing\.example\.com/ });
		expect(api).not.toBeChecked();
		expect(billing).not.toBeChecked();
		expect(within(group).getByText("/home/me/certs/api.pem")).toBeVisible();
		expect(within(group).getByText("Key: /home/me/certs/api.key")).toBeVisible();
		expect(within(group).getByText("/home/me/certs/billing.p12")).toBeVisible();
		// No port in the document, none invented.
		expect(within(group).getByText("billing.example.com")).toBeVisible();
	});

	it("never renders the passphrase", async () => {
		stubParse(() => postman([API]));
		await previewPasted();

		expect(document.body.textContent).not.toContain("hunter2");
	});

	it("applies with none ticked and sends no certificate", async () => {
		const sent = stubApply();
		stubParse(() => postman([API, BILLING]));
		await previewPasted();

		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));

		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0].clientCertificates).toEqual([]);
	});

	it("applies with one ticked and sends exactly that one", async () => {
		const sent = stubApply();
		stubParse(() => postman([API, BILLING]));
		await previewPasted();

		fireEvent.click(certificateBox(/billing\.example\.com/));
		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));

		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0].clientCertificates).toEqual([BILLING]);
	});

	it("sends a ticked candidate whole, and an unticked one no longer", async () => {
		const sent = stubApply();
		stubParse(() => postman([API, BILLING]));
		await previewPasted();

		fireEvent.click(certificateBox(/api\.example\.com/));
		fireEvent.click(certificateBox(/billing\.example\.com/));
		fireEvent.click(certificateBox(/billing\.example\.com/));
		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));

		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0].clientCertificates).toEqual([API]);
	});

	it("drops the ticks when an option toggle re-parses the file", async () => {
		const sent = stubApply();
		stubParse(() => postman([API, BILLING]));
		await previewPasted();

		fireEvent.click(certificateBox(/api\.example\.com/));
		fireEvent.click(screen.getByLabelText(/Import pre-request/i));
		await waitFor(() => expect(apiService.parseImport).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(certificateBox(/api\.example\.com/)).not.toBeChecked());

		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0].clientCertificates).toEqual([]);
	});

	it("shows no section when the file offers none", async () => {
		stubParse(() => postman([]));
		await previewPasted();

		expect(screen.queryByRole("group", { name: "Client certificates" })).toBeNull();
	});

	it("shows no section for a format that parses no candidates at all", async () => {
		// Every non-Postman parse leaves the key out, rather than answering `[]`.
		stubParse(() => postman());
		await previewPasted();

		expect(screen.queryByText("Client certificates")).toBeNull();
	});

	it("keeps one file's ticks off the other files of a batch", async () => {
		const sent = stubApply();
		stubParse((payload) => postman(payload.fileName === "one.json" ? [API] : [BILLING]));
		renderModal();
		const zone = screen.getByText(/Drop files here/i).closest("button")!;
		const json = (name: string) => new File(["{}"], name, { type: "application/json" });
		fireEvent.drop(zone, { dataTransfer: { files: [json("one.json"), json("two.json")] } });
		await waitFor(() => expect(screen.getByText("2 files")).toBeInTheDocument());

		const group = screen.getByRole("group", { name: "Client certificates" });
		expect(within(group).getByText("one.json")).toBeVisible();
		expect(within(group).getByText("two.json")).toBeVisible();

		fireEvent.click(certificateBox(/billing\.example\.com/));
		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));

		await waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[0].clientCertificates).toEqual([]);
		expect(sent[1].clientCertificates).toEqual([BILLING]);
	});
});
