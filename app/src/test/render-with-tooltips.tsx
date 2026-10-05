/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Testing Library's `render`, inside the `TooltipProvider` the app mounts at its
 * root. A component that shows a time renders `TimeValue`, whose card is a Radix
 * `Tooltip`, and Radix throws without a provider above it - so a test of a
 * surface that shows a time renders through this instead of wrapping each call.
 * `rerender` keeps the wrapper.
 */

import { render as rtlRender, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

export function render(ui: ReactElement, options?: Omit<RenderOptions, "queries">) {
	return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}
