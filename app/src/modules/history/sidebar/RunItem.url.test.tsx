/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * A url-titled run row keeps its path (#1691).
 *
 * Unsaved runs have no request name, so the row's identity is the url - and CSS
 * `truncate` cuts the tail, which on one host is the only part that differs. A
 * page of local runs read `http://127.0.0.1:9...` over and over.
 *
 * Mutation check: hand `identityText` the raw `requestUrl` again and the first
 * case fails - the two rows come out with the same visible text.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RunItem from "./RunItem";
import type { Run } from "@/types";

function urlRun(url: string): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		// No `requestName`: an unsaved run, which is the case that breaks.
		summary: { url, method: "GET" },
	} as Run;
}

const noop = () => {};

function identityOf(url: string): string {
	const { container, unmount } = render(
		<RunItem run={urlRun(url)} onSelect={noop} onDelete={noop} isDeleting={false} />
	);
	const text = container.querySelector("span.truncate")!.textContent!;
	unmount();
	return text;
}

describe("a run row titled by its url", () => {
	it("shortens from the head so the path survives the row's width", () => {
		// jsdom has no layout, so CSS `truncate` is invisible to it - which is why
		// the shortening has to happen in the text the row renders rather than
		// being left to the class. The claim is therefore about that text: it is
		// bounded, and what it keeps is the end.
		const host = "http://127.0.0.1:9876/api/v3";
		const a = identityOf(`${host}/customers/42/orders/7/refunds/12`);
		const b = identityOf(`${host}/invoices/42/refunds/12`);

		expect(a.length).toBeLessThanOrEqual(48);
		expect(a.endsWith("/customers/42/orders/7/refunds/12")).toBe(true);
		expect(a).toContain("…");
		// Two runs on one host, told apart - the defect was five rows reading
		// `http://127.0.0.1:9...`.
		expect(b.endsWith("/invoices/42/refunds/12")).toBe(true);
		expect(a).not.toBe(b);
	});

	it("keeps the full url a hover and an accessible name away", () => {
		const url = "http://127.0.0.1:9876/api/v3/customers/42/orders/7/refunds/12";
		render(<RunItem run={urlRun(url)} onSelect={noop} onDelete={noop} isDeleting={false} />);

		// Nothing is hidden by shortening the visible text: the title carries the
		// whole value, and so does the row's accessible name.
		expect(screen.getByTitle(url)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: new RegExp(url.replace(/[.?*+]/g, "\\$&")) }));
	});
});
