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
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SelectSettingRow, ToggleRow } from "./SettingControls";

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

		expect(screen.getByRole("combobox", { name: "Field" }).className).toContain("w-48");
	});

	it("lets a compact trigger fill whatever holds it", () => {
		render(
			<SelectSettingRow label="Field" value="body" onChange={vi.fn()} options={ONE} compact />
		);

		const trigger = screen.getByRole("combobox", { name: "Field" });
		expect(trigger.className).toContain("w-full");
		expect(trigger.className).not.toContain("w-48");
	});
});
