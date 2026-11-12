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
 * The tip under "Vayu's engine didn't respond" points at the Dock's button only
 * while the Dock draws one (#3493). The Dock offers Restart after a crash and
 * Retry after a start failure; with neither recorded there is no button, and a
 * tip naming one would send the reader looking for it.
 *
 * Mutation check: make the tip unconditional (drop `restartOffered` from
 * `errorHint`) and the no-button case fails; return `ENGINE_NO_ANSWER`
 * unconditionally and the two button cases fail.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useEngineStore, type EngineCrash } from "@/stores";
import { ENGINE_NO_ANSWER } from "@/lib/engine-error-text";
import ClientErrorView from "./ClientErrorView";

const CRASH: EngineCrash = { code: 1, signal: null, stderrTail: [], error: null };

const BUTTON_TIP = /Start it again with the button in the status bar at the bottom of the window/;

beforeEach(() => {
	useEngineStore.setState({ engineCrash: null, engineStartFailure: null });
});

afterEach(cleanup);

describe("ClientErrorView tip for ENGINE_ERROR", () => {
	it("points at the Dock's button after a crash", () => {
		useEngineStore.setState({ engineCrash: CRASH });
		render(<ClientErrorView errorCode="ENGINE_ERROR" errorMessage="detail" />);

		expect(screen.getByText(BUTTON_TIP)).toBeInTheDocument();
		expect(screen.queryByText(new RegExp(ENGINE_NO_ANSWER))).not.toBeInTheDocument();
	});

	it("points at the Dock's button after a start failure", () => {
		useEngineStore.setState({ engineStartFailure: "Every engine port is in use." });
		render(<ClientErrorView errorCode="ENGINE_ERROR" errorMessage="detail" />);

		expect(screen.getByText(BUTTON_TIP)).toBeInTheDocument();
	});

	it("names no button while the Dock shows none", () => {
		render(<ClientErrorView errorCode="ENGINE_ERROR" errorMessage="detail" />);

		expect(screen.getByText(new RegExp(ENGINE_NO_ANSWER))).toBeInTheDocument();
		expect(screen.queryByText(BUTTON_TIP)).not.toBeInTheDocument();
	});

	it("leaves another code's tip alone while the Dock shows a button", () => {
		useEngineStore.setState({ engineCrash: CRASH });
		render(<ClientErrorView errorCode="CONNECTION_FAILED" errorMessage="detail" />);

		expect(screen.getByText(/Nothing answered at that address/)).toBeInTheDocument();
		expect(screen.queryByText(BUTTON_TIP)).not.toBeInTheDocument();
	});
});
