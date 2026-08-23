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
 * The predicate reads a marker Radix stamps, so the cases that matter are the
 * ones a real dialog passes through: absent, open, and the closed-but-still-
 * mounted moment of an exit animation. The negative cases are asserted too - a
 * predicate stuck on `true` would make every chord in the app dead.
 */

import { describe, it, expect, afterEach } from "vitest";
import { isModalOpen } from "./modal";

const body = (html: string) => {
	document.body.innerHTML = html;
};

afterEach(() => {
	document.body.innerHTML = "";
});

describe("isModalOpen", () => {
	it("is false with nothing mounted", () => {
		expect(isModalOpen()).toBe(false);
	});

	it("is true while a dialog is open", () => {
		body('<div data-slot="dialog-content" data-state="open"></div>');
		expect(isModalOpen()).toBe(true);
	});

	it("is false for a dialog playing its exit animation", () => {
		body('<div data-slot="dialog-content" data-state="closed"></div>');
		expect(isModalOpen()).toBe(false);
	});

	it("is true when any one of several is open", () => {
		body(
			'<div data-slot="dialog-content" data-state="closed"></div>' +
				'<div data-slot="dialog-content" data-state="open"></div>'
		);
		expect(isModalOpen()).toBe(true);
	});

	it("ignores a popover, which does not take the window", () => {
		body('<div data-slot="popover-content" data-state="open"></div>');
		expect(isModalOpen()).toBe(false);
	});
});
