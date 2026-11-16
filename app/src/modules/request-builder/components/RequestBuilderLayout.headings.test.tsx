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
 * A request tab has one top heading (#3498): the crumb's current segment, the
 * request's own name, since nothing else on the builder names it. Everything
 * under the crumb - the request tabs, the response pane - is a section one
 * level below, so the response pane's empty state is an `h2`, not a second
 * `h1`.
 *
 * Mutation check: drop `titlesPane` from the layout's `TabBreadcrumb` and the
 * tab has no `h1`; drop its `HeadingSection` and the response's title is one.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "@/components/shared";
import { asTab, expectOneTopHeading } from "@/test/heading-outline.testkit";
import RequestBuilderLayout from "./RequestBuilderLayout";

vi.mock("../context", () => ({
	useRequestBuilderContext: () => ({
		request: { url: "https://example.com" },
		isExecuting: false,
		isStreaming: false,
		executeRequest: vi.fn(),
		startLoadTest: vi.fn(),
		canStartLoadTest: true,
	}),
}));
vi.mock("./useRequestCrumbs", () => ({
	useRequestCrumbs: () => [
		{ id: "col_1", label: "Pets API", onSelect: vi.fn() },
		{ id: "request", label: "List pets" },
	],
}));
vi.mock("./UrlBar", () => ({ default: () => <div data-testid="url-bar" /> }));
vi.mock("./ExternalChangeNotice", () => ({ default: () => null }));
vi.mock("./RequestTabs", () => ({ default: () => <div data-testid="request-tabs" /> }));
vi.mock("./ResponseAnnouncer", () => ({ default: () => null }));
// The response pane's real empty state, the primitive that reads the outline.
vi.mock("./ResponseViewer", () => ({
	default: () => <EmptyState title="Send a request to see its response" />,
}));

describe("the request builder's headings", () => {
	it("titles the tab with the request's name, and levels the response under it", () => {
		const { container } = render(asTab(<RequestBuilderLayout />));

		expect(expectOneTopHeading(container)).toBe("List pets");
		expect(
			screen.getByRole("heading", { level: 2, name: "Send a request to see its response" })
		).toBeInTheDocument();
	});
});
