import { beforeEach, describe, expect, it } from "vitest";
import {
	hasReport,
	selectImportReport,
	useImportReportStore,
	type ImportReport,
} from "./import-report-store";

function report(overrides: Partial<ImportReport> = {}): ImportReport {
	return {
		title: "Pet Store",
		fileName: "petstore.json",
		notices: [{ tier: "action", text: "2 requests' auth imported but not sent" }],
		fileNeeds: { folders: [], bodiesWithoutFile: 0 },
		counts: { requests: 60, folders: 4, environments: 0, globals: 0 },
		rootIds: ["col_1"],
		...overrides,
	};
}

beforeEach(() => useImportReportStore.setState({ reports: {} }));

describe("hasReport", () => {
	it("is true for a notice, a folder to allow, or a body without a file", () => {
		expect(hasReport(report())).toBe(true);
		expect(
			hasReport(
				report({
					notices: [],
					fileNeeds: {
						folders: [{ folder: "/home/u/files", count: 2 }],
						bodiesWithoutFile: 0,
					},
				})
			)
		).toBe(true);
		expect(
			hasReport(report({ notices: [], fileNeeds: { folders: [], bodiesWithoutFile: 1 } }))
		).toBe(true);
	});

	it("is false when the file lost nothing", () => {
		expect(hasReport(report({ notices: [] }))).toBe(false);
	});
});

describe("useImportReportStore", () => {
	it("keeps the report under its root and hands it to the selector", () => {
		const kept = report();
		useImportReportStore.getState().record(kept);

		expect(selectImportReport("col_1")(useImportReportStore.getState())).toBe(kept);
		expect(selectImportReport("col_2")(useImportReportStore.getState())).toBeUndefined();
		expect(selectImportReport(null)(useImportReportStore.getState())).toBeUndefined();
	});

	it("stores a multi-root file's one report under every root", () => {
		const kept = report({ rootIds: ["col_1", "col_2"] });
		useImportReportStore.getState().record(kept);

		const { reports } = useImportReportStore.getState();
		expect(reports.col_1).toBe(kept);
		expect(reports.col_2).toBe(kept);
	});

	it("does not store an empty report, or one with no collection to show it on", () => {
		useImportReportStore.getState().record(report({ notices: [] }));
		useImportReportStore.getState().record(report({ rootIds: [] }));

		expect(useImportReportStore.getState().reports).toEqual({});
	});

	it("dismisses the report from every root of its file, leaving other files alone", () => {
		const other = report({ title: "Orders", rootIds: ["col_9"] });
		useImportReportStore.getState().record(report({ rootIds: ["col_1", "col_2"] }));
		useImportReportStore.getState().record(other);

		useImportReportStore.getState().dismiss("col_1");

		expect(useImportReportStore.getState().reports).toEqual({ col_9: other });
	});

	it("ignores a dismiss for a root that carries no report", () => {
		const before = useImportReportStore.getState().reports;
		useImportReportStore.getState().dismiss("col_missing");
		expect(useImportReportStore.getState().reports).toBe(before);
	});
});
