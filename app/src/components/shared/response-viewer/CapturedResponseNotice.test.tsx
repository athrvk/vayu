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
 * The notice reports `bodyBytes`, which is documented as the size *before* any
 * truncation - so the largest numbers in the app arrive here, on exactly the
 * paths that exist because a body was too big to keep.
 *
 * This component used to format them with a private copy of `formatBytes` that
 * stopped at MB, so a 2 GB response read "2048.0 MB". The copy was the defect;
 * these assert the shared formatter's GB branch is the one in use.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CapturedResponseNotice } from "./CapturedResponseNotice";
import type { RunSample } from "@/types/domain";

const GB = 1024 * 1024 * 1024;

/** Render the notice for one captured response and hand back its text. */
function noticeFor(response: RunSample["response"]): string {
	const { container } = render(<CapturedResponseNotice response={response} />);
	return container.textContent ?? "";
}

describe("sizes past a gigabyte", () => {
	it("scales a dropped body to GB rather than reporting thousands of MB", () => {
		const text = noticeFor({ headers: {}, bodyBytes: 2 * GB, bodyDropped: true });
		expect(text).toContain("2.0 GB");
		expect(text).not.toContain("MB");
	});

	it("scales a binary body to GB too", () => {
		const text = noticeFor({
			headers: {},
			bodyBytes: 3 * GB,
			binary: true,
			contentType: "application/octet-stream",
		});
		expect(text).toContain("3.0 GB");
	});
});

describe("the smaller units the private copy did get right", () => {
	it("still reads bytes and MB as before", () => {
		expect(noticeFor({ headers: {}, bodyBytes: 34, bodyDropped: true })).toContain("34 B");
		expect(noticeFor({ headers: {}, bodyBytes: 5 * 1024 * 1024, bodyDropped: true })).toContain(
			"5.0 MB"
		);
	});
});
