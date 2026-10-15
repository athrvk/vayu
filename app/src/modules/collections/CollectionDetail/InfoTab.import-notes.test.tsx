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
 * The import report on the collection it describes (issue #2109).
 *
 * The toast that announces an import can expire and the dialog that drew the
 * ledger is gone, so the Info tab is where the notices stay readable until the
 * user dismisses them.
 *
 * Mutation check: drop `<ImportNotesCallout>` from `InfoTab`, or make the
 * dismiss button a no-op, and the matching case fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useImportReportStore, type ImportReport } from "@/stores/import-report-store";
import type { Collection } from "@/types";

const mutation = {
	mutateAsync: vi.fn(() => Promise.resolve()),
	mutate: vi.fn(),
	reset: vi.fn(),
	isPending: false,
	isError: false,
};

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
}));

// The file-reference list asks which folders are already allowed.
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useFileRootsQuery: () => ({ data: [], isLoading: false, isError: false }),
}));

const { default: InfoTab } = await import("./InfoTab");
await import("@/components/ui/markdown-renderer");

const collection = {
	id: "c1",
	name: "Pet Store",
	description: "",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
} as unknown as Collection;

const report: ImportReport = {
	title: "Pet Store",
	fileName: "petstore.json",
	notices: [
		{ tier: "action", text: "3 requests: auth imported but not sent" },
		{ tier: "note", text: "2 example responses were not kept" },
	],
	fileNeeds: { folders: [], bodiesWithoutFile: 0 },
	counts: { requests: 3, folders: 0, environments: 0, globals: 0 },
	rootIds: ["c1", "c2"],
};

async function renderTab(id = "c1") {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<InfoTab collection={{ ...collection, id }} requestCount={3} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await act(async () => {});
}

beforeEach(() => {
	useImportReportStore.setState({ reports: {} });
});

describe("InfoTab - the import notes", () => {
	it("shows nothing for a collection no import recorded a report for", async () => {
		await renderTab();
		expect(screen.queryByText("Import notes")).toBeNull();
		expect(screen.queryByRole("button", { name: "Dismiss import notes" })).toBeNull();
	});

	it("lists the notices the preview showed, under the file's name", async () => {
		useImportReportStore.getState().record(report);
		await renderTab();

		expect(screen.getByText("Import notes")).toBeInTheDocument();
		expect(screen.getByText("petstore.json")).toBeInTheDocument();
		expect(screen.getByText("3 requests: auth imported but not sent")).toBeInTheDocument();
		expect(screen.getByText("2 example responses were not kept")).toBeInTheDocument();
	});

	it("lists the file bodies that still need a file", async () => {
		useImportReportStore
			.getState()
			.record({ ...report, notices: [], fileNeeds: { folders: [], bodiesWithoutFile: 2 } });
		await renderTab();

		expect(screen.getByText("2 file bodies need files")).toBeInTheDocument();
	});

	it("is dismissed by its button, for every root the file created", async () => {
		useImportReportStore.getState().record(report);
		await renderTab();

		fireEvent.click(screen.getByRole("button", { name: "Dismiss import notes" }));

		expect(screen.queryByText("Import notes")).toBeNull();
		expect(useImportReportStore.getState().reports).toEqual({});
	});

	it("does not show another root's report", async () => {
		useImportReportStore.getState().record({ ...report, rootIds: ["other"] });
		await renderTab();

		expect(screen.queryByText("Import notes")).toBeNull();
	});
});
