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
 * The surface half of the `--rule` contract, for the Import dialog (#69).
 *
 * This dialog is the exception among dialogs: it overrides `DialogContent` to
 * be a card and draws four internal dividers on it. In dark, `--border` and
 * `--card` are the same colour (1.003), so every one of those dividers was
 * invisible - the drop zone's dashed edge included, and that edge *is* the
 * "drop a file here" affordance.
 *
 * As in `surface-rule.test.tsx`, the guard pins the *declarations*, not the
 * `border-rule` classes: a `border-rule` under no declared surface silently
 * falls back to the `:root` default, which on a card is the original bug. The
 * resolved colour is a computed-style question jsdom cannot answer; it is
 * checked in the browser.
 *
 * One extra wrinkle here: `surface-card` alone cannot replace `bg-card` on a
 * `DialogContent`. The surface class lives in `@layer components`, the
 * primitive's `bg-background` is a utility and outranks it, and tailwind-merge
 * does not recognise `surface-card` as a background class so it would leave
 * `bg-background` standing. The pair is load-bearing, so both halves are
 * asserted.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";

const postman = readFileSync(
	join(__dirname, "../../services/importers/__fixtures__/postman-v21.json"),
	"utf8"
);

function renderModal() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<ImportModal />
		</QueryClientProvider>
	);
}

/** See ImportModal.test.tsx - Radix tabs activate on mousedown, not bare click. */
function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

async function openPreview() {
	selectTab(/Paste JSON/i);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: postman } });
	fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
	await waitFor(() => expect(screen.getByText(/Postman Collection v2.1/i)).toBeInTheDocument());
}

/** Exact class tokens, safe for SVG nodes whose className is not a string. */
function tokens(el: Element): string[] {
	return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function dialog(): HTMLElement {
	return screen.getByRole("dialog");
}

/**
 * `border-border` is the token that is invisible on a card in dark - the exact
 * defect of #69. An exact-token scan, so `border-border-strong` (the dialog's
 * own outline, facing the overlay, deliberately kept) does not match.
 */
function invisibleDividers(root: HTMLElement): string[] {
	return [root, ...Array.from(root.querySelectorAll("*"))]
		.filter((el) => tokens(el).includes("border-border"))
		.map((el) => el.getAttribute("class") ?? "");
}

describe("the import dialog declares its surfaces", () => {
	beforeEach(() => useImportModalStore.setState({ isOpen: true }));

	it("pairs bg-card with surface-card on the panel - both halves load-bearing", () => {
		renderModal();
		const cls = tokens(dialog());
		// surface-card declares the --rule the header/tabs/footer dividers use.
		expect(cls).toContain("surface-card");
		// bg-card is what strips the primitive's bg-background via tailwind-merge;
		// without it the utility outranks the component-layer surface class and
		// the dialog renders on the canvas colour.
		expect(cls).toContain("bg-card");
	});

	it("draws no divider with border-border, the token invisible on a card in dark", () => {
		renderModal();
		expect(invisibleDividers(dialog())).toEqual([]);
	});

	it("puts the drop zone's dashed affordance on a declared sunken surface", () => {
		renderModal();
		const zone = screen.getByText(/Drop a file here/i).closest("button")!;
		const cls = tokens(zone);
		// On --accent, --border-strong is the faintest edge in dark (1.108, below
		// plain --border); surface-sunken's rule is the strongest in both themes.
		expect(cls).toContain("surface-sunken");
		expect(cls).not.toContain("bg-accent");
		expect(cls).not.toContain("border-border-strong");
	});

	it("leaves no bare bg-accent behind, which would declare nothing", async () => {
		renderModal();
		const scan = () =>
			Array.from(dialog().querySelectorAll("*")).filter((el) =>
				tokens(el).includes("bg-accent")
			);
		expect(scan()).toEqual([]);
		await openPreview();
		expect(scan()).toEqual([]);
	});

	it("allows a bare bg-card only where no descendant consumes a rule against it", () => {
		// The format chips keep a bare bg-card on purpose: their edge faces the
		// sunken drop zone, so their border-rule must inherit the zone's
		// declaration rather than declare a card rule of their own. That is safe
		// exactly as long as nothing *inside* them resolves a rule.
		renderModal();
		const offenders = Array.from(dialog().querySelectorAll("*"))
			.filter((el) => tokens(el).includes("bg-card") && !tokens(el).includes("surface-card"))
			.filter((el) =>
				Array.from(el.querySelectorAll("*")).some((child) =>
					tokens(child).includes("border-rule")
				)
			)
			.map((el) => el.getAttribute("class") ?? "");
		expect(offenders).toEqual([]);
	});

	it("declares the preview list as sunken and rules the footer, not border-borders it", async () => {
		renderModal();
		await openPreview();
		// The detected-collections slab is the same surface as the drop zone and
		// gets the same declaration.
		const slab = screen.getByText(/Acme API/).closest(".surface-sunken");
		expect(slab, "the preview tree should sit on a declared sunken surface").toBeTruthy();
		// The footer divider only mounts in the preview phase - re-run the
		// invisible-token scan with it on screen.
		expect(invisibleDividers(dialog())).toEqual([]);
	});
});
