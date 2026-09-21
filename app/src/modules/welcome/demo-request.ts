/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the Launcher's "Open Demo API" tile creates (issue #1694).
 *
 * A public, stable, CORS-open GET that always answers the same small JSON
 * body - no account, no key, nothing for the click to explain. Kept as its
 * own module rather than inlined in `DemoApiTile.tsx` so a test can assert on
 * the URL without parsing the component that renders the tile.
 */

import type { RequestPreset } from "@/hooks/useNewRequest";

export const DEMO_REQUEST_PRESET: RequestPreset = {
	name: "Demo: get a todo",
	method: "GET",
	url: "https://jsonplaceholder.typicode.com/todos/1",
};
