/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The seam a drawer item calls once it has opened or switched a tab (#3507).
 *
 * The drawer overlay closes on a selection, and a selection is not something
 * the drawer can observe: watching `activeTabId` also fires for closing a tab,
 * Back, rehydration and every chord, none of which is a pick from the list. So
 * the handlers that mean "open this" say so, through this context. Outside a
 * `Drawer` - a view rendered on its own, a test - and in push mode the
 * callback is a no-op.
 */

import { createContext, useContext } from "react";

const noop = () => {};

const DrawerItemOpenedContext = createContext<() => void>(noop);

export const DrawerItemOpenedProvider = DrawerItemOpenedContext.Provider;

/** Call after the tab is opened (`openTab`), never for a duplicate or an undo. */
export function useDrawerItemOpened(): () => void {
	return useContext(DrawerItemOpenedContext);
}
