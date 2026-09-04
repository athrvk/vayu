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
 * The per-inbox capture opt-in (issue #1388).
 *
 * Two properties this store exists for, and one it must not lose: an inbox the
 * user has said nothing about is off, and a preference keyed by an id the
 * engine no longer mints is dropped rather than kept forever.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { inboxNotifiesOnCapture, useInboxNotifyStore } from "./inbox-notify-store";

beforeEach(() => {
	localStorage.clear();
	useInboxNotifyStore.setState({ enabled: {} });
});

describe("useInboxNotifyStore", () => {
	it("is off for an inbox nobody has decided about", () => {
		// The default the whole feature rests on: system notifications being on
		// must not make a webhook source loud.
		expect(inboxNotifiesOnCapture("inbox_a")).toBe(false);
		expect(inboxNotifiesOnCapture(null)).toBe(false);
	});

	it("turns one inbox on without touching another", () => {
		useInboxNotifyStore.getState().setEnabled("inbox_a", true);

		expect(inboxNotifiesOnCapture("inbox_a")).toBe(true);
		expect(inboxNotifiesOnCapture("inbox_b")).toBe(false);
	});

	it("stores off as absence, so the map only ever holds the exceptions", () => {
		useInboxNotifyStore.getState().setEnabled("inbox_a", true);
		useInboxNotifyStore.getState().setEnabled("inbox_a", false);

		expect(useInboxNotifyStore.getState().enabled).toEqual({});
	});

	it("drops preferences for inboxes the engine no longer lists", () => {
		// Mutation check: remove `retainInboxes`' filter and the map grows one
		// entry per inbox ever started, none of which can be reached again -
		// an id belongs to the engine process that minted it.
		useInboxNotifyStore.getState().setEnabled("inbox_dead", true);
		useInboxNotifyStore.getState().setEnabled("inbox_live", true);

		useInboxNotifyStore.getState().retainInboxes(["inbox_live"]);

		expect(useInboxNotifyStore.getState().enabled).toEqual({ inbox_live: true });
	});

	it("keeps the same state object when a prune has nothing to drop", () => {
		// A poll every ten seconds must not re-render every reader of this
		// store for an answer that did not change.
		useInboxNotifyStore.getState().setEnabled("inbox_live", true);
		const before = useInboxNotifyStore.getState().enabled;

		useInboxNotifyStore.getState().retainInboxes(["inbox_live", "inbox_other"]);

		expect(useInboxNotifyStore.getState().enabled).toBe(before);
	});

	it("rehydrates what was on, and ignores what was written by hand", async () => {
		localStorage.setItem(
			STORAGE_KEYS.INBOX_NOTIFY_STORE,
			JSON.stringify({
				version: 1,
				state: { enabled: { inbox_a: true, inbox_b: false, inbox_c: "yes", "": true } },
			})
		);

		await useInboxNotifyStore.persist.rehydrate();

		// `false` and a truthy string are both "not on": a reader asks a boolean
		// question and must not get a string's opinion of one.
		expect(useInboxNotifyStore.getState().enabled).toEqual({ inbox_a: true });
	});

	it("falls back to nothing on a payload of the wrong shape", async () => {
		localStorage.setItem(
			STORAGE_KEYS.INBOX_NOTIFY_STORE,
			JSON.stringify({ version: 1, state: { enabled: ["inbox_a"] } })
		);

		await useInboxNotifyStore.persist.rehydrate();

		expect(inboxNotifiesOnCapture("inbox_a")).toBe(false);
	});
});
