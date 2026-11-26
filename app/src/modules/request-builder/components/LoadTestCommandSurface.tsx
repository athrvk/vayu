/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The builder's command-registry entry: "start a load test for what is on screen". A component, not
 * a hook in `RequestBuilder`, because the handler lives *inside* `RequestBuilderProvider`
 * (`startLoadTest` closes over the live draft) and the builder's own component sits outside the
 * provider it renders. Renders nothing; mounted only from `modules/request-builder/index.tsx`.
 * `DesignRunView` also mounts a provider (a detached copy of a past run, with no `onStartLoadTest`)
 * and does not render this, so "exactly one contributor" holds by construction, not a runtime
 * guard.
 */

import { useRegisterLoadTestSurface } from "@/lib/commands";
import { useRequestBuilderContext } from "../context";

export default function LoadTestCommandSurface(): null {
	const { startLoadTest } = useRequestBuilderContext();
	useRegisterLoadTestSurface(startLoadTest);
	return null;
}
