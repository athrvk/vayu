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
 * "Export as Postman Environment" on an environment row (#2253): one engine
 * call, the file it answers with downloaded, and a toast that says what the
 * file left out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import VariablesCategoryTree from "./VariablesCategoryTree";
import type { Environment, PostmanEnvironmentExportResponse } from "@/types";

const STAGING = {
	id: "env_1",
	name: "Staging",
	variables: { API_KEY: { value: "x", type: "secret" } },
	isActive: false,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
} as unknown as Environment;

const idle = { isLoading: false, isError: false, refetch: vi.fn() };

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ ...idle, data: [] }),
	useEnvironmentsQuery: () => ({ ...idle, data: [STAGING] }),
	useCreateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const showToast = vi.fn();
vi.mock("@/stores", () => ({
	useTabsStore: (select: (s: { openTab: () => void }) => unknown) => select({ openTab: vi.fn() }),
	useSaveStore: (select: (s: Record<string, unknown>) => unknown) =>
		select({ startSaving: vi.fn(), completeSaveThenIdle: vi.fn(), failSave: vi.fn() }),
	useToastStore: (select: (s: { showToast: typeof showToast }) => unknown) =>
		select({ showToast }),
	useLayoutStore: (select: (s: { revealDrawerView: () => void }) => unknown) =>
		select({ revealDrawerView: vi.fn() }),
}));
vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: (
		select: (s: { selectedCategory: null; setSelectedCategory: () => void }) => unknown
	) => select({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

const { exportPostmanEnvironment } = vi.hoisted(() => ({ exportPostmanEnvironment: vi.fn() }));
vi.mock("@/services/api", () => ({ apiService: { exportPostmanEnvironment } }));

const createObjectURL = vi.fn(() => "blob:env");
const revokeObjectURL = vi.fn();
const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click");

function answer(
	notes: Partial<PostmanEnvironmentExportResponse["notes"]> = {}
): PostmanEnvironmentExportResponse {
	return {
		text: '{"name":"Staging"}',
		fileName: "Staging.postman_environment.json",
		notes: { variablesExported: 1, secretsOmitted: 0, notCarried: [], ...notes },
	};
}

beforeEach(() => {
	exportPostmanEnvironment.mockReset().mockResolvedValue(answer());
	showToast.mockReset();
	createObjectURL.mockClear();
	revokeObjectURL.mockClear();
	anchorClick.mockReset().mockImplementation(() => {});
	URL.createObjectURL = createObjectURL;
	URL.revokeObjectURL = revokeObjectURL;
});

function openEnvironmentMenu() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<VariablesCategoryTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const row = within(screen.getByRole("tree", { name: "Variable scopes" }))
		.getAllByRole("treeitem")
		.find((item) => item.getAttribute("data-tree-label") === "Staging")!;
	fireEvent.contextMenu(row);
}

async function clickExport() {
	openEnvironmentMenu();
	fireEvent.click(await screen.findByRole("menuitem", { name: /Export as Postman Environment/ }));
}

describe("Export as Postman Environment on an environment row", () => {
	it("asks the engine for that environment, leaving includeSecrets to its default", async () => {
		await clickExport();

		await waitFor(() => expect(exportPostmanEnvironment).toHaveBeenCalledTimes(1));
		expect(exportPostmanEnvironment).toHaveBeenCalledWith({ environmentId: "env_1" });
	});

	it("downloads the engine's text under the engine's file name", async () => {
		const anchors: HTMLAnchorElement[] = [];
		anchorClick.mockImplementation(function (this: HTMLAnchorElement) {
			anchors.push(this);
		});

		await clickExport();

		await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
		expect(anchors[0].download).toBe("Staging.postman_environment.json");
		expect(anchors[0].href).toBe("blob:env");
		const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
		expect(await blob.text()).toBe('{"name":"Staging"}');
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:env");
	});

	it("names the file in the toast when nothing was left out", async () => {
		await clickExport();

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Exported Staging.postman_environment.json",
				"success"
			)
		);
	});

	it("says how many secret values were left blank", async () => {
		exportPostmanEnvironment.mockResolvedValue(answer({ secretsOmitted: 3 }));

		await clickExport();

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Exported Staging.postman_environment.json - 3 secret values left blank",
				"success"
			)
		);
	});

	it("says how many JSON variables were written as default, singular too", async () => {
		exportPostmanEnvironment.mockResolvedValue(
			answer({
				secretsOmitted: 1,
				notCarried: [{ code: "variable_types", count: 1, message: "JSON types" }],
			})
		);

		await clickExport();

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Exported Staging.postman_environment.json - 1 secret value left blank, 1 JSON variable written as default",
				"success"
			)
		);
	});

	it("reports a failed export as an error and downloads nothing", async () => {
		exportPostmanEnvironment.mockRejectedValue(new Error("Environment not found"));

		await clickExport();

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Couldn't export the environment - Environment not found",
				"error"
			)
		);
		expect(anchorClick).not.toHaveBeenCalled();
		expect(showToast).not.toHaveBeenCalledWith(expect.anything(), "success");
	});

	it("ignores a second pick while the first is in flight, then allows another", async () => {
		let resolve!: (value: PostmanEnvironmentExportResponse) => void;
		exportPostmanEnvironment.mockReturnValueOnce(
			new Promise<PostmanEnvironmentExportResponse>((r) => (resolve = r))
		);

		await clickExport();
		fireEvent.contextMenu(
			within(screen.getByRole("tree", { name: "Variable scopes" }))
				.getAllByRole("treeitem")
				.find((item) => item.getAttribute("data-tree-label") === "Staging")!
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /Export as Postman Environment/ })
		);
		expect(exportPostmanEnvironment).toHaveBeenCalledTimes(1);

		resolve(answer());
		await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));

		fireEvent.contextMenu(
			within(screen.getByRole("tree", { name: "Variable scopes" }))
				.getAllByRole("treeitem")
				.find((item) => item.getAttribute("data-tree-label") === "Staging")!
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /Export as Postman Environment/ })
		);
		await waitFor(() => expect(exportPostmanEnvironment).toHaveBeenCalledTimes(2));
	});
});
