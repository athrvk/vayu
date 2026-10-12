/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The resolved branch of `VariablePopover`: the value field, the secret's eye,
 * and how the edit is committed.
 *
 * The editable field *is* the current value, so there is no separate read-out
 * above it. A second display renders only where it does work the field cannot:
 * a secret, masked until deliberately revealed, and the not-editable case.
 *
 * The edit buffer, the reveal flag and the key handler belong to the popover:
 * its content unmounts on close, and its close path is what saves, discards
 * and re-masks them.
 */

import { Eye, EyeOff } from "lucide-react";
import type { ResolvedVariable } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { DialogCancelButton } from "./dialog-cancel-button";
import { Input } from "./input";
import { TooltipIconButton } from "./tooltip-icon-button";

/**
 * A **fixed-width** stand-in for a hidden secret.
 *
 * Deliberately not `"•".repeat(value.length)` and deliberately not a
 * `type="password"` input holding the real string (which is why `SecretInput`
 * is not used here): both draw one dot per character, which tells anyone
 * looking how long the secret is.
 */
export const SECRET_MASK = "••••••••";

export interface ResolvedValueEditorProps {
	name: string;
	varInfo: ResolvedVariable;
	/** False draws the value read-only, with no commit controls. */
	canEdit: boolean;
	editValue: string;
	onEditValueChange: (value: string) => void;
	/** The popover's Enter/Escape handling, bound to the editable field. */
	onKeyDown: (e: React.KeyboardEvent) => void;
	saveMode: "manual" | "auto";
	/** Whether a secret is shown; ignored for a value that is not secret. */
	revealed: boolean;
	onRevealChange: (revealed: boolean) => void;
	/**
	 * A real DOM attribute, so it fires on mount whatever Radix's own
	 * `onOpenAutoFocus` decided: a hover that opens the popover unfocused must
	 * pass false (issue #1220 hover redesign).
	 */
	autoFocus: boolean;
	onSave: () => void;
	onCancel: () => void;
}

export function ResolvedValueEditor(props: ResolvedValueEditorProps) {
	const { canEdit, saveMode, onSave, onCancel } = props;
	return (
		<>
			<ValueField {...props} />

			{/*
			 * What the two keys do, as a sentence rather than as keycaps: Enter
			 * is not what saves an auto-mode edit - clicking away does, and Enter
			 * is one way of doing that - so a `↵ save` chip advertised a commit
			 * key beside a mode that commits on blur.
			 */}
			{canEdit && saveMode === "auto" && (
				<p className="text-micro text-muted-foreground">
					Saves when you click away. Esc discards.
				</p>
			)}

			{saveMode === "manual" && canEdit && (
				<div className="flex justify-end gap-2">
					<DialogCancelButton size="sm" onClick={onCancel} />
					<Button size="sm" onClick={onSave}>
						Save
					</Button>
				</div>
			)}
		</>
	);
}

/**
 * One field for a secret too.
 *
 * Hidden, the field is read-only and shows a fixed-width mask, so nothing about
 * the value is inferable and it cannot be edited blind. Revealing turns it into
 * an ordinary editable field - one control, two states, and the eye is the only
 * thing that moves between them.
 */
function ValueField({
	name,
	varInfo,
	canEdit,
	editValue,
	onEditValueChange,
	onKeyDown,
	revealed,
	onRevealChange,
	autoFocus,
}: ResolvedValueEditorProps) {
	const isSecret = !!varInfo.secret;

	if (!canEdit) {
		return (
			<div className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm break-all">
				{isSecret && !revealed ? (
					<span className="select-none">{SECRET_MASK}</span>
				) : (
					varInfo.value || <span className="italic text-muted-foreground">empty</span>
				)}
			</div>
		);
	}

	if (isSecret && !revealed) {
		return (
			<div className="relative">
				<Input
					size="sm"
					/*
					 * Keyed against the revealed field below, which is otherwise the
					 * same `<Input>` in the same slot: React would reconcile the two
					 * rather than remount, and `autoFocus` fires on mount - so
					 * revealing left focus behind on the eye and the field the reveal
					 * exists to open had to be tabbed back to.
					 */
					key="secret-masked"
					readOnly
					value={varInfo.value ? SECRET_MASK : ""}
					placeholder="not set"
					aria-label={`Value of ${name} (hidden)`}
					className="select-none pr-8 font-mono text-sm"
				/>
				<RevealButton
					revealed={false}
					onToggle={() => onRevealChange(true)}
					/*
					 * The popover suppresses its own open-autofocus, and every other
					 * branch compensates with `autoFocus` on the field it opens onto.
					 * The masked field is `readOnly`, and the popover is non-modal and
					 * portalled, so without this a secret was the one variable a
					 * keyboard user could not read (issue #1215). The eye is the right
					 * landing: revealing is the only action here, and it hands focus
					 * on to the editable field.
					 */
					autoFocus={autoFocus}
				/>
			</div>
		);
	}

	return (
		<div className="relative">
			<Input
				size="sm"
				key="secret-revealed"
				value={editValue}
				onChange={(e) => onEditValueChange(e.target.value)}
				onKeyDown={onKeyDown}
				className={cn("font-mono text-sm", isSecret && "pr-8")}
				aria-label={`Value of ${name}`}
				autoFocus={autoFocus}
			/>
			{isSecret && <RevealButton revealed onToggle={() => onRevealChange(false)} />}
		</div>
	);
}

/** The eye that swaps a hidden secret field for an editable one. */
function RevealButton({
	revealed,
	onToggle,
	autoFocus,
}: {
	revealed: boolean;
	onToggle: () => void;
	/** The masked branch's only entry point - see its call site. */
	autoFocus?: boolean;
}) {
	return (
		<TooltipIconButton
			label={revealed ? "Hide value" : "Reveal value"}
			icon={revealed ? <EyeOff className="size-icon-sm" /> : <Eye className="size-icon-sm" />}
			onClick={onToggle}
			autoFocus={autoFocus}
			className="absolute right-0 top-0 size-control-sm text-muted-foreground hover:text-foreground"
		/>
	);
}
