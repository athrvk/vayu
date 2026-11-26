/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The builder's editor state, published for the context bar's Code section (#2638), which sits
 * outside `RequestBuilderProvider` and would otherwise see only the saved row. A component, as
 * `LoadTestCommandSurface` explains: the draft lives inside the provider. Renders nothing and is
 * mounted only from `modules/request-builder/index.tsx`, so `DesignRunView`'s detached copy never
 * stands in for the tab's request. The chain is read from the draft's own collection (the one Send
 * composes with), and the element catalogue is the one Send judges elements by (#3066).
 */

import { useMemo } from "react";
import { useCollectionAncestors, useElementKindsQuery } from "@/queries";
import { useRegisterEditorDraftSurface } from "@/lib/commands";
import type { ElementKindSchema } from "@/types";
import { useRequestBuilderContext } from "../context";

const NO_KINDS: ElementKindSchema[] = [];

export default function EditorDraftSurface(): null {
	const { request } = useRequestBuilderContext();
	const ancestors = useCollectionAncestors(request.collectionId);
	const { data: kinds } = useElementKindsQuery();
	const elementKinds = kinds ?? NO_KINDS;
	const draft = useMemo(
		() => ({ request, ancestors, elementKinds }),
		[request, ancestors, elementKinds]
	);
	useRegisterEditorDraftSurface(draft);
	return null;
}
