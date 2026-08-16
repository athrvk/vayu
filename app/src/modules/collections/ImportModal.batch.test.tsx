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
 * Multi-file and folder import, and the silent loss it replaced (issue #666).
 *
 * The dialog read `e.dataTransfer.files[0]` and its `<input type="file">` had no
 * `multiple`, so dropping a folder's worth of specs imported the first one and
 * discarded the other twelve **without a word**. Every test here is written so
 * that restoring `files[0]` - or dropping the per-file apply loop - reddens it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Records what the apply was actually asked to create, and lets one file of a
 * batch be refused - which is the only way to observe per-file atomicity from
 * outside the engine.
 */
const applied = vi.hoisted(() => ({
	names: [] as string[],
	refuse: null as string | null,
}));

vi.mock("@/queries/import", () => ({
	useImportMutation: () => ({
		mutateAsync: vi.fn().mockImplementation(async ({ result }) => {
			const name = result.meta.fileName ?? "";
			if (applied.refuse && name === applied.refuse)
				throw new Error(`engine said no: ${name}`);
			applied.names.push(name);
		}),
		isPending: false,
	}),
}));

import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";

const fixture = (...parts: string[]) =>
	readFileSync(join(__dirname, "../../services/importers/__fixtures__", ...parts), "utf8");

const postman = fixture("postman-v21.json");
const insomnia = fixture("insomnia-v4.json");
const swagger = fixture("swagger-v2.json");

function renderModal() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<ImportModal />
		</QueryClientProvider>
	);
}

function file(name: string, text: string, relativePath?: string): File {
	const f = new File([text], name, { type: "application/json" });
	if (relativePath) {
		// jsdom's File has no webkitRelativePath, which is what a folder pick sets.
		Object.defineProperty(f, "webkitRelativePath", { value: relativePath });
	}
	return f;
}

function dropZone(): HTMLElement {
	return screen.getByText(/Drop files here/i).closest("button")!;
}

/** Drop N files on the zone, the way a folder's contents arrive. */
function drop(...files: File[]) {
	fireEvent.drop(dropZone(), { dataTransfer: { files } });
}

/** The ledger row for one file, by the file name it is labelled with. */
function row(name: string): HTMLElement {
	return screen.getByLabelText(name).closest("label")!;
}

beforeEach(() => {
	applied.names = [];
	applied.refuse = null;
	useImportModalStore.setState({ isOpen: true });
});

describe("dropping several files", () => {
	it("imports every dropped file, not just the first", async () => {
		renderModal();
		drop(file("one.json", postman), file("two.json", insomnia));

		await waitFor(() => expect(screen.getByText("2 files")).toBeInTheDocument());
		// Both rows exist, each with the format detected for that file alone.
		expect(within(row("one.json")).getByText(/Postman Collection v2\.1/)).toBeInTheDocument();
		expect(within(row("two.json")).getByText(/Insomnia Export v4/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));

		// The bug: with `files[0]` this is `["one.json"]` and nothing ever says so.
		await waitFor(() => expect(applied.names).toEqual(["one.json", "two.json"]));
	});

	it("reports a file it cannot parse and imports the rest", async () => {
		renderModal();
		drop(file("good.json", postman), file("junk.json", '{"x":1}'));

		await waitFor(() => expect(screen.getByText("2 files")).toBeInTheDocument());
		expect(within(row("junk.json")).getByText(/Unrecognised format/i)).toBeInTheDocument();
		// Errors are visible but excluded - the honest refusal, per file.
		expect(screen.getByLabelText("junk.json")).not.toBeChecked();
		expect(screen.getByLabelText("good.json")).toBeChecked();

		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));
		await waitFor(() => expect(applied.names).toEqual(["good.json"]));
	});

	it("lets the user exclude a file that parsed fine", async () => {
		renderModal();
		drop(file("one.json", postman), file("two.json", insomnia));
		await waitFor(() => expect(screen.getByText("2 files")).toBeInTheDocument());

		fireEvent.click(screen.getByLabelText("one.json"));
		expect(screen.getByRole("button", { name: /^Import →/ })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));
		await waitFor(() => expect(applied.names).toEqual(["two.json"]));
	});

	it("refuses to import when every file in the batch failed", async () => {
		renderModal();
		drop(file("a.json", "not json at all"), file("b.json", '{"x":1}'));

		await waitFor(() => expect(screen.getByText("2 files")).toBeInTheDocument());
		expect(screen.getByRole("button", { name: /^Import/i })).toBeDisabled();
	});
});

/**
 * Per-file atomicity, which is the whole reason each file is its own
 * `POST /import/apply`: a bad seventh file cannot roll back six good ones.
 */
describe("a file the engine refuses", () => {
	it("leaves the files around it applied, and says which one failed", async () => {
		applied.refuse = "two.json";
		renderModal();
		drop(file("one.json", postman), file("two.json", insomnia), file("three.json", swagger));

		await waitFor(() => expect(screen.getByText("3 files")).toBeInTheDocument());
		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));

		await waitFor(() => expect(applied.names).toEqual(["one.json", "three.json"]));
		// The ledger stays on screen and states the outcome per file - the modal
		// closing on a partial failure would be the silent half of the same bug.
		expect(within(row("two.json")).getByText(/engine said no: two\.json/)).toBeInTheDocument();
		expect(within(row("one.json")).getByText(/Imported/)).toBeInTheDocument();
		expect(screen.getByText(/1 of 3 files failed/i)).toBeInTheDocument();
	});

	it("never lets an applied file be sent twice", async () => {
		applied.refuse = "two.json";
		renderModal();
		drop(file("one.json", postman), file("two.json", insomnia));

		await waitFor(() => expect(screen.getByText("2 files")).toBeInTheDocument());
		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));
		await waitFor(() => expect(applied.names).toEqual(["one.json"]));

		// `POST /import/apply` is create-only and has no idempotency key, so a
		// second send of a file that landed is a second copy of its whole tree.
		expect(screen.getByLabelText("one.json")).toBeDisabled();
		expect(screen.getByRole("button", { name: /^Import/i })).toBeDisabled();
	});
});

describe("importing a folder", () => {
	/** The hidden folder input, which the visible button clicks. */
	function folderInput(): HTMLInputElement {
		const input = document.querySelector<HTMLInputElement>("input[webkitdirectory]");
		// `webkitdirectory` is not in React's attribute table: written as a prop it
		// never reaches the DOM at all, and the button would open an ordinary file
		// picker while claiming to open a folder.
		expect(input, "the dialog should mount a webkitdirectory input").toBeTruthy();
		return input!;
	}

	it("offers the folder affordance and mounts a directory input", () => {
		renderModal();
		expect(screen.getByRole("button", { name: /Import folder/i })).toBeInTheDocument();
		expect(folderInput()).toBeTruthy();
	});

	it("keeps the spec files and drops what a directory drags along with them", async () => {
		renderModal();
		fireEvent.change(folderInput(), {
			target: {
				files: [
					file("openapi.json", swagger, "api/openapi.json"),
					file("collection.json", postman, "api/collection.json"),
					file("logo.png", "PNG", "api/logo.png"),
					file("README.md", "# api", "api/README.md"),
				],
			},
		});

		await waitFor(() => expect(screen.getByText("2 files")).toBeInTheDocument());
		expect(screen.getByLabelText("openapi.json")).toBeInTheDocument();
		expect(screen.queryByLabelText("logo.png")).toBeNull();
	});

	it("recurses into subdirectories and resolves refs from the picked set", async () => {
		renderModal();
		fireEvent.change(folderInput(), {
			target: {
				files: [
					file(
						"openapi.json",
						fixture("openapi-v3-multifile", "spec", "openapi.json"),
						"multi/spec/openapi.json"
					),
					file(
						"pet.json",
						fixture("openapi-v3-multifile", "spec", "schemas", "pet.json"),
						"multi/spec/schemas/pet.json"
					),
					file(
						"error.json",
						fixture("openapi-v3-multifile", "shared", "error.json"),
						"multi/shared/error.json"
					),
				],
			},
		});

		await waitFor(() => expect(screen.getByText("3 files")).toBeInTheDocument());
		// The two referenced files are listed as part of the spec that named them,
		// never as failures and never as imports of their own. Without the in-batch
		// lookup there is no `readSpecFile` in this environment, so the refs would
		// land in the skip tally instead.
		expect(
			within(row("pet.json")).getByText(/Referenced by openapi\.json/)
		).toBeInTheDocument();
		expect(screen.queryByText(/Vayu could not read/i)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));
		await waitFor(() => expect(applied.names).toEqual(["openapi.json"]));
	});
});
