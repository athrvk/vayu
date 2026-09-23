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
 * The import's progress line is announced (#1691).
 *
 * An import is the longest operation the app runs from a dialog, and its
 * report was visual only - while the export dialog and the collection tree,
 * both of which finish faster, already announced with `role="status"`.
 *
 * The second case is the one that is easy to lose: a polite region re-announces
 * whenever its text changes, so a byte counter ticking several times a second
 * would talk over the rest of the dialog for the length of a download. File
 * counts move once per document and stay in.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ImportProgressView } from "./ImportProgressView";

const region = () => screen.getByRole("status");

describe("ImportProgressView", () => {
	it("announces the stage and the file counts", () => {
		render(<ImportProgressView progress={{ stage: "applying", done: 3, total: 10 }} />);

		expect(region()).toHaveAttribute("aria-live", "polite");
		expect(region().textContent).toContain("3 of 10 files");
	});

	it("keeps the byte counter out of what is announced", () => {
		render(
			<ImportProgressView progress={{ stage: "fetching", received: 2048, total: 65536 }} />
		);

		// Still on screen - the eye gets the figures, the region does not. The
		// element is found by the bytes it prints, so a detail line that stopped
		// rendering at all would fail here rather than pass as "hidden".
		const detail = region().querySelector('[aria-hidden="true"]');
		expect(detail?.textContent).toMatch(/\bKB\b/);
	});
});
