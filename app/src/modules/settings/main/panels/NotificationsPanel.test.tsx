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
 * The notifications panel writes through, and does not lie about the preview.
 *
 * The preview button is the reason this panel exists in the shape it does:
 * three of the four settings are applied when a toast is *enqueued*, so nothing
 * on screen changes when you pick one. A button that fires nothing would
 * therefore be indistinguishable from a setting that did not apply - which is
 * exactly the state the "None" severity floor puts it in.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// What the build can do is the main process's answer (#1358). Available is the
// ordinary case; the case that matters is a build that cannot notify at all.
const { mockAvailability } = vi.hoisted(() => ({
	mockAvailability: vi.fn().mockResolvedValue({ available: true, reason: null }),
}));
vi.mock("@/services/notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/notify")>()),
	systemNotify: { post: vi.fn(), availability: mockAvailability },
}));

import NotificationsPanel from "./NotificationsPanel";
import { useClientSettingsStore } from "@/stores";
import { useToastStore } from "@/stores";
import { DEFAULT_NOTIFICATION_PREFS } from "@/constants/toast";

beforeEach(() => {
	cleanup();
	mockAvailability.mockResolvedValue({ available: true, reason: null });
	useToastStore.setState({ toasts: [] });
	useClientSettingsStore.setState({
		notifications: { ...DEFAULT_NOTIFICATION_PREFS },
		systemNotifications: false,
	});
});

const prefs = () => useClientSettingsStore.getState().notifications;

describe("NotificationsPanel", () => {
	it("writes each setting through to the store", () => {
		render(<NotificationsPanel />);

		fireEvent.click(screen.getByRole("button", { name: /top left/i }));
		expect(prefs().position).toBe("top-left");

		fireEvent.click(screen.getByRole("button", { name: /^long/i }));
		expect(prefs().durationScale).toBe("long");

		fireEvent.click(screen.getByRole("button", { name: /errors only/i }));
		expect(prefs().minSeverity).toBe("error");
	});

	it("fires a real toast from Preview", () => {
		render(<NotificationsPanel />);
		fireEvent.click(screen.getByRole("button", { name: /preview/i }));
		expect(useToastStore.getState().toasts).toHaveLength(1);
	});

	it("previews something the current floor will actually show", () => {
		useClientSettingsStore.setState({
			notifications: { ...DEFAULT_NOTIFICATION_PREFS, minSeverity: "error" },
		});
		render(<NotificationsPanel />);

		fireEvent.click(screen.getByRole("button", { name: /preview/i }));
		const toasts = useToastStore.getState().toasts;
		// Not merely "something was queued": a success sample under an
		// errors-only floor would be dropped, and the button would look broken.
		expect(toasts).toHaveLength(1);
		expect(toasts[0].variant).toBe("error");
	});

	it("disables Preview and says why when everything is muted", () => {
		useClientSettingsStore.setState({
			notifications: { ...DEFAULT_NOTIFICATION_PREFS, minSeverity: "none" },
		});
		render(<NotificationsPanel />);

		expect(screen.getByRole("button", { name: /preview/i })).toBeDisabled();
		expect(screen.getByText(/nothing to preview/i)).toBeInTheDocument();
	});

	it("warns that None hides failures too", () => {
		useClientSettingsStore.setState({
			notifications: { ...DEFAULT_NOTIFICATION_PREFS, minSeverity: "none" },
		});
		render(<NotificationsPanel />);
		// The one option that can make a failed request report nothing anywhere.
		expect(screen.getByText(/errors are hidden too/i)).toBeInTheDocument();
	});

	it("shows no warning for the floors that still surface failures", () => {
		render(<NotificationsPanel />);
		expect(screen.queryByText(/errors are hidden too/i)).not.toBeInTheDocument();
	});

	describe("system notifications (issue #1358)", () => {
		it("is off until the user turns it on, and writes through", () => {
			render(<NotificationsPanel />);
			const toggle = screen.getByRole("switch", { name: /notify through the system/i });

			expect(toggle).not.toBeChecked();

			fireEvent.click(toggle);

			expect(useClientSettingsStore.getState().systemNotifications).toBe(true);
		});

		it("says so when the build cannot show one, rather than offering a toggle that does nothing", async () => {
			mockAvailability.mockResolvedValue({
				available: false,
				reason: "System notifications are unavailable on this build",
			});
			render(<NotificationsPanel />);

			// Mutation check: drop the availability read and this line never
			// appears - an ad-hoc signed macOS build then shows a switch that
			// silently posts nothing.
			await waitFor(() =>
				expect(screen.getByText(/unavailable on this build/i)).toBeInTheDocument()
			);
			expect(screen.getByText(/keep reporting these events as toasts/i)).toBeInTheDocument();
		});

		it("says nothing about availability on a build that can notify", async () => {
			render(<NotificationsPanel />);

			await waitFor(() => expect(mockAvailability).toHaveBeenCalled());
			expect(screen.queryByText(/unavailable on this build/i)).not.toBeInTheDocument();
		});
	});
});
