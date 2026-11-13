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
 * The icon form of Copy for agent names itself on keyboard focus (#3498): the
 * app's Tooltip opens there, where the native `title` it replaced never did.
 */

import { describe, it, expect } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { CopyForAgentButton } from "./CopyForAgentButton";

describe("CopyForAgentButton", () => {
	it("keeps the row-specific name and opens a generic tooltip on focus", async () => {
		render(<CopyForAgentButton reference="ref" label="Copy p95 latency for agent" />);
		const button = screen.getByRole("button", { name: "Copy p95 latency for agent" });
		expect(button).not.toHaveAttribute("title");

		await act(async () => {
			fireEvent.focus(button);
		});

		expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy for agent");
	});
});
