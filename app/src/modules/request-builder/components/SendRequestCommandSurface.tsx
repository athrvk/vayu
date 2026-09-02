/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request builder's second contribution to the command registry: "send what
 * is on screen right now" (#1243).
 *
 * A component rather than a hook call in `RequestBuilder`, for the reason
 * `LoadTestCommandSurface` beside it gives: the handler it publishes lives
 * *inside* `RequestBuilderProvider`, and the builder's own component sits
 * outside the provider it renders.
 *
 * It renders nothing, and it is mounted from `modules/request-builder/index.tsx`
 * alone - `DesignRunView`'s detached copy of a past run simply does not render
 * it, so "exactly one contributor" holds by construction rather than by a
 * runtime guard.
 *
 * **The contribution is withdrawn while a send would be refused.** Unlike the
 * load test, whose gate is a property of the builder (a detached copy has no
 * handler at all), Send's gate moves during a session: it is unavailable with an
 * empty URL and for the whole of an open stream, where the button in front of
 * the user reads Stop. Passing `null` there takes the palette row away with it,
 * rather than leaving a row that would answer to nothing.
 */

import { useCallback } from "react";
import { useRegisterSendRequestSurface } from "@/lib/commands";
import { useRequestBuilderContext } from "../context";
import { canSendRequest } from "../utils/send-gate";

export default function SendRequestCommandSurface(): null {
	const { request, isExecuting, isStreaming, executeRequest } = useRequestBuilderContext();

	// No row: Send-with-row is a distinct action with its own picker, and a
	// palette row that silently re-bound the last row would be sending something
	// other than what it says. `executeRequest` un-binds it, as the chord does.
	const send = useCallback(() => void executeRequest(), [executeRequest]);

	const sendable = canSendRequest({ url: request.url, isExecuting, isStreaming });
	useRegisterSendRequestSurface(sendable ? send : null);

	return null;
}
