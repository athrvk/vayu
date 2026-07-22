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
 * The surface half of the `--rule` contract.
 *
 * A divider is visible or not depending on what it sits *on*. That knowledge
 * used to live in a doc, so every author re-derived it and the same defect was
 * fixed one component at a time about ten times on this branch. It now lives in
 * `index.css`: a surface class declares both its background and the `--rule`
 * that reads on it, and a divider says `border-rule` and inherits the answer.
 *
 * This does not make the mistake impossible - it relocates it. A `border-rule`
 * whose ancestors declare no surface falls back to the `:root` default,
 * `--border`, which on a card is the original 1.003 bug, silently.
 *
 * So the contract has two halves and only one of them is checkable here:
 *
 *   - **Roots declare.** Enumerable, and asserted below. If a surface root
 *     loses its `surface-*` class, every divider inside it silently reverts.
 *   - **Leaves consume.** Asserted by the components' own tests; that they
 *     resolve to the right *colour* is a computed-style question, which jsdom
 *     cannot answer (it loads no stylesheet). That half is verified in the
 *     browser against the running app.
 *
 * Asserting `border-rule` is present is deliberately NOT the guard: it passes
 * while the bug is live if the surface declaration is missing. The declaration
 * is the load-bearing half, so it is the one pinned here.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import ResponseViewer from "@/modules/request-builder/components/ResponseViewer";
import { CompactHeadersViewer } from "./HeadersViewer";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

/** Mutable so each test can choose which of the pane's branches renders. */
const state = { status: 200 };

vi.mock("@/modules/request-builder/context", () => ({
	useRequestBuilderContext: () => ({
		isExecuting: false,
		response: {
			status: state.status,
			statusText: state.status === 0 ? "Error" : "OK",
			time: 12,
			size: 11,
			body: '{"ok":true}',
			bodyRaw: '{"ok":true}',
			bodyType: "json",
			headers: { "content-type": "application/json" },
			requestHeaders: { "user-agent": "Vayu/0.9.0" },
			errorCode: "CONNECTION_FAILED",
		},
	}),
}));

/** The outermost element the pane renders, for a given response status. */
function paneRoot(status: number): HTMLElement {
	state.status = status;
	const { container } = render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
	return container.firstElementChild as HTMLElement;
}

describe("the response pane declares its surface", () => {
	it("is a surface-card, so every divider inside it resolves against a card", () => {
		expect(paneRoot(200).className).toMatch(/\bsurface-card\b/);
	});

	it("declares it on the client-error branch too", () => {
		// A separate early return with its own root. It carried the same
		// `bg-card`, and without the declaration the status bar's rule reverts to
		// `--border` - invisible on a card in dark, the bug this replaces.
		expect(paneRoot(0).className).toMatch(/\bsurface-card\b/);
	});

	it("does not leave a bare bg-card behind, which would declare nothing", () => {
		const root = paneRoot(200);
		const bare = Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
			(el) => /\bbg-card\b/.test(el.className) && !/\bsurface-card\b/.test(el.className)
		);
		expect(bare.map((el) => el.className)).toEqual([]);
	});
});

describe("a sunken slab declares its own", () => {
	it("re-declares --rule, so rows inside it do not inherit the card's", () => {
		// `--muted` is the one surface where no border token works in both themes,
		// so the slab has to override rather than inherit.
		const { container } = render(<CompactHeadersViewer headers={{ accept: "*/*" }} />);
		const slab = container.querySelector<HTMLElement>(".surface-sunken");

		expect(slab, "the compact list should sit on a declared sunken surface").toBeTruthy();
		expect(slab!.className).not.toMatch(/\bbg-muted\b/);
	});

	it("still rules its rows", () => {
		const { container } = render(
			<CompactHeadersViewer headers={{ accept: "*/*", "x-trace": "1" }} />
		);
		const ruled = Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
			/\bborder-rule\b/.test(el.className)
		);
		expect(ruled.length).toBeGreaterThanOrEqual(2);
	});
});
