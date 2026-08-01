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
 * A disconnected engine has to say why.
 *
 * `queries/health.ts` writes `engineError` on every failed poll - ECONNREFUSED,
 * a timeout, a TLS failure - and nothing in the app read the field. The two
 * connection surfaces render `isEngineConnected` alone, so all three causes
 * printed the same word and the difference was only visible in devtools. That
 * is the write-only defect class CLAUDE.md calls this codebase's most repeated.
 *
 * Rendered, not source-scanned: the reason arrives through a store binding, and
 * a scan cannot see a value that is not a literal in the file (the badge-hover
 * guard missed both real instances for exactly that reason).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { Dock } from "./Dock";
import { useEngineStore } from "@/stores";

// The Dock prints the app version, which Vite `define`s at build time; vitest
// does not, so without this the component throws before it renders anything.
vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

const renderDock = () =>
	render(
		<TooltipProvider>
			<Dock />
		</TooltipProvider>
	);

beforeEach(() => {
	cleanup();
	useEngineStore.setState({ isEngineConnected: false, engineError: null });
});

describe("the engine status indicator", () => {
	it("says Disconnected with no affordance when no reason was recorded", () => {
		renderDock();
		expect(screen.getByText("Disconnected")).toBeTruthy();
		// Nothing to hover for, so nothing pretends there is.
		expect(document.querySelector("[tabindex='0'] .lucide-info")).toBeNull();
	});

	it("carries the health-poll error, reachable by keyboard", async () => {
		useEngineStore.setState({
			isEngineConnected: false,
			engineError: "fetch failed: ECONNREFUSED 127.0.0.1:9876",
		});
		renderDock();

		const trigger = screen.getByText("Disconnected").closest("[tabindex='0']");
		expect(trigger).toBeTruthy();

		fireEvent.focus(trigger!);
		// Radix renders the content twice - the visible bubble and a
		// visually-hidden copy carrying `role="tooltip"` for screen readers - so
		// this counts "at least one", not "exactly one".
		await waitFor(() => {
			expect(
				screen.getAllByText("fetch failed: ECONNREFUSED 127.0.0.1:9876").length
			).toBeGreaterThan(0);
		});
	});

	it("does not truncate the reason the transport produced", async () => {
		// The full text is what identifies the failure - a port, a path, a TLS
		// error. The tooltip wraps; nothing here clips it to a fixed length.
		const long =
			"request to http://127.0.0.1:9876/health failed, reason: connect ETIMEDOUT after 5000ms";
		useEngineStore.setState({ isEngineConnected: false, engineError: long });
		renderDock();

		fireEvent.focus(screen.getByText("Disconnected").closest("[tabindex='0']")!);
		await waitFor(() => expect(screen.getAllByText(long).length).toBeGreaterThan(0));
	});

	it("keeps the connected state a plain label", () => {
		// A stale error must not follow the engine back up: `health.ts` clears it
		// on success, and the indicator only offers the tooltip while down.
		useEngineStore.setState({ isEngineConnected: true, engineError: null });
		renderDock();
		expect(screen.getByText("Connected")).toBeTruthy();
		expect(screen.getByText("Connected").closest("[tabindex='0']")).toBeNull();
	});
});
