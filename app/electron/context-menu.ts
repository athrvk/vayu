/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The menu a right-click opens, everywhere Monaco does not draw one (#1359).
 *
 * Electron renders no context menu of its own, so until this existed a
 * right-click on the URL bar, a header value, a variable row or a dialog input
 * showed nothing: there was no mouse route to Paste in the field the app is
 * pasted into most. Monaco carries its own menu, which made the body pane behave
 * differently from the header row above it - breakage rather than design.
 *
 * Two processes hold half the answer each, which is what this module's shape is
 * about:
 *
 * - **Chromium knows the editing state.** `isEditable`, the selection, the link
 *   under the pointer and which of Cut / Copy / Paste can act right now arrive
 *   in the `context-menu` params. Nothing here re-derives them.
 * - **The renderer knows the Vayu meaning.** That the field is the URL bar, that
 *   the pointer is on a `{{token}}`, that this is a Monaco editor: none of it is
 *   visible from the main process. The renderer announces it from its own
 *   `contextmenu` listener (see `src/lib/context-menu.ts`), and this module
 *   consumes that announcement once.
 *
 * Kept out of main.ts so it can be tested, the way `window-navigation.ts` is:
 * main.ts creates windows and starts the engine at import time, which no unit
 * test can do. `menuTemplateFor` is the whole decision and takes no Electron
 * type, so every row of the table in #1359 is a unit test rather than a
 * screenshot.
 */

/** Where the pointer is, in Vayu's terms rather than Chromium's. */
export type ContextKind = "url-bar" | "monaco";

/**
 * What the renderer says sits under the pointer.
 *
 * Only what the main process cannot see itself: a read-only surface needs no
 * marker, because `selectionText` already answers it, and neither does a plain
 * editable field, because `isEditable` does.
 */
export interface ContextTarget {
	/** The marked ancestor's kind, or `null` where there is no marker. */
	kind: ContextKind | null;
	/** The `{{token}}` under the pointer, by name, or `null`. */
	variable: string | null;
}

/** No announcement, or one that did not survive validation. */
export const NO_CONTEXT_TARGET: ContextTarget = { kind: null, variable: null };

/** The slice of Electron's `ContextMenuParams` this reads, so a test can pass a fake. */
export interface ContextMenuParams {
	isEditable: boolean;
	selectionText: string;
	linkURL: string;
	editFlags: {
		canCut: boolean;
		canCopy: boolean;
		canPaste: boolean;
		canSelectAll: boolean;
	};
}

/** An item's action, as data rather than a closure, so a template can be asserted. */
export type ContextCommand =
	| { type: "import-command"; text: string }
	| { type: "edit-variable"; name: string }
	| { type: "copy-link"; url: string }
	| { type: "open-link"; url: string };

/**
 * One row of the menu.
 *
 * The edit items are Electron roles rather than handlers of ours, for the same
 * reason the application menu's Edit items are (`main.ts`): a role edits through
 * the focused web contents, so the field's own undo history stays intact, and
 * the OS supplies the accelerator it prints beside the label. An app-drawn
 * accelerator here would be a second source of truth for a chord the platform
 * already owns.
 */
export type ContextMenuItem =
	| { kind: "role"; role: "cut" | "copy" | "paste" | "selectAll"; enabled: boolean }
	| { kind: "separator" }
	| { kind: "command"; label: string; command: ContextCommand };

/** The shell command a clipboard's text would import, or `null` for ordinary text. */
export type ClipboardCommand = "curl" | "wget";

/**
 * Whether the clipboard holds a command the request builder can import.
 *
 * Duplicated from `detectCommand` in `src/services/curl/parseCurl.ts`, which is
 * the parser this offer hands the text to: `tsconfig.node.json` has no `@/*`
 * mapping, so the main process cannot import a renderer module (see
 * `tsconfig.electron-test.json` for why that boundary is deliberate). The two
 * copies are held together by a test that drives both with the same table.
 */
export function commandOnClipboard(text: string): ClipboardCommand | null {
	const stripped = text.trim().replace(/^[$>]\s+/, "");
	const first = stripped.split(/\s/, 1)[0]?.toLowerCase();
	if (first === "curl") return "curl";
	if (first === "wget") return "wget";
	return null;
}

/**
 * Whether a link is one the OS should be asked to open.
 *
 * A `context-menu` link URL is whatever the document says it is, so the offer is
 * limited to the two schemes a browser answers for. Anything else - a `file:`
 * target, a protocol handler - is not opened and not offered, rather than
 * offered and then refused.
 */
export function isBrowsableUrl(value: string): boolean {
	let protocol: string;
	try {
		protocol = new URL(value).protocol;
	} catch {
		return false;
	}
	return protocol === "http:" || protocol === "https:";
}

/**
 * Validate an announcement from the renderer.
 *
 * A menu decoration is not worth throwing over: an announcement that does not
 * parse means the extras are absent and the plain edit menu still opens, which
 * is the same outcome as a right-click on an unmarked field. Anything wider
 * would let a malformed message cost the user their menu.
 */
export function readContextTarget(value: unknown): ContextTarget {
	if (typeof value !== "object" || value === null) return NO_CONTEXT_TARGET;
	const source = value as { kind?: unknown; variable?: unknown };
	const kind = source.kind === "url-bar" || source.kind === "monaco" ? source.kind : null;
	const variable =
		typeof source.variable === "string" && source.variable ? source.variable : null;
	return { kind, variable };
}

function roleItem(role: "cut" | "copy" | "paste" | "selectAll", enabled: boolean): ContextMenuItem {
	return { kind: "role", role, enabled };
}

/** Groups, joined by one separator each, with the empty ones dropped. */
function joinGroups(groups: ContextMenuItem[][]): ContextMenuItem[] {
	const filled = groups.filter((group) => group.length > 0);
	return filled.flatMap((group, index) =>
		index === 0 ? group : [{ kind: "separator" } as ContextMenuItem, ...group]
	);
}

/** The edit items and the Vayu offers that only an editable field can carry. */
function editableGroups(
	params: ContextMenuParams,
	target: ContextTarget,
	readClipboardText: () => string
): ContextMenuItem[][] {
	const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags;
	const extras: ContextMenuItem[] = [];

	// The URL bar already imports a curl or wget command that is *pasted* into it
	// (`UrlInput.tsx`). This makes that behaviour discoverable rather than adding
	// a second one, and it is offered nowhere else: a header value holding a
	// command is text, not a request. Read behind that test rather than before
	// it, so an ordinary right-click does not touch the clipboard at all.
	const clipboardText = target.kind === "url-bar" ? readClipboardText() : "";
	const command = clipboardText ? commandOnClipboard(clipboardText) : null;
	if (command) {
		extras.push({
			kind: "command",
			label: `Paste as ${command}`,
			command: { type: "import-command", text: clipboardText },
		});
	}
	if (target.variable) {
		extras.push({
			kind: "command",
			label: "Edit variable",
			command: { type: "edit-variable", name: target.variable },
		});
	}

	return [
		[roleItem("cut", canCut), roleItem("copy", canCopy), roleItem("paste", canPaste)],
		[roleItem("selectAll", canSelectAll)],
		extras,
	];
}

/**
 * The menu for one right-click, or an empty template where the app shows none.
 *
 * Empty in two cases, and they are different refusals: inside a Monaco editor
 * the editor's own menu is the answer, and on empty chrome with nothing
 * selected there is nothing to offer, which is what a native app does.
 */
export function menuTemplateFor(
	params: ContextMenuParams,
	target: ContextTarget,
	readClipboardText: () => string
): ContextMenuItem[] {
	if (target.kind === "monaco") return [];

	const linkGroup: ContextMenuItem[] =
		params.linkURL && isBrowsableUrl(params.linkURL)
			? [
					{
						kind: "command",
						label: "Copy Link",
						command: { type: "copy-link", url: params.linkURL },
					},
					{
						kind: "command",
						label: "Open in Browser",
						command: { type: "open-link", url: params.linkURL },
					},
				]
			: [];

	if (params.isEditable) {
		return joinGroups([...editableGroups(params, target, readClipboardText), linkGroup]);
	}

	// Read-only text: Copy, and only when there is something to copy. No marker
	// says a surface is read-only, because the selection already does.
	const selectionGroup: ContextMenuItem[] = params.selectionText
		? [roleItem("copy", params.editFlags.canCopy)]
		: [];
	return joinGroups([selectionGroup, linkGroup]);
}

/**
 * The last announcement, consumed by the menu it belongs to.
 *
 * Consume-once is the whole point: the renderer announces from its `contextmenu`
 * listener, which runs before the native event this pairs it with, so the value
 * waiting here is always the one for the click being answered. Clearing it on
 * read means a native event that arrives without an announcement gets the plain
 * menu rather than the previous click's extras.
 */
export interface ContextTargetStore {
	announce(value: unknown): void;
	take(): ContextTarget;
}

export function createContextTargetStore(): ContextTargetStore {
	let announced: ContextTarget | null = null;
	return {
		announce(value: unknown) {
			announced = readContextTarget(value);
		},
		take() {
			const target = announced ?? NO_CONTEXT_TARGET;
			announced = null;
			return target;
		},
	};
}

/** What running a command needs, so a test can pass fakes for all three. */
export interface CommandEffects {
	writeClipboard(text: string): void;
	openExternal(url: string): void;
	sendToRenderer(command: ContextCommand): void;
}

/**
 * Run one menu command.
 *
 * The two link actions are the main process's own; the two Vayu offers are the
 * renderer's, because importing a command rewrites the request in the store and
 * editing a variable opens the popover the token opens on click. Main forwards
 * them rather than reaching for a second way to do either.
 */
export function runContextCommand(command: ContextCommand, effects: CommandEffects): void {
	switch (command.type) {
		case "copy-link":
			effects.writeClipboard(command.url);
			return;
		case "open-link":
			effects.openExternal(command.url);
			return;
		case "import-command":
		case "edit-variable":
			effects.sendToRenderer(command);
			return;
	}
}

/** The slice of `WebContents` this needs, so a test can pass a fake. */
export interface ContextMenuContents {
	on(
		event: "context-menu",
		listener: (event: unknown, params: ContextMenuParams) => void
	): unknown;
}

export interface ContextMenuDeps {
	/** The announcement for this click, cleared as it is read. */
	takeTarget(): ContextTarget;
	/** The system clipboard's text, read only where an offer depends on it. */
	readClipboardText(): string;
	/** Build and pop the menu. Never called with an empty template. */
	showMenu(items: ContextMenuItem[]): void;
}

/**
 * A template row in the shape `Menu.buildFromTemplate` takes.
 *
 * Spelled out rather than imported from `electron` so the decision above stays
 * free of Electron's types and its items stay comparable by value: a `click`
 * closure is the one thing a test cannot assert, which is why it is attached
 * here and nowhere earlier.
 */
export interface ElectronMenuItem {
	role?: "cut" | "copy" | "paste" | "selectAll";
	type?: "separator";
	label?: string;
	enabled?: boolean;
	click?: () => void;
}

/** Hand the decided menu to Electron, binding each command to `run`. */
export function toElectronTemplate(
	items: ContextMenuItem[],
	run: (command: ContextCommand) => void
): ElectronMenuItem[] {
	return items.map((item) => {
		if (item.kind === "separator") return { type: "separator" as const };
		if (item.kind === "role") return { role: item.role, enabled: item.enabled };
		return { label: item.label, click: () => run(item.command) };
	});
}

/** Answer this window's right-clicks with the menu the pointer's context earns. */
export function installContextMenu(contents: ContextMenuContents, deps: ContextMenuDeps): void {
	contents.on("context-menu", (_event, params) => {
		const items = menuTemplateFor(params, deps.takeTarget(), () => deps.readClipboardText());
		if (items.length === 0) return;
		deps.showMenu(items);
	});
}
