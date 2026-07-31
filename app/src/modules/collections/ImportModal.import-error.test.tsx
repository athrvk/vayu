/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Force the import mutation to reject so we can assert the modal surfaces the
// failure. `rejection` is per-test so one case can fail with a plain Error and
// another with the engine's per-item ApiError.
const state = vi.hoisted(() => ({ rejection: new Error("import boom") as unknown }));

vi.mock("@/queries/import", () => ({
	useImportMutation: () => ({
		mutateAsync: vi.fn().mockImplementation(async ({ result }) => {
			// The real mutation stamps temp ids onto this same object before it
			// sends it, and the modal's failure message resolves the engine's temp
			// id back through it - so a fake that skips that step would test a
			// lookup that can never hit.
			assignTempIds(result);
			throw state.rejection;
		}),
		isPending: false,
	}),
}));

import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";
import { ApiError } from "@/services/http-client";
import { assignTempIds } from "@/services/importers/assign-ids";

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

/**
 * Radix TabsTrigger activates on mousedown (and on focus in its default
 * automatic mode), not on a bare synthetic click - so fireEvent.click alone
 * leaves the tab unselected. Fire the sequence a real click produces.
 */
function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

describe("ImportModal - failed import", () => {
	beforeEach(() => {
		useImportModalStore.setState({ isOpen: true });
		state.rejection = new Error("import boom");
	});

	/** Drive the modal to the point where Import has been clicked and has failed. */
	async function failAnImport() {
		renderModal();
		selectTab(/Paste JSON/i);
		fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: postman } });
		fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /^Import/i })).toBeInTheDocument()
		);
		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));
	}

	it("surfaces the error when the import rejects (modal stays open)", async () => {
		await failAnImport();
		await waitFor(() => expect(screen.getByText(/import boom/i)).toBeInTheDocument());
	});

	/**
	 * The documented contract of `POST /import/apply` is that a failure "names the
	 * item that broke" - and until issue #173 that name died at this hop: the
	 * engine's message was dropped by the http-client and the temp id was never
	 * read at all, so a 500-item import failed with "HTTP 400: Bad Request".
	 */
	it("names the item the engine rejected, by the name shown in the preview", async () => {
		state.rejection = new ApiError(400, "bad_request", "Missing required field: method", {
			error: { code: "bad_request", message: "Missing required field: method", item: "c1" },
		});

		await failAnImport();
		await waitFor(() =>
			expect(screen.getByText(/Missing required field: method \(item: "/)).toBeInTheDocument()
		);
	});
});
