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
 * The guard has to hold on the event the IME actually sends: same `key`, same
 * handler, `isComposing` the only thing separating "commit the buffer" from
 * "do the thing". Both halves are asserted, because a helper that returned
 * `false` for every Enter would satisfy the composition case alone.
 */

import { describe, it, expect } from "vitest";
import type { KeyboardEvent } from "react";
import { isCommitEnter, ownsEnterKey, isTextEntryTarget } from "./keyboard";

/** The fields the guard reads, in the shape React hands a handler. */
const keyEvent = (
	key: string,
	isComposing: boolean,
	mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}
): KeyboardEvent => ({ key, nativeEvent: { isComposing }, ...mods }) as KeyboardEvent;

describe("isCommitEnter", () => {
	it("accepts a plain Enter", () => {
		expect(isCommitEnter(keyEvent("Enter", false))).toBe(true);
	});

	it("refuses the Enter that commits an IME composition", () => {
		expect(isCommitEnter(keyEvent("Enter", true))).toBe(false);
	});

	it("refuses any other key, composing or not", () => {
		expect(isCommitEnter(keyEvent("Escape", false))).toBe(false);
		expect(isCommitEnter(keyEvent(" ", true))).toBe(false);
	});

	it("refuses the Enter that carries Ctrl or Cmd - that one is the Send chord", () => {
		expect(isCommitEnter(keyEvent("Enter", false, { ctrlKey: true }))).toBe(false);
		expect(isCommitEnter(keyEvent("Enter", false, { metaKey: true }))).toBe(false);
	});

	it("still accepts Shift+Enter, which no field here reads as a chord", () => {
		expect(isCommitEnter(keyEvent("Enter", false, { shiftKey: true }))).toBe(true);
	});
});

/**
 * The two target sets, asserted against each other: `isTextEntryTarget` is
 * `ownsEnterKey` widened by a plain input, so the pair has to agree everywhere
 * except on that one tag. A helper returning `true` for everything would pass
 * either set alone.
 */
describe("ownsEnterKey / isTextEntryTarget", () => {
	const mount = (html: string, selector: string): HTMLElement => {
		document.body.innerHTML = html;
		return document.querySelector<HTMLElement>(selector)!;
	};

	it("counts a textarea, a contenteditable and a Monaco editor in both sets", () => {
		const cases = [
			mount("<textarea id='t'></textarea>", "#t"),
			mount("<div contenteditable='true' id='c'></div>", "#c"),
			mount("<div class='monaco-editor'><span id='m'></span></div>", "#m"),
		];
		for (const el of cases) {
			expect(ownsEnterKey(el)).toBe(true);
			expect(isTextEntryTarget(el)).toBe(true);
		}
	});

	it("counts a plain input only in the wider set - the URL bar still sends", () => {
		const input = mount("<input id='i' />", "#i");
		expect(ownsEnterKey(input)).toBe(false);
		expect(isTextEntryTarget(input)).toBe(true);
	});

	it("counts an ordinary element in neither", () => {
		const div = mount("<div id='d'></div>", "#d");
		expect(ownsEnterKey(div)).toBe(false);
		expect(isTextEntryTarget(div)).toBe(false);
	});
});
