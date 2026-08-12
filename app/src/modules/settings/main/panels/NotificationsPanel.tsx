/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * NotificationsPanel
 *
 * The four toast preferences: where the stack sits, how long entries stay, how
 * many stack at once, and what is loud enough to show at all.
 *
 * Three of the four are read when a toast is *enqueued* rather than when it is
 * drawn, so changing them does not restyle what is already on screen - which is
 * why this panel has a Preview button. Choosing a position or a duration
 * without being able to see it is guessing.
 */

import { useState } from "react";
import { Bell, Play } from "lucide-react";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Eyebrow,
} from "@/components/ui";
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
import { OptionButtons } from "./SettingControls";

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
		/* One card, four rows: the card is the topic ("Notifications") and each
		   preference is a row inside it. It was four cards, one per setting. */
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
				<div>
					<Eyebrow className="mb-2">Position</Eyebrow>
					<OptionButtons
						options={TOAST_POSITIONS.map((p) => ({ value: p.value, label: p.label }))}
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

				<div>
					<Eyebrow className="mb-2">Duration</Eyebrow>
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

				<div>
					<Eyebrow className="mb-2">Stack size</Eyebrow>
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
						How many notifications may stack before the oldest is dropped. {MAX_TOASTS}{" "}
						is what fits without the top of the stack running off screen; above that,
						the oldest can become unreachable.
					</p>
				</div>

				<div>
					<Eyebrow className="mb-2">Show</Eyebrow>
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
						The least severe notification worth interrupting you for. Anything below the
						line is dropped rather than queued.
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
	);
}
