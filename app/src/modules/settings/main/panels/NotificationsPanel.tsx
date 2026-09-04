/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * NotificationsPanel
 *
 * Two cards, because the panel now covers two ways of being told something.
 *
 * The first is the one interruption Vayu makes outside its own window: an OS
 * notification for the events that land while the user is in another
 * application (#1358). Off by default, and unavailable on some builds - see
 * `electron/notify.ts`, which is what this row asks.
 *
 * The second is the four toast preferences: where the stack sits, how long
 * entries stay, how many stack at once, and what is loud enough to show at all.
 * Three of the four are read when a toast is *enqueued* rather than when it is
 * drawn, so changing them does not restyle what is already on screen - which is
 * why this panel has a Preview button. Choosing a position or a duration
 * without being able to see it is guessing.
 */

import { useEffect, useState } from "react";
import { Bell, MonitorDot, Play } from "lucide-react";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Eyebrow,
} from "@/components/ui";
import { systemNotify } from "@/services/notify";
import { useClientSettingsStore, useToastStore } from "@/stores";
import {
	TOAST_POSITIONS,
	TOAST_DURATION_SCALES,
	TOAST_STACK_OPTIONS,
	TOAST_SEVERITY_FLOORS,
	MAX_TOASTS,
	passesSeverityFloor,
	type ToastPosition,
	type ToastDurationScale,
	type ToastSeverityFloor,
} from "@/constants/toast";
import { appSetting } from "../app-settings";
import { OptionButtons, ToggleRow } from "./SettingControls";

// Headings come from the catalogue so search cannot offer a name this panel
// does not print - see `app-settings.ts`.
const SYSTEM = appSetting("system-notifications");
const POSITION = appSetting("toast-position");
const DURATION = appSetting("toast-duration");
const STACK_SIZE = appSetting("toast-stack");
const SEVERITY = appSetting("toast-severity");

/** Cycled so a repeated Preview shows the stack behaving, not one toast re-firing. */
const PREVIEW_SEQUENCE = [
	{ variant: "success" as const, message: "Request completed in 214 ms" },
	{ variant: "info" as const, message: "Environment switched to Staging" },
	{ variant: "warning" as const, message: "3 of 40 requests returned 4xx" },
	{ variant: "error" as const, message: "Connection refused: 127.0.0.1:8080" },
];

export default function NotificationsPanel() {
	const notifications = useClientSettingsStore((s) => s.notifications);
	const setNotifications = useClientSettingsStore((s) => s.setNotifications);
	const showToast = useToastStore((s) => s.showToast);
	const [previewIndex, setPreviewIndex] = useState(0);

	const severity = TOAST_SEVERITY_FLOORS.find((f) => f.value === notifications.minSeverity);

	/*
	 * The preview is subject to the severity floor like anything else - showing
	 * a muted variant anyway would demonstrate the wrong thing. But a button
	 * that silently does nothing reads as broken, so when the current floor
	 * would drop every sample the button says so instead of firing.
	 */
	const previewable = PREVIEW_SEQUENCE.filter((p) =>
		passesSeverityFloor(p.variant, notifications.minSeverity)
	);

	const preview = () => {
		const next = previewable[previewIndex % previewable.length];
		setPreviewIndex((i) => i + 1);
		showToast({ message: next.message, variant: next.variant });
	};

	return (
		<>
			<SystemNotificationsCard />

			{/* One card, four rows: the card is the topic ("Toasts") and each
			    preference is a row inside it. It was four cards, one per setting. */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Bell className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Notifications</CardTitle>
					</div>
					<CardDescription>
						Where toasts appear, how long they stay, how many stack at once, and what is
						worth interrupting you for.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<div data-setting-anchor={POSITION.anchor}>
						<Eyebrow className="mb-2">{POSITION.label}</Eyebrow>
						<OptionButtons
							options={TOAST_POSITIONS.map((p) => ({
								value: p.value,
								label: p.label,
							}))}
							value={notifications.position}
							onChange={(position: ToastPosition) => setNotifications({ position })}
							columns="grid-cols-3"
						/>
						<p className="text-xs text-muted-foreground mt-2">
							Every position clears the title bar and the status strip, and swiping to
							dismiss follows the edge the stack sits on.
						</p>
						<div className="flex items-center gap-2 mt-3">
							<Button
								variant="outline"
								size="sm"
								onClick={preview}
								disabled={previewable.length === 0}
								className="gap-1.5"
							>
								<Play className="w-3.5 h-3.5" />
								Preview
							</Button>
							<p className="text-xs text-muted-foreground">
								{previewable.length === 0
									? "Nothing to preview - Show is set to None."
									: "Fires a sample notification with the settings below."}
							</p>
						</div>
					</div>

					<div data-setting-anchor={DURATION.anchor}>
						<Eyebrow className="mb-2">{DURATION.label}</Eyebrow>
						<OptionButtons
							options={TOAST_DURATION_SCALES.map((d) => ({
								value: d.value,
								label: d.label,
								description: d.description,
							}))}
							value={notifications.durationScale}
							onChange={(durationScale: ToastDurationScale) =>
								setNotifications({ durationScale })
							}
							columns="grid-cols-4"
						/>
						<p className="text-xs text-muted-foreground mt-2">
							Scales how long notifications stay. Severity still sets the ratio - a
							failure outlasts a confirmation at every setting - and the timer pauses
							while you hover, focus or leave the window.
						</p>
					</div>

					<div data-setting-anchor={STACK_SIZE.anchor}>
						<Eyebrow className="mb-2">{STACK_SIZE.label}</Eyebrow>
						<OptionButtons
							options={TOAST_STACK_OPTIONS.map((o) => ({
								value: o.value,
								label: o.label,
							}))}
							value={notifications.maxVisible}
							onChange={(maxVisible: number) => setNotifications({ maxVisible })}
							columns="grid-cols-3"
						/>
						<p className="text-xs text-muted-foreground mt-2">
							How many notifications may stack before the oldest is dropped.{" "}
							{MAX_TOASTS} is what fits without the top of the stack running off
							screen; above that, the oldest can become unreachable.
						</p>
					</div>

					<div data-setting-anchor={SEVERITY.anchor}>
						<Eyebrow className="mb-2">{SEVERITY.label}</Eyebrow>
						<OptionButtons
							options={TOAST_SEVERITY_FLOORS.map((f) => ({
								value: f.value,
								label: f.label,
								description: f.description,
							}))}
							value={notifications.minSeverity}
							onChange={(minSeverity: ToastSeverityFloor) =>
								setNotifications({ minSeverity })
							}
							columns="grid-cols-4"
						/>
						<p className="text-xs text-muted-foreground mt-2">
							The least severe notification worth interrupting you for. Anything below
							the line is dropped rather than queued.
						</p>
						{/*
						 * Only the option that hides failures carries a warning, and it is
						 * rendered rather than described in the option's own text so it is
						 * visible after the choice is made, not only while browsing.
						 */}
						{severity?.warn && (
							<p className="mt-3 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error-text">
								{severity.warn}
							</p>
						)}
					</div>
				</CardContent>
			</Card>
		</>
	);
}

/**
 * The one interruption Vayu makes outside its own window.
 *
 * A card of its own rather than a fifth row among the toast settings: it is not
 * a toast preference, and the events it covers are a fixed list rather than
 * anything the user configures. `services/notify.ts` holds that list.
 *
 * The availability line is asked of the main process rather than guessed from
 * the platform. macOS authorizes notifications per bundle and refuses one whose
 * code signature does not bind its own `Info.plist` - which is the dev
 * `Electron.app` and anything taken straight out of the DMG, though not an
 * installed build, since `install.sh` re-signs it. The app only learns which it
 * is when the first notification fails. A toggle that silently does nothing is
 * the outcome this line exists to prevent.
 */
function SystemNotificationsCard() {
	const enabled = useClientSettingsStore((s) => s.systemNotifications);
	const setEnabled = useClientSettingsStore((s) => s.setSystemNotifications);
	const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void systemNotify.availability().then((availability) => {
			// Outside Electron the question does not arise, and a build that can
			// notify says nothing - the row is then just the toggle.
			if (cancelled || !availability || availability.available) return;
			setUnavailableReason(availability.reason);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<MonitorDot className="w-5 h-5 text-muted-foreground" />
					<CardTitle className="text-base">While Vayu is in the background</CardTitle>
				</div>
				<CardDescription className="mt-1">
					A run that finishes while you are in another application is one you find out
					about by switching back. These events can reach you where you are instead.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<ToggleRow
					anchor={SYSTEM.anchor}
					label={SYSTEM.label}
					description="A load or collection run reaching its end, the engine dropping out, an update becoming ready, and a sign-in finishing in your browser. Nothing else, and nothing at all while Vayu is the window in front - the toast already told you."
					checked={enabled}
					onChange={setEnabled}
				/>
				{unavailableReason && (
					<p className="mt-3 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning-text">
						{unavailableReason}. Vayu will keep reporting these events as toasts.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
