/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request builder's contribution to the command registry: "start a load
 * test for what is on screen right now".
 *
 * A component rather than a hook call in `RequestBuilder`, because the handler
 * it publishes lives *inside* `RequestBuilderProvider` - `startLoadTest` closes
 * over the live draft, and the builder's own component sits outside the
 * provider it renders. Mounting a child that reads the context is how anything
 * else here reaches the draft too.
 *
 * It renders nothing, and it is mounted from `modules/request-builder/index.tsx`
 * alone. `DesignRunView` also mounts a `RequestBuilderProvider` - a detached
 * copy of a past run, deliberately without an `onStartLoadTest` handler - and
 * simply does not render this, so "exactly one contributor" holds by
 * construction rather than by a runtime guard.
 */

import { useRegisterLoadTestSurface } from "@/lib/commands";
import { useRequestBuilderContext } from "../context";

export default function LoadTestCommandSurface(): null {
	const { startLoadTest } = useRequestBuilderContext();
	useRegisterLoadTestSurface(startLoadTest);
	return null;
}
