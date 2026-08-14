/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A `{{$guid}}` token inline in a URL or header value.
 *
 * The sibling `EditableVariable` cannot serve these. It offers a popover for
 * viewing and editing a stored value, and a generator has neither: there is
 * nothing to edit, and any value it showed would be one it had just invented
 * rather than the one the request will carry. What it *would* do is worse -
 * a name no scope defines paints `text-destructive-text` with a "not defined"
 * tooltip, which is exactly backwards for a name that resolves every time.
 *
 * So: same typeface and layout as its sibling (see the font note there - the
 * caret is steered by a transparent input underneath and any width difference
 * walks it off the glyphs), muted rather than accent-coloured, and a tooltip
 * that says what it generates.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";

export interface DynamicVariableTokenProps {
	/** Name including the `$`, e.g. `"$guid"`. */
	name: string;
	/** The table's one-line description, e.g. "UUID v4". */
	description: string;
}

export default function DynamicVariableToken({ name, description }: DynamicVariableTokenProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className="inline rounded-md font-[inherit] text-muted-foreground"
					contentEditable={false}
					suppressContentEditableWarning
				>
					{`{{${name}}}`}
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-xs">
				<span className="flex items-baseline gap-2">
					<span className="break-all">{description}</span>
					<span className="shrink-0 text-primary-foreground/70">generated per use</span>
				</span>
			</TooltipContent>
		</Tooltip>
	);
}
