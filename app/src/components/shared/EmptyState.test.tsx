/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
	it("renders the title, description and action as a pane", () => {
		render(
			<EmptyState
				icon={Inbox}
				title="No run selected"
				description="Pick a run from the sidebar to see its results."
				action={<button type="button">Add one</button>}
			/>
		);
		expect(screen.getByText("No run selected")).toBeInTheDocument();
		expect(screen.getByText(/Pick a run from the sidebar/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add one" })).toBeInTheDocument();
	});

	it("draws the icon without announcing it", () => {
		const { container } = render(<EmptyState icon={Inbox} title="No collections yet" />);
		// Decorative: the title already says what the icon says, so it must not
		// reach the accessibility tree as an image ahead of the message.
		expect(container.querySelector("svg")).not.toBeNull();
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("drops icon, description and action in the inline variant", () => {
		// The inline variant sits inside a small panel, so it is one muted line
		// and nothing else — passing the other props must not smuggle them in.
		const { container } = render(
			<EmptyState
				variant="inline"
				icon={Inbox}
				title="No cookies in response"
				description="should not render"
				action={<button type="button">nope</button>}
			/>
		);
		expect(screen.getByText("No cookies in response")).toBeInTheDocument();
		expect(container.querySelector("svg")).toBeNull();
		expect(screen.queryByText("should not render")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("renders a bare title with no description or icon", () => {
		// Degrades to a single centred line, for call sites that have nothing
		// useful to add beyond the heading.
		const { container } = render(<EmptyState title="Select a request to get started" />);
		expect(screen.getByText("Select a request to get started")).toBeInTheDocument();
		expect(container.querySelector("svg")).toBeNull();
		expect(container.querySelectorAll("p")).toHaveLength(1);
	});
});
