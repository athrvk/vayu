/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The builder's second command-registry entry: "send what is on screen" (#1243). A component for
 * `LoadTestCommandSurface`'s reason: the handler lives inside `RequestBuilderProvider`, outside
 * which the builder's own component sits. Renders nothing; mounted only from
 * `modules/request-builder/index.tsx`, and `DesignRunView`'s detached copy does not render it, so
 * "exactly one contributor" holds by construction.
 *
 * **The entry is withdrawn while a send would be refused.** Unlike the load test's gate (a property
 * of the builder), Send's moves during a session: unavailable with an empty URL and for a whole
 * open stream, where the button reads Stop. Passing `null` removes the palette row rather than
 * leave one that answers to nothing.
 */

import { useCallback } from "react";
import { useRegisterSendRequestSurface } from "@/lib/commands";
import { useRequestBuilderContext } from "../context";
import { canSendRequest } from "../utils/send-gate";

export default function SendRequestCommandSurface(): null {
	const { request, isExecuting, isStreaming, executeRequest } = useRequestBuilderContext();

	// No row: Send-with-row is its own action with a picker, and a palette row silently re-binding
	// the last row would send something other than it says. `executeRequest` un-binds it, as the
	// chord does.
	const send = useCallback(() => void executeRequest(), [executeRequest]);

	const sendable = canSendRequest({ url: request.url, isExecuting, isStreaming });
	useRegisterSendRequestSurface(sendable ? send : null);

	return null;
}
