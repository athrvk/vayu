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
 * A wiped database has to say so, once (issue #922).
 *
 * The engine deletes a database it cannot open and cannot restore, and until
 * this banner the only record was two lines in the engine log - the app came up
 * looking like a fresh install. So the cases here are the two a user has to be
 * able to tell apart (a real first run and a wipe) and the one that makes the
 * notice bearable: it does not come back after it is dismissed, including on
 * the next launch, which is why the acknowledgment is persisted rather than
 * held in component state.
 *
 * Rendered rather than source-scanned: every branch here arrives through a
 * store binding, which a scan cannot see.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import RecoveryBanner from "./RecoveryBanner";
import { useEngineStore, useRecoveryNoticeStore } from "@/stores";
import type { EngineRecovery } from "@/types/domain";

const DELETED: EngineRecovery = {
	outcome: "deleted_corrupt",
	at: 1_755_870_000_000,
	databasePath: "/home/someone/.vayu/vayu.db",
};

beforeEach(() => {
	localStorage.clear();
	useEngineStore.setState({ recovery: null });
	useRecoveryNoticeStore.setState({ acknowledgedAt: null });
});

afterEach(cleanup);

describe("RecoveryBanner", () => {
	it("renders nothing on a clean start", () => {
		// The ordinary case, and the one a genuine first run gives: the engine
		// sends no `recovery` node at all, so an empty workspace must not be
		// announced as data loss.
		const { container } = render(<RecoveryBanner />);
		expect(container).toBeEmptyDOMElement();
	});

	it("names the loss and the database path when the database was deleted", () => {
		useEngineStore.setState({ recovery: DELETED });
		render(<RecoveryBanner />);

		expect(screen.getByText(/Your Vayu data was reset/)).toBeTruthy();
		expect(screen.getByText(DELETED.databasePath)).toBeTruthy();
		// The distinction that matters to the reader: this one is not
		// recoverable from inside Vayu.
		expect(screen.getByText(/no usable backup was found/)).toBeTruthy();
	});

	it("says a restore is a restore, not a wipe", () => {
		useEngineStore.setState({ recovery: { ...DELETED, outcome: "restored_from_backup" } });
		render(<RecoveryBanner />);

		expect(screen.getByText(/restored from a backup/)).toBeTruthy();
		expect(screen.queryByText(/Your Vayu data was reset/)).toBeNull();
	});

	it("stays dismissed, and persists the acknowledgment so the next launch is quiet", () => {
		useEngineStore.setState({ recovery: DELETED });
		const { container } = render(<RecoveryBanner />);

		fireEvent.click(screen.getByLabelText("Dismiss data recovery notice"));
		expect(container).toBeEmptyDOMElement();
		expect(useRecoveryNoticeStore.getState().acknowledgedAt).toBe(DELETED.at);

		// A fresh mount against the same still-reported record - what a relaunch
		// against an engine that kept running looks like.
		cleanup();
		const relaunched = render(<RecoveryBanner />);
		expect(relaunched.container).toBeEmptyDOMElement();
	});

	it("announces a later recovery even though an earlier one was dismissed", () => {
		// The acknowledgment is one timestamp, so a second wipe has to be a
		// different event rather than something the first dismissal covers.
		useRecoveryNoticeStore.setState({ acknowledgedAt: DELETED.at });
		useEngineStore.setState({ recovery: { ...DELETED, at: DELETED.at + 60_000 } });

		render(<RecoveryBanner />);
		expect(screen.getByText(/Your Vayu data was reset/)).toBeTruthy();
	});
});

describe("recovery-notice-store persistence", () => {
	it("treats a malformed stored acknowledgment as nothing acknowledged", async () => {
		// The safe direction: a notice shown twice is an annoyance, a notice
		// suppressed by a garbage value is silent data loss again.
		localStorage.setItem(
			"vayu.recovery-notice",
			JSON.stringify({ version: 1, state: { acknowledgedAt: "not a number" } })
		);

		await useRecoveryNoticeStore.persist.rehydrate();
		expect(useRecoveryNoticeStore.getState().acknowledgedAt).toBeNull();
	});

	it("carries an acknowledgment across a version bump instead of dropping it", async () => {
		localStorage.setItem(
			"vayu.recovery-notice",
			JSON.stringify({ version: 0, state: { acknowledgedAt: DELETED.at } })
		);

		await useRecoveryNoticeStore.persist.rehydrate();
		expect(useRecoveryNoticeStore.getState().acknowledgedAt).toBe(DELETED.at);
	});
});
