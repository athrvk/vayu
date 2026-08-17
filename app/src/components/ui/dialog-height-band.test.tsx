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
 * A dialog taller than the viewport scrolls its body, not its panel (issue #773).
 *
 * `DialogContent` is `fixed` and centred by a translate, and it declared no
 * height cap - so a panel taller than the viewport was centred on a box it did
 * not fit and clipped at *both* ends, with nothing to scroll because a fixed
 * box does not scroll the page. Measured in Chromium at a 613px viewport, an
 * eighteen-row settings dialog put its Run button 198px below the screen:
 * reachable by Tab, unreachable by pointer, which is how it survived.
 *
 * The fix has two halves and this file guards both, because either alone is
 * still broken:
 *
 * 1. the panel caps its height, and
 * 2. a `DialogBody` band takes the scroll - so the header and footer stay put
 *    and the corner close button, positioned against the *panel*, does not
 *    scroll away with the content. Putting the scroll on the panel instead is
 *    the tempting one-liner, and it is what loses the close button.
 *
 * jsdom reports 0 for every measurement, so what is asserted is the declaration
 * on the element that carries it, per the rule in app/CLAUDE.md. The behaviour
 * itself was measured in Chromium: with the band, the footer sits at 542px of a
 * 613px viewport and the close button stays at y=63 however far the body is
 * scrolled; without it, the footer is at 1001px.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogBody,
	DialogFooter,
	DialogTitle,
	DialogDescription,
} from "./dialog";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function renderTallDialog() {
	render(
		<Dialog open>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Run a load test</DialogTitle>
					<DialogDescription>Pick a profile, then start the run.</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{Array.from({ length: 18 }, (_, i) => (
						<p key={i}>Row {i}</p>
					))}
				</DialogBody>
				<DialogFooter>
					<button>Run</button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
	const panel = document.querySelector('[data-slot="dialog-content"]');
	const body = document.querySelector('[data-slot="dialog-body"]');
	expect(panel).toBeTruthy();
	expect(body).toBeTruthy();
	return { panel: panel as HTMLElement, body: body as HTMLElement };
}

describe("the dialog height cap", () => {
	it("caps the panel, so it can never be centred on a box it does not fit", () => {
		const { panel } = renderTallDialog();
		expect(panel.className).toContain("max-h-[85vh]");
	});

	it("puts the scroll on the body band and not on the panel", () => {
		const { body } = renderTallDialog();

		// The panel keeps an `overflow-y-auto` of its own as the fallback for a
		// dialog with no band, but the band is what scrolls when there is one -
		// and only the band can, because only the band gives up height.
		expect(body.className).toContain("overflow-y-auto");
		// `flex-auto` (basis auto), not `flex-1` (basis 0%): a short dialog must
		// not stretch its one band over the whole cap.
		expect(body.className).toContain("flex-auto");
		// The vertical `min-w-0`: a flex item's automatic minimum on the main
		// axis is its content, so without this the band refuses to shrink and
		// the overflow moves straight back out to the panel.
		expect(body.className).toContain("min-h-0");
	});

	it("keeps the close button out of the band that scrolls", () => {
		const { panel, body } = renderTallDialog();

		// The whole reason the scroll is not simply on the panel: the close
		// button is `absolute` inside it, so a scrolling panel takes the visible
		// way out with it exactly when the dialog is long enough to need one.
		const close = screen.getByRole("button", { name: /close/i });
		expect(panel.contains(close)).toBe(true);
		expect(body.contains(close)).toBe(false);
	});

	it("keeps the header and footer fixed bands", () => {
		renderTallDialog();
		// Without `shrink-0` the two bands are what give up height first, which
		// squashes the title rather than scrolling the content.
		expect(document.querySelector('[data-slot="dialog-header"]')?.className).toContain(
			"shrink-0"
		);
		expect(document.querySelector('[data-slot="dialog-footer"]')?.className).toContain(
			"shrink-0"
		);
	});
});

/**
 * The rendered half above proves the primitive is right; this proves the
 * dialogs use it. A source scan is the weaker kind of guard, so it is scoped to
 * what only a scan can see - every call site at once - and it asserts it read
 * something, per the rule in the repo CLAUDE.md.
 */
describe("the dialogs that can grow", () => {
	/** Call sites that own their height deliberately, with the reason. */
	const OPT_OUTS = new Map([
		// Bands of its own (header, tab strip, body, footer), each with a
		// divider, and the scroll already on the one that needs it.
		["modules/collections/ImportModal.tsx", "manages its own bands"],
		// A palette is its input plus `CommandList`, which caps and scrolls
		// itself one level in.
		["components/ui/command.tsx", "cmdk owns the list scroll"],
		// Header and footer only - there is no middle to scroll.
		["components/ui/delete-confirm-dialog.tsx", "no body"],
	]);

	function tsxFiles(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) return tsxFiles(full);
			return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
				? [full]
				: [];
		});
	}

	const files = tsxFiles(srcRoot).filter((f) =>
		readFileSync(f, "utf8").includes("<DialogContent")
	);

	it("read a real set of call sites", () => {
		// The failure this exists to prevent: a scan whose match stopped working
		// passes forever while reading nothing. Thirteen call sites today.
		expect(files.length).toBeGreaterThanOrEqual(8);
	});

	it("gives every dialog a scrolling band, or an opt-out with a reason", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const relative = file
				.slice(srcRoot.length + 1)
				.split("\\")
				.join("/");
			if (OPT_OUTS.has(relative)) continue;
			if (!readFileSync(file, "utf8").includes("<DialogBody")) offenders.push(relative);
		}
		// A new dialog with no band is not a style slip: it is the #773 bug
		// arriving again, silently, on whichever laptop is not maximised.
		expect(offenders).toEqual([]);
	});

	it("does not leave an ad-hoc panel height cap behind", () => {
		// Two call sites carried their own `max-h-[…]` on the panel, at two
		// different numbers, because the primitive had none. Only a dialog that
		// declares itself an opt-out above may keep one.
		const offenders: string[] = [];
		for (const file of files) {
			const relative = file
				.slice(srcRoot.length + 1)
				.split("\\")
				.join("/");
			if (OPT_OUTS.has(relative)) continue;
			for (const tag of readFileSync(file, "utf8").matchAll(/<DialogContent\b[\s\S]*?>/g)) {
				// Comments inside the opening tag first: prose naming a class is
				// not a class.
				if (/max-h-\[/.test(tag[0].replace(/\/\/[^\n]*/g, ""))) offenders.push(relative);
			}
		}
		expect(offenders).toEqual([]);
	});
});
