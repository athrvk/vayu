/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request builder's editor state, published for the context bar's Code
 * section (#2638), which sits outside `RequestBuilderProvider` and would
 * otherwise see only the saved row.
 *
 * A component for the reason `LoadTestCommandSurface` gives: the draft lives
 * inside the provider. It renders nothing and is mounted from
 * `modules/request-builder/index.tsx` alone, so `DesignRunView`'s detached copy
 * of a past run never stands in for the request on the tab.
 *
 * The chain is read from the draft's own collection, the one the provider was
 * handed and Send composes with.
 */

import { useMemo } from "react";
import { useCollectionAncestors } from "@/queries";
import { useRegisterEditorDraftSurface } from "@/lib/commands";
import { useRequestBuilderContext } from "../context";

export default function EditorDraftSurface(): null {
	const { request } = useRequestBuilderContext();
	const ancestors = useCollectionAncestors(request.collectionId);
	const draft = useMemo(() => ({ request, ancestors }), [request, ancestors]);
	useRegisterEditorDraftSurface(draft);
	return null;
}
