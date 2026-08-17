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
 * "Number input + unit suffix + range hint + default line" existed four times
 * over - the engine entry cards, the dashboard SLO threshold, the load-test
 * ceilings and the MCP caps - with divergent markup *and* divergent behaviour.
 * They are one primitive now, so the behaviours that used to differ are pinned
 * here rather than four times over in the panels' own files.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NumberSettingRow } from "./SettingControls";

beforeEach(cleanup);

const field = (name = "Cache size") => screen.getByLabelText(name) as HTMLInputElement;

describe("NumberSettingRow", () => {
	it("puts the unit inside the input rather than in the label", () => {
		render(<NumberSettingRow label="Max duration" value="60" unit="sec" />);

		// The label is the name of the setting; the unit lives once, as the
		// input's suffix (the settings voice conventions).
		expect(screen.getByLabelText("Max duration")).toBeInTheDocument();
		expect(screen.queryByLabelText(/Max duration \(sec/)).toBeNull();
		expect(screen.getByText("sec")).toBeInTheDocument();
	});

	it("derives the range hint from min/max, and lets a caller override it", () => {
		const { rerender } = render(<NumberSettingRow label="A" value="5" min="1" max="10" />);
		expect(screen.getByText("1 - 10")).toBeInTheDocument();

		rerender(<NumberSettingRow label="A" value="5" min="1" max="10" rangeHint="1 KB - 4 MB" />);
		expect(screen.getByText("1 KB - 4 MB")).toBeInTheDocument();
	});

	it("carries aria-invalid and points at the reason only while there is one", () => {
		const { rerender } = render(<NumberSettingRow label="A" value="5" />);
		// Not aria-invalid="false" on every row on the screen.
		expect(field("A").getAttribute("aria-invalid")).toBeNull();

		rerender(<NumberSettingRow label="A" value="0" error="Must be at least 1" />);
		expect(field("A")).toHaveAttribute("aria-invalid", "true");
		const describedBy = field("A").getAttribute("aria-describedby");
		expect(describedBy).not.toBeNull();
		expect(document.getElementById(describedBy as string)?.textContent).toBe(
			"Must be at least 1"
		);
	});

	it("points the field at its description, and at both when there is an error too", () => {
		// The description is why the field is what it is ("Only applies while
		// Follow redirects is on"), so it belongs to the field rather than
		// sitting near it - a reader that jumps control to control would
		// otherwise never hear it.
		const { rerender } = render(
			<NumberSettingRow label="A" value="5" description="Hops to follow before giving up." />
		);
		const described = () => (field("A").getAttribute("aria-describedby") ?? "").split(" ");
		const textOf = (ids: string[]) => ids.map((id) => document.getElementById(id)?.textContent);

		expect(textOf(described())).toEqual(["Hops to follow before giving up."]);

		rerender(
			<NumberSettingRow
				label="A"
				value="5"
				description="Hops to follow before giving up."
				error="Must be at least 1"
			/>
		);
		expect(textOf(described())).toEqual([
			"Must be at least 1",
			"Hops to follow before giving up.",
		]);
	});

	it("carries no aria-describedby when there is nothing to describe", () => {
		render(<NumberSettingRow label="A" value="5" />);
		expect(field("A").getAttribute("aria-describedby")).toBeNull();
	});

	describe("commit strategies", () => {
		it("commit=change reports every parseable keystroke", () => {
			const onCommit = vi.fn();
			render(<NumberSettingRow label="A" value="5" commit="change" onCommit={onCommit} />);

			fireEvent.change(field("A"), { target: { value: "50" } });
			expect(onCommit).toHaveBeenCalledWith("50");
		});

		it("commit=blur holds the value until the field is left", () => {
			const onCommit = vi.fn();
			render(<NumberSettingRow label="A" value="5" commit="blur" onCommit={onCommit} />);

			fireEvent.change(field("A"), { target: { value: "50" } });
			expect(onCommit).not.toHaveBeenCalled();

			fireEvent.blur(field("A"));
			expect(onCommit).toHaveBeenCalledWith("50");
		});

		it("never commits an unparseable draft, under either strategy", () => {
			/*
			 * The load-test panel used to send the NaN on to its store, which
			 * clamped it to the floor - so clearing a field to retype it yanked
			 * the ceiling to 1 mid-edit.
			 */
			const onChangeCommit = vi.fn();
			const { unmount } = render(
				<NumberSettingRow label="A" value="5" commit="change" onCommit={onChangeCommit} />
			);
			fireEvent.change(field("A"), { target: { value: "" } });
			expect(field("A").value).toBe("");
			expect(onChangeCommit).not.toHaveBeenCalled();
			unmount();

			const onBlurCommit = vi.fn();
			render(<NumberSettingRow label="B" value="5" commit="blur" onCommit={onBlurCommit} />);
			fireEvent.change(field("B"), { target: { value: "" } });
			fireEvent.blur(field("B"));
			expect(onBlurCommit).not.toHaveBeenCalled();
		});

		it("reports every keystroke to a staging owner, valid or not", () => {
			// The engine view stages edits and validates them itself; it needs
			// the invalid ones too, to disable Save and show why.
			const onDraftChange = vi.fn();
			render(<NumberSettingRow label="A" value="5" onDraftChange={onDraftChange} />);

			fireEvent.change(field("A"), { target: { value: "" } });
			expect(onDraftChange).toHaveBeenCalledWith("");
		});

		it("falls back to the committed value once the field is left", () => {
			// What lets a clamped or rejected value snap back instead of leaving
			// the input showing a number nothing stored.
			render(<NumberSettingRow label="A" value="5" commit="blur" />);
			fireEvent.change(field("A"), { target: { value: "9999" } });
			fireEvent.blur(field("A"));
			expect(field("A").value).toBe("5");
		});
	});

	describe("the Default line", () => {
		it("appears only when the value is off the default, and resets it", () => {
			const onResetToDefault = vi.fn();
			const { rerender } = render(
				<NumberSettingRow
					label="A"
					value="200"
					defaultValue="200"
					onResetToDefault={onResetToDefault}
				/>
			);
			expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();

			rerender(
				<NumberSettingRow
					label="A"
					value="500"
					defaultValue="200"
					onResetToDefault={onResetToDefault}
				/>
			);
			expect(screen.getByText("Default: 200")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Reset" }));
			expect(onResetToDefault).toHaveBeenCalled();
		});

		it("prints the default the way the setting reads, not the way it is stored", () => {
			// A byte count is a default like "1 MB"; the comparison still runs on
			// the raw value, or the line would never turn off.
			render(
				<NumberSettingRow
					label="A"
					value="2097152"
					defaultValue="1048576"
					defaultDisplay="1 MB"
				/>
			);
			expect(screen.getByText("Default: 1 MB")).toBeInTheDocument();
		});
	});
});
