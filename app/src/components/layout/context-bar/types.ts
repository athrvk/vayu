/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ComponentType } from "react";
import type { Tab } from "@/stores";

/** What every section is handed: the tab it is describing. */
export interface ContextBarSectionProps {
	tab: Tab;
}

/**
 * One entry in the bar's section registry.
 *
 * Sections are leaf components over the existing query layer - there is no
 * shared bar-wide state for them to coordinate through, deliberately. A section
 * that needs data asks for it with the same hook any other surface would use,
 * and mounts only while it is expanded, so a bar the user leaves open costs
 * nothing for the sections they keep collapsed.
 */
export interface ContextBarSection {
	/** Stable across releases - it is the key the collapsed state persists under. */
	id: string;
	title: string;
	/**
	 * Whether this section has anything to say about this tab. Takes the whole
	 * tab, not just its type, because Phase 2's collection and run sections turn
	 * on the entity as well.
	 */
	appliesTo: (tab: Tab) => boolean;
	Component: ComponentType<ContextBarSectionProps>;
}
