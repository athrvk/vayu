/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * EditableVariable Component
 *
 * A clickable `{{variable}}` token, inline in a URL or header value.
 * - Hover (after a debounce) opens the real, full popover - inert, so resting
 *   the pointer never steals focus or risks an edit
 * - Click places a caret in the token's text; it opens nothing by itself
 * - Enter/Space opens the popover focused, for a keyboard user who has no hover
 * - Colour reflects whether the variable resolves at all
 *
 * This is the request-builder half of the pair: `VariablePopover` lives in
 * `components/ui` and takes everything as props, so the context reads that feed
 * it - the other definitions of this name, and the scopes a new one could be
 * written to - happen here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { VariablePopover } from "@/components/ui";
import type { VariableScope } from "@/components/ui";
import { cn } from "@/lib/utils";
import { variableProps } from "@/lib/context-menu";
import { TIMING } from "@/config/timing";
// The specific module, not the `../../context` barrel - matching the sibling
// `VariableInput/index.tsx`, whose tests mock this exact path.
import type { VariableScope as RequestBuilderVariableScope, VariableSupport } from "@/types";

export interface EditableVariableProps {
	/** Variable name */
	name: string;
	/** Variable value */
	value: string;
	/** Variable scope */
	scope: RequestBuilderVariableScope;
	/** Whether the variable is resolved (exists) */
	resolved: boolean;
	/** Callback when variable value changes */
	onValueChange?: (name: string, value: string, scope: RequestBuilderVariableScope) => void;
	/** Whether editing is disabled */
	disabled?: boolean;
	/** True when the value is a secret, so hover must not print it. */
	secret?: boolean;
	/** The environment or collection it came from. Absent for globals. */
	sourceName?: string;
	/**
	 * The scope this token belongs to. Required, not optional as it is further
	 * up: a token only renders where there *is* a scope, so the popover always
	 * has origins to list and writable targets to offer (#564).
	 */
	variables: VariableSupport;
	/**
	 * Position in the host field's roving tab order (issue #1215). `VariableInput`
	 * paints a strip of these over one input and gives exactly one of them the
	 * Tab stop. Left at `0` for a token rendered on its own.
	 */
	tabIndex?: number;
}

/** Where `VariablePopover` renders its content - see `variable-popover.tsx`. */
const POPOVER_CONTENT_SELECTOR = '[data-slot="popover-content"]';

/** How the popover currently open over this token got there. */
type OpenMode = { reason: "hover" | "keyboard" } | null;

export default function EditableVariable({
	name,
	value,
	scope,
	resolved,
	onValueChange,
	disabled = false,
	secret = false,
	sourceName,
	variables,
	tabIndex,
}: EditableVariableProps) {
	const { getVariableOrigins, writableScopes } = variables;
	const origins = getVariableOrigins(name);

	const varInfo = resolved ? { value, scope: scope as VariableScope, secret, sourceName } : null;

	const handleValueChange = onValueChange
		? (varName: string, varValue: string, varScope: VariableScope) => {
				onValueChange(varName, varValue, varScope as RequestBuilderVariableScope);
			}
		: undefined;

	const [openMode, setOpenMode] = useState<OpenMode>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

	const clearHoverTimer = useCallback(() => clearTimeout(hoverTimer.current), []);
	const clearCloseTimer = useCallback(() => clearTimeout(closeTimer.current), []);

	const openWith = useCallback(
		(reason: "hover" | "keyboard") => {
			clearCloseTimer();
			setOpenMode({ reason });
		},
		[clearCloseTimer]
	);

	/**
	 * Closes a hover-opened popover once the pointer has been off both the token
	 * and the popover's own content for the grace period - unless the reader has
	 * focused into it, which means they are reading or editing it rather than
	 * having merely brushed past. A keyboard-opened popover never reaches this:
	 * `handleMouseLeave` only arms it for the hover reason.
	 */
	const scheduleClose = useCallback(() => {
		clearCloseTimer();
		closeTimer.current = setTimeout(() => {
			const content = document.querySelector<HTMLElement>(POPOVER_CONTENT_SELECTOR);
			if (content && content.contains(document.activeElement)) return;
			setOpenMode(null);
		}, TIMING.VARIABLE_POPOVER_LEAVE_GRACE_MS);
	}, [clearCloseTimer]);

	const handleMouseEnter = useCallback(() => {
		clearCloseTimer();
		if (disabled || openMode) return;
		clearHoverTimer();
		hoverTimer.current = setTimeout(() => openWith("hover"), TIMING.TOOLTIP_DELAY_MS);
	}, [disabled, openMode, clearCloseTimer, clearHoverTimer, openWith]);

	const handleMouseLeave = useCallback(() => {
		clearHoverTimer();
		if (openMode?.reason === "hover") scheduleClose();
	}, [openMode, clearHoverTimer, scheduleClose]);

	/*
	 * What the permanent listener below reads - kept in a ref rather than a
	 * dependency, because the listener is attached once for the component's
	 * life (see its own comment) and must not go stale between renders.
	 */
	const openModeRef = useRef(openMode);
	useEffect(() => {
		openModeRef.current = openMode;
	}, [openMode]);

	/*
	 * The popover's own content is portalled well outside this token's subtree,
	 * so the grace period has to be told directly when the pointer is over it -
	 * a leave off the token alone would otherwise close the popover the reader
	 * just moved into, to click its value field or read a shadowed definition.
	 *
	 * Delegated on `document`, permanently, rather than a per-open effect that
	 * looks the content up once it is open: Radix portals that content in on
	 * its own schedule, which does not necessarily land in the DOM by the time
	 * this component's own effect runs after the state change that opened it -
	 * a real race, not a hypothetical one. `mouseover`/`mouseout` bubble
	 * (unlike `mouseenter`/`mouseleave`), so a listener attached once, before
	 * any token ever opens, still catches every entry and exit of whichever
	 * content is on screen at the time.
	 */
	useEffect(() => {
		const isInContent = (node: EventTarget | null): boolean =>
			node instanceof Element && node.closest(POPOVER_CONTENT_SELECTOR) !== null;
		const onMouseOver = (e: MouseEvent) => {
			if (isInContent(e.target)) clearCloseTimer();
		};
		const onMouseOut = (e: MouseEvent) => {
			// Only the moment of actually leaving the content - not a move
			// between two elements both inside it, which fires the same event.
			if (isInContent(e.target) && !isInContent(e.relatedTarget)) {
				if (openModeRef.current?.reason === "hover") scheduleClose();
			}
		};
		document.addEventListener("mouseover", onMouseOver);
		document.addEventListener("mouseout", onMouseOut);
		return () => {
			document.removeEventListener("mouseover", onMouseOver);
			document.removeEventListener("mouseout", onMouseOut);
		};
	}, [clearCloseTimer, scheduleClose]);

	useEffect(
		() => () => {
			clearHoverTimer();
			clearCloseTimer();
		},
		[clearHoverTimer, clearCloseTimer]
	);

	/*
	 * `font-[inherit]`, matching the plain-text segments beside it.
	 *
	 * This used to hardcode `ui-monospace, SFMono-Regular, 'SF Mono', Menlo,
	 * Consolas, 'Liberation Mono', monospace` under a comment saying "same
	 * monospace font as input for consistent character widths" - and that stack
	 * does not contain the app's mono font. `--font-mono` is `"JetBrains Mono",
	 * "Consolas", "Monaco", monospace`, so a variable token rendered in a
	 * different typeface from the text either side of it.
	 *
	 * That matters beyond looks. `VariableInput` paints this overlay on top of a
	 * transparent <input>, and the caret the user steers by belongs to the input.
	 * Any width difference between the two fonts walks the caret away from the
	 * glyphs it appears to sit between - which is exactly the drift the comment
	 * was trying to prevent.
	 */
	const token = (
		<span
			className="font-[inherit]"
			contentEditable={false}
			suppressContentEditableWarning
			// Names the token for the right-click menu's "Edit variable", which
			// opens this popover by clicking the trigger this span sits in (#1359).
			{...variableProps(name)}
		>
			{`{{${name}}}`}
		</span>
	);

	return (
		<VariablePopover
			// One persistent instance for the token's whole life (issue #1220
			// leave-grace flicker): mounting a fresh one per open, keyed to force
			// a remount, replaced this exact trigger's DOM node while the pointer
			// was resting on it. The browser reports that as the old node being
			// left and the new one entered, which retriggered `handleMouseEnter`/
			// `handleMouseLeave` and produced a hover-open/close loop - visible as
			// the token's background repeatedly flashing rather than settling.
			// `open`/`focusOnOpen` below drive this same instance instead.
			tabIndex={tabIndex}
			name={name}
			varInfo={varInfo}
			resolved={resolved}
			onValueChange={handleValueChange}
			saveMode="auto"
			disabled={disabled}
			origins={origins}
			writableScopes={writableScopes}
			open={openMode !== null}
			focusOnOpen={openMode?.reason === "keyboard"}
			onOpenChange={(open) => {
				if (open) {
					// Only reachable from this trigger's own Enter/Space, or the
					// right-click menu's "Edit variable" dispatching a marked
					// click (`lib/context-menu.ts`) - hover drives `openMode`
					// directly and never reaches here. Both are a deliberate,
					// explicit request with no hover state behind them, so both
					// need a focused open, the same as the keyboard chord.
					if (openMode === null) openWith("keyboard");
					return;
				}
				setOpenMode(null);
			}}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
			trigger={token}
			triggerClassName={cn(
				"inline cursor-pointer transition-colors rounded-md",
				!resolved
					? "text-destructive-text hover:bg-destructive-text/10"
					: !value
						? "text-muted-foreground hover:bg-muted"
						: "text-primary hover:bg-primary/10",
				disabled && "cursor-default opacity-50"
			)}
		/>
	);
}
