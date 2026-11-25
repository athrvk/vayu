/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The command registry, as palette results. A plain function, not a hook like its siblings: it owns
 * no data, only maps `lib/commands` onto `PaletteItem`, because the palette reaches commands rather
 * than defining actions.
 *
 * Unavailable commands never reach the list: a row that can do nothing looks like a broken app, not
 * like an action that wants a collection open.
 */

import { availableCommands, commandTitle, type CommandContext } from "@/lib/commands";
import type { PaletteItem } from "../types";

export function commandItems(ctx: CommandContext): PaletteItem[] {
	return availableCommands(ctx).map((command) => ({
		id: `command:${command.id}`,
		kind: command.group === "settings" ? ("settings" as const) : ("command" as const),
		title: commandTitle(command, ctx),
		...(command.subtitle ? { subtitle: command.subtitle } : {}),
		keywords: [...command.keywords],
		...(command.substringKeywords?.length
			? { substringKeywords: [...command.substringKeywords] }
			: {}),
		icon: command.icon,
		...(command.shortcut ? { shortcut: command.shortcut } : {}),
		perform: () => command.perform(ctx),
	}));
}
