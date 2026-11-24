/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `VariablePopover`'s resolved branch: the value field, the secret's eye, and how the edit commits.
 * The editable field *is* the current value, so there is no read-out above it; a second display
 * appears only where the field cannot serve (a masked secret, the not-editable case). The edit
 * buffer, reveal flag and key handler belong to the popover: its content unmounts on close, and its
 * close path saves, discards and re-masks them.
 */

import { Eye, EyeOff } from "lucide-react";
import type { ResolvedVariable } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { DialogCancelButton } from "./dialog-cancel-button";
import { Input } from "./input";
import { TooltipIconButton } from "./tooltip-icon-button";

/**
 * A **fixed-width** stand-in for a hidden secret, not `"•".repeat(value.length)` nor a
 * `type="password"` input holding it (so not `SecretInput`): both draw a dot per character, telling
 * anyone looking the secret's length.
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
	 * A real DOM attribute, so it fires on mount whatever Radix's `onOpenAutoFocus` decided; a
	 * hover opening the popover unfocused passes false (#1220).
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
			 * The keys as a sentence, not keycaps: clicking away saves an auto-mode edit and Enter
			 * is one way of doing that, so a `↵ save` chip advertised a commit key in a mode that
			 * commits on blur.
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
 * One field for a secret too. Hidden, it is read-only with a fixed-width mask, so nothing is
 * inferable and nothing edited blind; revealed, an ordinary editable field. One control, two
 * states, the eye the only switch.
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
					 * Keyed apart from the revealed field, the same `<Input>` in the same slot:
					 * React would reconcile rather than remount, and `autoFocus` fires on mount, so
					 * revealing left focus on the eye.
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
					 * The popover suppresses its open-autofocus, and every other branch puts
					 * `autoFocus` on its field. The masked field is `readOnly` in a non-modal
					 * portalled popover, so without this a secret was the one variable a keyboard
					 * user could not read (#1215). The eye is the landing: revealing is the only
					 * action, and it hands focus to the editable field.
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
	/** The masked branch's only entry point; see its call site. */
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
