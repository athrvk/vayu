/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DataFileSection } from "./DataFileSection";
import type { LoadTestDataFile } from "./useLoadTestDataFile";

afterEach(cleanup);

/** The picker is the dialog suite's business; this file is about what sits around it. */
vi.mock("@/modules/collections/DataFilePicker", () => ({ default: () => null }));

const IDLE: LoadTestDataFile = {
	file: null,
	error: null,
	setError: vi.fn(),
	select: vi.fn(),
	changeReading: vi.fn(),
	prefillNote: null,
	warnings: [],
	clearContract: undefined,
	writerError: null,
};

describe("DataFileSection", () => {
	it("says nothing extra for an idle picker", () => {
		render(<DataFileSection dataFile={IDLE} disabled={false} />);
		expect(screen.queryByText(/remembered data file/i)).toBeNull();
		expect(screen.queryByText(/update the data contract/i)).toBeNull();
	});

	it("warns, without blocking, about a remembered file that could not be re-read", () => {
		render(
			<DataFileSection
				dataFile={{ ...IDLE, prefillNote: "orders.csv has moved" }}
				disabled={false}
			/>
		);
		expect(screen.getByText(/remembered data file/i)).toBeInTheDocument();
		expect(screen.getByText(/orders.csv has moved/)).toBeInTheDocument();
	});

	it("names a failed contract write and says the run is unaffected, even for an empty message", () => {
		render(
			<DataFileSection
				dataFile={{ ...IDLE, writerError: { message: "" } }}
				disabled={false}
			/>
		);
		expect(screen.getByText(/update the data contract/i)).toBeInTheDocument();
		expect(screen.getByText(/the run is unaffected/i)).toBeInTheDocument();
	});
});
