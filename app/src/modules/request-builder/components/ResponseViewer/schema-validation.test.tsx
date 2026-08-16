/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two surfaces a schema verdict reaches (issue #628): the chip in the
 * status band and the section in the Tests tab.
 *
 * Every case here is one of the three states being told apart. Collapsing
 * "not checked" into "failed" is the defect the shape of the verdict exists to
 * prevent, so it is asserted rather than assumed - as is the disclosure that
 * makes a `valid: true` honest when part of the schema went unevaluated.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ValidationChip } from "@/components/shared/response-viewer/ValidationChip";
import type { ResponseValidation } from "@/types";
import SchemaValidation from "./SchemaValidation";

const clean: ResponseValidation = {
	checked: true,
	valid: true,
	failures: [],
	failuresTotal: 0,
	matchedStatus: "200",
	matchedContentType: "application/json",
};

describe("ValidationChip", () => {
	it("says a clean response matched", () => {
		render(<ValidationChip validation={clean} />);
		expect(screen.getByText("Matched schema")).toBeTruthy();
	});

	it("names the count when the body failed", () => {
		render(
			<ValidationChip
				validation={{ ...clean, valid: false, failuresTotal: 3, failures: [] }}
			/>
		);
		expect(screen.getByText(/Schema failed - 3 problems/)).toBeTruthy();
	});

	it("says unchecked rather than failed when nothing was checked", () => {
		// The distinction the whole node exists for. A response nothing checked
		// is not a response that failed its contract.
		render(<ValidationChip validation={{ checked: false, reason: "no_schema_for_status" }} />);
		expect(screen.getByText("Schema not checked")).toBeTruthy();
		expect(screen.queryByText(/Schema failed/)).toBeNull();
	});

	it("does not claim a clean match when part of the schema went unevaluated", () => {
		// Revert the `partial` branch and a body whose contract was only half
		// read reports as fully matched.
		render(
			<ValidationChip
				validation={{
					...clean,
					unevaluatedKeywords: [{ keyword: "unevaluatedProperties", count: 1 }],
				}}
			/>
		);
		expect(screen.getByText("Schema partly checked")).toBeTruthy();
		expect(screen.queryByText("Matched schema")).toBeNull();
	});
});

describe("SchemaValidation", () => {
	it("lists each failure with its path", () => {
		render(
			<SchemaValidation
				validation={{
					checked: true,
					valid: false,
					failures: [{ path: "/tag/name", message: "Value type not permitted." }],
					failuresTotal: 1,
					matchedStatus: "200",
				}}
			/>
		);
		expect(screen.getByText("/tag/name")).toBeTruthy();
		expect(screen.getByText(/Value type not permitted/)).toBeTruthy();
	});

	it("says how many failures were not shown", () => {
		// A list shorter than the count reads as the whole set unless it says
		// otherwise - the `MAX_FAILURE_MESSAGES` disclosure discipline.
		render(
			<SchemaValidation
				validation={{
					checked: true,
					valid: false,
					failures: [{ path: "/a", message: "bad" }],
					failuresTotal: 40,
				}}
			/>
		);
		expect(screen.getByText("Showing 1 of 40.")).toBeTruthy();
	});

	it("names the keywords the validator could not evaluate", () => {
		render(
			<SchemaValidation
				validation={{
					...clean,
					unevaluatedKeywords: [
						{ keyword: "unevaluatedProperties", count: 2 },
						{ keyword: "prefixItems", count: 1 },
					],
				}}
			/>
		);
		expect(screen.getByText(/unevaluatedProperties \(2\), prefixItems/)).toBeTruthy();
	});

	it("explains why an unchecked response was not checked", () => {
		render(<SchemaValidation validation={{ checked: false, reason: "body_not_json" }} />);
		expect(screen.getByText(/body is not JSON/)).toBeTruthy();
	});

	it("falls back to an honest sentence for a reason it does not know", () => {
		// An engine newer than this app must not render a raw identifier.
		render(
			<SchemaValidation
				validation={{
					checked: false,
					reason: "something_new" as ResponseValidation["reason"],
				}}
			/>
		);
		expect(screen.getByText("This response was not checked.")).toBeTruthy();
	});
});
