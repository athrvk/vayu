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
 * The progress bar primitive (issue #882).
 *
 * Two states, and the difference between them is the whole point: a bar drawn
 * from a real total, and a bar for work whose total nobody stated. The second is
 * not a bar at 0% - it announces itself as busy rather than as "none of the way
 * through", because a screen reader reading "0 percent" for a download that is
 * actually half done is worse than saying nothing about the fraction.
 *
 * The class-list assertions are deliberate: a source scan cannot see a class
 * that arrives in a variable, and both of these do.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Progress } from "./progress";

describe("Progress", () => {
	it("reports the fraction it was given", () => {
		render(<Progress value={0.42} label="Fetching document" />);

		const bar = screen.getByRole("progressbar", { name: "Fetching document" });
		expect(bar).toHaveAttribute("aria-valuenow", "42");
		expect(bar).toHaveAttribute("aria-valuemin", "0");
		expect(bar).toHaveAttribute("aria-valuemax", "100");
		expect(bar.firstElementChild).toHaveStyle({ width: "42%" });
	});

	it("clamps a fraction outside 0..1", () => {
		// An upstream that under-declares its `Content-Length` hands us more bytes
		// than it said it would, and a bar wider than its own track is a rendering
		// bug rather than an honest report.
		render(<Progress value={1.4} label="Fetching document" />);

		const bar = screen.getByRole("progressbar");
		expect(bar).toHaveAttribute("aria-valuenow", "100");
		expect(bar.firstElementChild).toHaveStyle({ width: "100%" });
	});

	it("announces itself as busy when there is no total to be a fraction of", () => {
		render(<Progress value={null} label="Fetching document" />);

		const bar = screen.getByRole("progressbar");
		expect(bar).toHaveAttribute("aria-busy", "true");
		// Not "0 percent": nothing is known about the fraction, and a number here
		// would be a number the engine never stated.
		expect(bar).not.toHaveAttribute("aria-valuenow");
	});

	it("carries the indeterminate animation only in that state", () => {
		const { container: busy } = render(<Progress value={null} label="Busy" />);
		const { container: known } = render(<Progress value={0.5} label="Known" />);

		expect(busy.querySelector(".progress-indeterminate")).not.toBeNull();
		expect(known.querySelector(".progress-indeterminate")).toBeNull();
	});

	it("has the animation the indeterminate state asks for", () => {
		// A class name with no rule behind it renders a motionless block that
		// looks like a stalled download. Read from disk because vitest stubs CSS
		// imports to an empty string, which would make this assertion vacuous.
		const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

		expect(css).toContain("@keyframes progress-indeterminate");
		expect(css).toMatch(/\.progress-indeterminate\s*\{[^}]*animation:/);
	});

	it("follows the roundedness setting's fixed-pill exemption, not a bare radius", () => {
		const { container } = render(<Progress value={0.5} label="Known" />);
		const track = container.firstElementChild as HTMLElement;

		// A track is a pill at every roundedness setting, which `rounded-full`
		// says and a bare `rounded` (4px, frozen) does not.
		expect(track.className).toContain("rounded-full");
		expect(track.className.split(" ")).not.toContain("rounded");
	});
});
