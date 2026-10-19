/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The start options for a webhook inbox: which origins may read its answers
 * (#2367).
 *
 * Starting an inbox is one click and stays one click - the common case is "give
 * me a URL" with nothing set, from the drawer's New inbox and from the tab's
 * Start buttons. This is the secondary affordance beside them, the shape
 * `MockServerControl` gave the mock's options: an icon button that opens a
 * form. It owns its own start mutation because the three places that offer it
 * react to a start differently (the tab shows the new inbox, the drawer flashes
 * its row), which they say through `onStarted`; the dialog's failure is shown in
 * the form, where the user is, not as a toast behind it.
 *
 * Fixed for the inbox's life, like the mock's: the engine has no way to change
 * it on a running listener, so a different policy is a new inbox.
 */

import { useState } from "react";
import { Loader2, SlidersHorizontal } from "lucide-react";
import {
	Button,
	Dialog,
	DialogBody,
	DialogCancelButton,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	ICON_MOTION,
	TooltipIconButton,
} from "@/components/ui";
import { AllowedOriginsField, Callout } from "@/components/shared";
import { parseAllowedOrigins } from "@/lib/allowed-origins";
import { useStartInboxMutation } from "@/queries";
import type { Inbox } from "@/types";

export interface InboxStartOptionsProps {
	/** Runs once the engine has started the inbox; the dialog closes first. */
	onStarted: (inbox: Inbox) => void;
	/** The caller's own start is in flight, so a second one would race it. */
	disabled?: boolean;
}

/**
 * Mounted only while open, like `StartMockServerDialog`: the mount is the
 * reset, so the box starts empty every time.
 */
function StartInboxDialog({
	onOpenChange,
	onStarted,
}: {
	onOpenChange: (open: boolean) => void;
	onStarted: (inbox: Inbox) => void;
}) {
	const startInbox = useStartInboxMutation();
	const [originsText, setOriginsText] = useState("");
	const origins = parseAllowedOrigins(originsText);
	const canStart = !origins.error && !startInbox.isPending;

	const start = () => {
		if (!canStart) return;
		startInbox.mutate(
			// Absent, not `[]`: no list is the engine's own default, and the
			// one-click start sends the same `{}` this does when nothing is set.
			origins.origins.length > 0 ? { allowedOrigins: origins.origins } : {},
			{
				onSuccess: (inbox) => {
					onOpenChange(false);
					onStarted(inbox);
				},
			}
		);
	};

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Inbox options</DialogTitle>
					<DialogDescription>
						Which pages may read what the inbox answers. Fixed for the life of the inbox
						- start a new one to change it.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-4 py-2">
					<AllowedOriginsField
						id="inbox-allowed-origins"
						value={originsText}
						onChange={setOriginsText}
						error={origins.error}
					/>
					{startInbox.error && (
						<Callout severity="blocking" title="Couldn't start the inbox">
							{startInbox.error.message}
						</Callout>
					)}
				</DialogBody>

				<DialogFooter>
					<DialogCancelButton onClick={() => onOpenChange(false)} />
					<Button onClick={start} disabled={!canStart}>
						{startInbox.isPending && (
							<Loader2 className="mr-2 size-icon animate-spin" aria-hidden="true" />
						)}
						Start inbox
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function InboxStartOptions({ onStarted, disabled }: InboxStartOptionsProps) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<TooltipIconButton
				label="Inbox options"
				tooltipHint="Allowed origins"
				icon={
					<SlidersHorizontal
						className="size-icon-sm"
						aria-hidden="true"
						data-icon-motion={ICON_MOTION.nudgeX}
					/>
				}
				disabled={disabled}
				onClick={() => setOpen(true)}
			/>
			{open && <StartInboxDialog onOpenChange={setOpen} onStarted={onStarted} />}
		</>
	);
}
