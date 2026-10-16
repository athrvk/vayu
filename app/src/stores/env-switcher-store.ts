/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { create } from "zustand";

/**
 * Whether the title bar's environment menu is open (#2115).
 *
 * The menu is a Radix DropdownMenu, which owns its own open state unless it is
 * handed one. A toast action raised from outside the title bar (the import's
 * "Choose environment") has no other way to open it, so `TitleBar` binds the
 * menu to this flag, and the menu's own open and close writes land here too.
 */
interface EnvSwitcherState {
	isOpen: boolean;
	setOpen: (open: boolean) => void;
}

export const useEnvSwitcherStore = create<EnvSwitcherState>((set) => ({
	isOpen: false,
	setOpen: (isOpen) => set({ isOpen }),
}));
