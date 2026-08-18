/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A `{{token}}` whose value is produced at run time rather than stored in a
 * scope - `{{$guid}}`, which a generator invents per use, and `{{data.email}}`,
 * which a collection run binds from the iteration's row.
 *
 * The sibling `EditableVariable` cannot serve either. It offers a popover for
 * viewing and editing a stored value, and neither of these has one: there is
 * nothing to edit, and any value it showed would be one it had just invented
 * rather than the one the request will carry. What it *would* do is worse -
 * a name no scope defines paints `text-destructive-text` with a "not defined"
 * tooltip, and offers to create the variable. For a generator that is exactly
 * backwards; for a `data.*` name the offer is a trap, since the namespace is
 * disjoint from the scopes and a variable of that name can never answer for the
 * column.
 *
 * One component for both, rather than one each: they differ only in the words
 * of the tooltip, and a hand-rolled copy of a primitive does not receive the
 * primitive's fixes.
 *
 * So: same typeface and layout as `EditableVariable` (see the font note there -
 * the caret is steered by a transparent input underneath and any width
 * difference walks it off the glyphs), muted rather than accent-coloured, and a
 * tooltip that says where the value will come from.
 */

import { Tooltip, TooltipContent, TooltipHint, TooltipTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { DataTokenTone } from "@/lib/data-contract";
import { DATA_TOKEN_TONE_CLASS } from "@/lib/data-token-tone";

export interface RuntimeTokenProps {
	/** Name as written inside the braces, e.g. `"$guid"` or `"data.email"`. */
	name: string;
	/** What the token stands for, e.g. "UUID v4". */
	description: string;
	/** When it is produced, e.g. "generated per use". */
	note: string;
	/**
	 * `warning` for a token that will read correctly only if the run's file
	 * disagrees with the contract - a `{{data.x}}` naming a column no contract
	 * in scope declares (issue #600). Never `destructive`: that paint means "no
	 * value can ever answer this name", and an undeclared column can still bind
	 * from a file the contract has drifted from.
	 */
	tone?: DataTokenTone;
}

export default function RuntimeToken({
	name,
	description,
	note,
	tone = "muted",
}: RuntimeTokenProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className={cn("inline rounded-md font-[inherit]", DATA_TOKEN_TONE_CLASS[tone])}
					contentEditable={false}
					suppressContentEditableWarning
				>
					{`{{${name}}}`}
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-xs">
				<span className="flex items-baseline gap-2">
					<span className="break-all">{description}</span>
					<TooltipHint className="shrink-0">{note}</TooltipHint>
				</span>
			</TooltipContent>
		</Tooltip>
	);
}
