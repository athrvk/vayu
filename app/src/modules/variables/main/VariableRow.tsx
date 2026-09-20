/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One row of the variables table (`VariableTableEditor`).
 *
 * `memo`-wrapped for the same reason `KeyValueRow` is (issue #1716): the table
 * used to render every row inline in a `.map`, so `updateVariable` rebuilding
 * the whole array on every keystroke re-rendered every row's `Input`, `Select`
 * and `SecretInput` on every character typed in any one of them. Extracting
 * the row and keying it by `variable.id` is what gives `memo` something
 * stable to compare against - the `id` and, for the row that changed, its own
 * `item` are the only props that move on a keystroke; every other row keeps
 * the identical `item` reference `VariableTableEditor` handed it last render.
 */

import { memo } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import {
	Button,
	Checkbox,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	SecretInput,
	TooltipIconButton,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { VariableType } from "@/lib/variable-cast";
import type { VariableRowData } from "./VariableTableEditor";

const VARIABLE_TYPES: { value: VariableType; label: string }[] = [
	{ value: "string", label: "String" },
	{ value: "number", label: "Number" },
	{ value: "boolean", label: "Boolean" },
	{ value: "json", label: "JSON" },
];

interface VariableRowProps {
	variable: VariableRowData;
	/** The scope's accent, applied to the enable checkbox - a value, not an identity, so it never defeats `memo` on its own. */
	checkboxColor: string;
	/** `(id, field, value)`, ref-backed in the parent - stable across keystrokes. */
	onUpdate: (id: string, field: keyof VariableRowData, value: string | boolean) => void;
	/** Fires the parent's save immediately - the checkbox, the type select and the secret toggle all commit on change rather than waiting for blur. */
	onCommitNow: () => void;
	onRemove: (id: string) => void;
	onBlur: () => void;
}

function VariableRow({
	variable,
	checkboxColor,
	onUpdate,
	onCommitNow,
	onRemove,
	onBlur,
}: VariableRowProps) {
	/*
	 * A row is a secret field once it is persisted: an unsaved blank row masks
	 * nothing, because there is no stored secret to protect and typing into a
	 * password field you just created only hides your own keystrokes.
	 */
	const isSecretField = variable.secret && !variable.isNew;

	return (
		/*
		 * Keyed by row id, not by index, at the call site in `VariableTableEditor`.
		 * With an index key a delete reuses the mounted row one position down -
		 * `SecretInput` included, reveal state and all - so deleting a revealed
		 * secret displayed its successor unmasked (#621). The id follows the row,
		 * so a deleted row's state is unmounted with it.
		 */
		<tr className="group">
			{/*
			 * `px-1` is clearance for the focus ring, not decoration.
			 * `Checkbox`'s `focus-visible:ring-1 ring-offset-1` draws
			 * outside the box, and this cell sits against the scroll
			 * container's clip edge when embedded - so with no
			 * horizontal padding the ring lost its left side.
			 *
			 * Clearance rather than `.panel-clip` on the container: the
			 * same `Checkbox` appears in the request builder's
			 * key-value rows, where `KeyValueRow`'s `p-1` gives it the
			 * same 4px and the ring reads as an outset hairline with a
			 * gap. Tucking this one inward would have made one control
			 * look like two, depending on the screen.
			 */}
			<td className="py-1 px-1">
				<Checkbox
					checked={variable.enabled}
					onChange={(e) => {
						onUpdate(variable.id, "enabled", e.target.checked);
						onCommitNow();
					}}
					className={cn("size-icon", checkboxColor)}
					disabled={variable.isNew && !variable.key}
				/>
			</td>
			<td className="py-1 px-2">
				<Input
					type="text"
					value={variable.key}
					onChange={(e) => onUpdate(variable.id, "key", e.target.value)}
					onBlur={onBlur}
					placeholder="variable_name"
					className={cn(
						"h-8 text-primary",
						!variable.enabled && !variable.isNew && "text-muted-foreground bg-muted"
					)}
				/>
			</td>
			<td className="py-1 px-2">
				{/*
				 * `SecretInput` rather than a masked `Input`
				 * and an eye of our own: that primitive was
				 * extracted from this very cell so every
				 * secret field in the app would share one
				 * implementation, and the copy left behind
				 * here missed the fixes it since received.
				 * Reveal state belongs to the primitive -
				 * unmounting on un-secret is what clears it,
				 * which is what the editor's own revealed-set
				 * used to do by hand.
				 */}
				{isSecretField ? (
					<SecretInput
						value={variable.value}
						onChange={(v) => onUpdate(variable.id, "value", v)}
						onBlur={onBlur}
						placeholder="value"
						className={cn("h-8", !variable.enabled && "text-muted-foreground bg-muted")}
					/>
				) : (
					<Input
						type="text"
						value={variable.value}
						onChange={(e) => onUpdate(variable.id, "value", e.target.value)}
						onBlur={onBlur}
						placeholder="value"
						className={cn(
							"h-8",
							!variable.enabled &&
								!variable.isNew &&
								"text-muted-foreground bg-muted",
							variable.secret && "font-mono"
						)}
					/>
				)}
			</td>
			<td className="py-1 px-2">
				<Select
					value={variable.type ?? "string"}
					onValueChange={(v) => {
						onUpdate(variable.id, "type", v as VariableType);
						// Only fire an immediate save if the row is already persisted -
						// otherwise let the key/value entry commit it on first edit.
						if (!variable.isNew) onCommitNow();
					}}
				>
					<SelectTrigger
						className={cn(
							"h-8 text-xs px-2",
							!variable.enabled && !variable.isNew && "opacity-60"
						)}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{VARIABLE_TYPES.map((t) => (
							<SelectItem key={t.value} value={t.value} className="text-xs">
								{t.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</td>
			<td className="py-1 text-center">
				{!variable.isNew && (
					<TooltipIconButton
						label={
							variable.secret
								? "Unmark as secret"
								: "Mark as secret (masks value in UI)"
						}
						icon={<KeyRound className="size-icon" />}
						onClick={() => {
							// Un-securing a row swaps `SecretInput`
							// out for a plain field, and its reveal
							// state goes with it - so re-securing
							// starts masked, without this handler
							// tracking anything.
							onUpdate(variable.id, "secret", !variable.secret);
							onCommitNow();
						}}
						/*
						 * Always visible, unlike the delete button beside it.
						 *
						 * This is a state toggle, not a row action. Hidden at
						 * rest, "not secret" looked identical to "no control
						 * here", so masking a value was undiscoverable unless
						 * you happened to hover the row - and a keyboard user
						 * tabbed onto something invisible, since it carried no
						 * `group-focus-within` either.
						 *
						 * Quiet rather than absent: `muted-foreground` clears
						 * the 3.0 non-text bar on every surface here, and the
						 * on state stays clearly distinct on `warning-text`.
						 */
						className={cn(
							"h-8 w-8 transition-colors",
							variable.secret
								? "text-warning-text hover:text-warning-text hover:bg-warning/10"
								: "text-muted-foreground hover:text-foreground"
						)}
					/>
				)}
			</td>
			<td className="py-1">
				{!variable.isNew && (
					<Button
						variant="rowActionDestructive"
						size="icon"
						onClick={() => onRemove(variable.id)}
						aria-label="Delete variable"
						className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
					>
						<Trash2 className="size-icon" />
					</Button>
				)}
			</td>
		</tr>
	);
}

export default memo(VariableRow);
