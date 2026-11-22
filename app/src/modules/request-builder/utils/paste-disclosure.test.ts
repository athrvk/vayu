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
import { droppedFlagsNotice, pasteNotice, unreadableCommandNotice } from "./paste-disclosure";

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

describe("the paste notice (#3777)", () => {
	it("is absent when the paste dropped nothing and named no variable", () => {
		expect(pasteNotice({ dropped: [], variables: [] })).toBeNull();
	});

	it("is the dropped-flags notice, unchanged, when no variable was named", () => {
		const imported = { dropped: [PROXY, HOMELESS], variables: [] };

		expect(pasteNotice(imported)).toEqual({
			...droppedFlagsNotice(imported.dropped),
			action: expect.anything(),
		});
	});

	it("names each variable as the {{token}} it became, in the order given", () => {
		const notice = pasteNotice({ dropped: [], variables: ["API_KEY", "HOST"] });

		expect(notice).toEqual({
			title: "Imported with variables",
			message:
				"Shell variables became {{API_KEY}}, {{HOST}} - give them values in an environment.",
			variant: "info",
		});
	});

	it("merges the variables and the dropped flags into one warning with the flags' action", () => {
		const notice = pasteNotice({ dropped: [PROXY], variables: ["API_KEY"] });

		expect(notice?.title).toBe("Imported with variables, minus some flags");
		expect(notice?.message).toBe(
			"Shell variables became {{API_KEY}} - give them values in an environment. " +
				"-x routed the request through a proxy (Proxy settings)."
		);
		expect(notice?.variant).toBe("warning");
		notice?.action?.onClick();
		expect(reveal).toHaveBeenCalledWith("network_performance", "proxyUrl");
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
