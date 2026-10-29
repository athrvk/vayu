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
 * What the toggle and pick-one rows promise their callers.
 *
 * `NumberSettingRow` has its own file; these two had none, and the request
 * Settings tab adopting them (issue #702) is what made the gap matter: the
 * markup it gave up wired `htmlFor`/`id` between the label and the switch, and
 * a primitive that drops that would have moved the regression into every panel
 * at once instead of one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { CollapsibleText, OptionButtons, SelectSettingRow, ToggleRow } from "./SettingControls";

beforeEach(cleanup);

describe("ToggleRow", () => {
	it("lets the visible label work the switch", () => {
		// A Radix Switch is a <button> - labelable, so the association is real
		// and the words beside it are part of the hit area rather than decoration.
		const onChange = vi.fn();
		render(<ToggleRow label="Follow redirects" checked={false} onChange={onChange} />);

		fireEvent.click(screen.getByText("Follow redirects"));

		expect(onChange).toHaveBeenCalledWith(true);
	});

	it("still names the switch when the label is a node with no text of its own", () => {
		render(
			<ToggleRow
				label={<span>{2} tools</span>}
				ariaLabel="Tool group"
				checked
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByRole("switch", { name: "Tool group" })).toBeTruthy();
	});
});

describe("SelectSettingRow", () => {
	const OPTIONS = [
		{ value: "auto", label: "Auto" },
		{ value: "http2", label: "HTTP/2" },
	] as const;

	it("names the trigger by the row, not by the chosen option", () => {
		// The trigger's text is the *value* ("Auto"), so without the row's own
		// name a screen reader hears the answer and never the question.
		render(
			<SelectSettingRow label="Protocol" value="auto" onChange={vi.fn()} options={OPTIONS} />
		);

		const trigger = screen.getByRole("combobox", { name: "Protocol" });
		expect(trigger).toHaveTextContent("Auto");
	});

	it("reports the chosen option's value", () => {
		const onChange = vi.fn();
		render(
			<SelectSettingRow label="Protocol" value="auto" onChange={onChange} options={OPTIONS} />
		);

		fireEvent.click(screen.getByRole("combobox", { name: "Protocol" }));
		fireEvent.click(screen.getByRole("option", { name: "HTTP/2" }));

		expect(onChange).toHaveBeenCalledWith("http2");
	});

	it("keeps naming the trigger when the label is hidden", () => {
		// `labelHidden` is for a host that already prints the setting's name (the
		// engine cards' CardTitle). The label has to survive in the DOM anyway -
		// it is what names the trigger - so it goes `sr-only` rather than away.
		render(
			<SelectSettingRow
				label="Data Safety Mode"
				labelHidden
				value="auto"
				onChange={vi.fn()}
				options={OPTIONS}
			/>
		);

		expect(screen.getByRole("combobox", { name: "Data Safety Mode" })).toBeTruthy();
		expect(screen.getByText("Data Safety Mode").className).toContain("sr-only");
	});

	it("points the trigger at its description", () => {
		render(
			<SelectSettingRow
				label="Protocol"
				value="auto"
				onChange={vi.fn()}
				options={OPTIONS}
				description="The HTTP protocol to negotiate."
			/>
		);

		const describedBy = screen
			.getByRole("combobox", { name: "Protocol" })
			.getAttribute("aria-describedby");
		expect(describedBy).not.toBeNull();
		expect(document.getElementById(describedBy as string)?.textContent).toBe(
			"The HTTP protocol to negotiate."
		);
	});

	it("marks the trigger invalid and points it at the message and the description", () => {
		render(
			<SelectSettingRow
				label="Protocol"
				value="auto"
				onChange={vi.fn()}
				options={OPTIONS}
				description="The HTTP protocol to negotiate."
				error="Can't be empty"
			/>
		);

		const trigger = screen.getByRole("combobox", { name: "Protocol" });
		expect(trigger).toHaveAttribute("aria-invalid", "true");
		expect(trigger.className).toContain("border-destructive");
		const [errorId, descriptionId] = (trigger.getAttribute("aria-describedby") ?? "").split(
			" "
		);
		expect(document.getElementById(errorId)?.textContent).toBe("Can't be empty");
		expect(document.getElementById(descriptionId)?.textContent).toBe(
			"The HTTP protocol to negotiate."
		);
	});

	it("carries no invalid state without a message", () => {
		render(
			<SelectSettingRow label="Protocol" value="auto" onChange={vi.fn()} options={OPTIONS} />
		);

		const trigger = screen.getByRole("combobox", { name: "Protocol" });
		expect(trigger).not.toHaveAttribute("aria-invalid");
		expect(trigger.className).not.toContain("border-destructive");
	});
});

describe("SelectSettingRow - the compact variant", () => {
	/*
	 * `compact` exists for the element card's schema-generated form, which
	 * shows several fields at once and pairs two short ones into a grid line.
	 * It is opt-in precisely because the settings panels must not move, so the
	 * default half is the case that matters here. Read off the rendered node
	 * rather than scanned: both class strings arrive through `cn()`.
	 */
	const ONE = [{ value: "body", label: "body" }] as const;

	it("keeps the trigger's fixed width by default", () => {
		render(<SelectSettingRow label="Field" value="body" onChange={vi.fn()} options={ONE} />);

		expect(screen.getByRole("combobox", { name: "Field" }).className).toContain(
			"max-w-[12rem]"
		);
	});

	it("lets a compact trigger fill whatever holds it", () => {
		render(
			<SelectSettingRow label="Field" value="body" onChange={vi.fn()} options={ONE} compact />
		);

		const trigger = screen.getByRole("combobox", { name: "Field" });
		expect(trigger.className).toContain("w-full");
		expect(trigger.className).not.toContain("max-w-[12rem]");
	});
});

describe("CollapsibleText", () => {
	const SHORT = "A short description.";
	// 151 characters - one past the default 150-character clamp.
	const LONG =
		"This description runs on well past a couple of lines, the way an engine setting's real copy does, so a reader scanning the page sees a wall of prose repeated dozens of times over.";

	it("renders a short description plainly, with no toggle", () => {
		render(<CollapsibleText text={SHORT} />);

		expect(screen.getByText(SHORT)).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("truncates a long description at a word boundary and offers Show more", () => {
		render(<CollapsibleText text={LONG} />);

		expect(screen.queryByText(LONG)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /show more/i })).toBeInTheDocument();
		// The truncated text is a prefix of the real copy, cut on a space rather
		// than mid-word - mutation check: swap `lastIndexOf(" ")` for a slice at
		// exactly `clampAt` and this reds on a word cut in half.
		const shown = screen.getByRole("button").parentElement!.textContent!;
		expect(LONG.startsWith(shown.replace(/…\s*Show more$/, ""))).toBe(true);
	});

	it("reveals the full text on Show more and collapses again on Show less", () => {
		render(<CollapsibleText text={LONG} />);

		fireEvent.click(screen.getByRole("button", { name: /show more/i }));
		expect(screen.getByText(LONG, { exact: false })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /show less/i })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /show less/i }));
		expect(screen.queryByText(LONG, { exact: false })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /show more/i })).toBeInTheDocument();
	});

	it("respects a custom clamp", () => {
		render(<CollapsibleText text={SHORT} clampAt={5} />);

		expect(screen.getByRole("button", { name: /show more/i })).toBeInTheDocument();
	});
});

describe("OptionButtons", () => {
	const THEMES = [
		{ value: "light", label: "Light" },
		{ value: "dark", label: "Dark" },
		{ value: "system", label: "System" },
	] as const;

	it("exposes the chosen tile as a checked radio and the rest as unchecked", () => {
		render(<OptionButtons label="Theme" options={THEMES} value="dark" onChange={vi.fn()} />);

		expect(screen.getByRole("radio", { name: "Dark", checked: true })).toBeTruthy();
		expect(screen.getByRole("radio", { name: "Light", checked: false })).toBeTruthy();
	});

	it("names the radiogroup by the setting it picks", () => {
		render(<OptionButtons label="Theme" options={THEMES} value="dark" onChange={vi.fn()} />);

		const group = screen.getByRole("radiogroup", { name: "Theme" });
		expect(within(group).getAllByRole("radio")).toHaveLength(THEMES.length);
	});

	it("hides the check glyph from assistive tech", () => {
		const { container } = render(
			<OptionButtons label="Theme" options={THEMES} value="dark" onChange={vi.fn()} />
		);

		const glyph = container.querySelector("svg");
		expect(glyph?.getAttribute("aria-hidden")).toBe("true");
	});

	it("chooses the next tile when an arrow key moves focus to it", async () => {
		// WAI-ARIA radio pattern (issue #1865): selection follows focus, so an
		// arrow press is a choice with no Enter or Space after it.
		const onChange = vi.fn();
		render(<OptionButtons label="Theme" options={THEMES} value="dark" onChange={onChange} />);
		const dark = screen.getByRole("radio", { name: "Dark" });
		dark.focus();

		fireEvent.keyDown(dark, { key: "ArrowRight" });

		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("radio", { name: "System" }))
		);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("system");
	});

	it("chooses nothing when Tab lands on the already chosen tile", () => {
		const onChange = vi.fn();
		render(<OptionButtons label="Theme" options={THEMES} value="dark" onChange={onChange} />);
		const group = screen.getByRole("radiogroup", { name: "Theme" });

		// A Tab keydown on the control before the group, then focus entering it.
		fireEvent.keyDown(group, { key: "Tab" });
		screen.getByRole("radio", { name: "Dark" }).focus();

		expect(onChange).not.toHaveBeenCalled();
	});

	it("chooses a clicked tile once, not once for its focus and again for its press", () => {
		const onChange = vi.fn();
		render(<OptionButtons label="Theme" options={THEMES} value="dark" onChange={onChange} />);
		const light = screen.getByRole("radio", { name: "Light" });

		// A key press earlier leaves the group in keyboard mode; the pointer
		// press that follows must take it back out before the click's focus.
		fireEvent.keyDown(screen.getByRole("radio", { name: "Dark" }), { key: "ArrowLeft" });
		fireEvent.pointerDown(light);
		light.focus();
		fireEvent.click(light);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("light");
	});

	it("does not clear the choice when the chosen tile is pressed again", () => {
		const onChange = vi.fn();
		render(<OptionButtons label="Theme" options={THEMES} value="dark" onChange={onChange} />);

		fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

		expect(onChange).not.toHaveBeenCalled();
	});

	it("hands numeric option values back as numbers", () => {
		const SIZES = [
			{ value: 1, label: "Small" },
			{ value: 2, label: "Medium" },
			{ value: 3, label: "Large" },
		] as const;
		const onChange = vi.fn();
		render(<OptionButtons label="Size" options={SIZES} value={2} onChange={onChange} />);

		expect(screen.getByRole("radio", { name: "Medium", checked: true })).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: "Large" }));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(3);
	});
});
