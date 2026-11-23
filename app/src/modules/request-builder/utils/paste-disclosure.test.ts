/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The paste ledger's notice (issue #708) - what it says, and when it says
 * nothing at all.
 */

import { describe, expect, it, vi } from "vitest";

import type { DroppedFlag } from "@/services/curl/parseCurl";
import { droppedFlagsNotice, pasteNotices, unreadableCommandNotice } from "./paste-disclosure";

const reveal = vi.hoisted(() => vi.fn());
vi.mock("@/modules/settings/reveal", () => ({ revealSetting: reveal }));

const PROXY: DroppedFlag = {
	flag: "-x",
	what: "routed the request through a proxy",
	pointer: { category: "network_performance", anchor: "proxyUrl", label: "Proxy settings" },
};

const HOMELESS: DroppedFlag = { flag: "--retry", what: "retried on failure" };

describe("the paste disclosure notice", () => {
	it("is absent when the command carried everything", () => {
		// The common paste. A "nothing was lost" notice on every one of them is
		// how a disclosure surface is learned as noise and stops being read.
		expect(droppedFlagsNotice([])).toBeNull();
	});

	it("names every dropped flag and where its intent lives", () => {
		const notice = droppedFlagsNotice([PROXY, HOMELESS]);

		expect(notice?.message).toContain("-x routed the request through a proxy (Proxy settings)");
		expect(notice?.message).toContain("--retry retried on failure");
		// The homeless one carries no destination in parentheses - a pointer
		// that goes nowhere is worse than none.
		expect(notice?.message).not.toContain("--retry retried on failure (");
	});

	it("is a warning, because a dropped proxy fails the next send", () => {
		expect(droppedFlagsNotice([PROXY])?.variant).toBe("warning");
	});

	it("offers an action that reveals the setting", () => {
		const notice = droppedFlagsNotice([PROXY]);
		notice?.action?.onClick();
		expect(reveal).toHaveBeenCalledWith("network_performance", "proxyUrl");
	});

	it("offers no action when nothing dropped has a home here", () => {
		// Named, not actioned. An "Open settings" that lands on a screen with no
		// answer for `--retry` is a pointer to nowhere.
		expect(droppedFlagsNotice([HOMELESS])?.action).toBeUndefined();
	});
});

describe("the paste notices (#3777)", () => {
	it("are absent when the paste dropped nothing and named no variable", () => {
		expect(pasteNotices({ dropped: [], variables: [] })).toEqual([]);
	});

	it("are the dropped-flags notice, unchanged, when no variable was named", () => {
		const imported = { dropped: [PROXY, HOMELESS], variables: [] };

		expect(pasteNotices(imported)).toEqual([
			{ ...droppedFlagsNotice(imported.dropped), action: expect.anything() },
		]);
	});

	it("name each variable as the {{token}} it became, in the order given", () => {
		const notices = pasteNotices({ dropped: [], variables: ["API_KEY", "HOST"] });

		expect(notices).toEqual([
			{
				title: "Imported with variables",
				message:
					"Shell variables became {{API_KEY}}, {{HOST}} - give them values in an environment.",
				variant: "info",
			},
		]);
	});

	it("are two toasts when both apply, each a single sentence, the flags' action on its own", () => {
		const [variables, flags, ...rest] = pasteNotices({
			dropped: [PROXY],
			variables: ["API_KEY"],
		});

		expect(rest).toEqual([]);
		expect(variables).toMatchObject({ title: "Imported with variables", variant: "info" });
		expect(variables.action).toBeUndefined();
		expect(flags).toMatchObject({ title: "Imported, minus some flags", variant: "warning" });
		expect(flags.message).toBe("-x routed the request through a proxy (Proxy settings).");
		flags.action?.onClick();
		expect(reveal).toHaveBeenCalledWith("network_performance", "proxyUrl");
		for (const notice of [variables, flags]) {
			expect(notice.message.match(/[.!?](\s|$)/g)).toHaveLength(1);
		}
	});
});

describe("the unreadable command notice (#3685)", () => {
	it.each([
		["unterminated-quote", "You opened a quote and never closed it"],
		["missing-url", "The command has no URL"],
		["not-a-command", "The text is not a cURL or wget command"],
		["unreadable", "Vayu couldn't parse the command"],
	] as const)("names %s as the reason and says the request is untouched", (reason, cause) => {
		const notice = unreadableCommandNotice(reason);

		expect(notice.message).toBe(`${cause}, so the request was left as it was.`);
		expect(notice.title).toBe("Couldn't import the command");
	});

	it("is a warning, which the severity floor must not hide", () => {
		expect(unreadableCommandNotice("missing-url").variant).toBe("warning");
	});
});
