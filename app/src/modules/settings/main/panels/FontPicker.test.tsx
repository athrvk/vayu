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
 * The font tiles are one radio group, the "Custom…" tile included: the chosen
 * face is announced as checked rather than shown by colour and a glyph alone.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { UI_FONTS } from "@/constants/appearance";
import { FontPicker } from "./FontPicker";

beforeEach(cleanup);

function renderPicker(value: string, onChange = vi.fn()) {
	render(
		<FontPicker
			label="Interface font"
			options={UI_FONTS}
			value={value}
			onChange={onChange}
			customValue=""
			onCustomChange={vi.fn()}
			sample="Sample"
			customStack={(family) => family || "sans-serif"}
			placeholder="Font family"
		/>
	);
	return onChange;
}

describe("FontPicker", () => {
	it("exposes the chosen face as the one checked radio", () => {
		renderPicker("inter");

		expect(screen.getByRole("radio", { name: /^Inter/, checked: true })).toBeTruthy();
		expect(screen.getByRole("radio", { name: /^System/, checked: false })).toBeTruthy();
		expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
	});

	it("names the radiogroup by the setting the font is for", () => {
		renderPicker("inter");

		const group = screen.getByRole("radiogroup", { name: "Interface font" });
		expect(within(group).getAllByRole("radio")).toHaveLength(UI_FONTS.length + 1);
	});

	it("puts the Custom tile in the same group", () => {
		const onChange = renderPicker("inter");
		expect(screen.getAllByRole("radio")).toHaveLength(UI_FONTS.length + 1);

		fireEvent.click(screen.getByRole("radio", { name: /^Custom/ }));

		expect(onChange).toHaveBeenCalledWith("custom");
	});

	it("reports Custom as checked when it is the stored value", () => {
		renderPicker("custom");

		expect(screen.getByRole("radio", { name: /^Custom/, checked: true })).toBeTruthy();
	});

	it("names the custom family field after the setting it belongs to", () => {
		renderPicker("custom");

		expect(screen.getByRole("textbox", { name: "Interface font family" })).toBeTruthy();
	});

	it("shows no family field while a preset is chosen", () => {
		renderPicker("inter");

		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("chooses the next face when an arrow key moves focus to it", async () => {
		const onChange = renderPicker("inter");
		const inter = screen.getByRole("radio", { name: /^Inter/ });
		inter.focus();

		fireEvent.keyDown(inter, { key: "ArrowRight" });

		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("radio", { name: /^System/ }))
		);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("system");
	});

	it("does not clear the choice when the chosen tile is pressed again", () => {
		const onChange = renderPicker("inter");

		fireEvent.click(screen.getByRole("radio", { name: /^Inter/ }));

		expect(onChange).not.toHaveBeenCalled();
	});
});
