
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * VariablesTab — reuses VariableTableEditor in embedded mode so the inline
 * "new row" UX matches the Variables screen, but rendered headless so the
 * Collection Detail screen's own header/banner aren't duplicated.
 */

import VariableTableEditor from "@/modules/variables/main/VariableTableEditor";
import type { Collection } from "@/types";
import { InfoBanner } from "./shared";

interface VariablesTabProps {
	collection: Collection;
}

export default function VariablesTab({ collection }: VariablesTabProps) {
	return (
		<div className="max-w-[720px] flex flex-col gap-4">
			<InfoBanner>
				Collection variables are scoped to this collection and its sub-folders. Reference them
				with{" "}
				<code className="font-mono text-[11px] bg-accent px-1 rounded-sm">{`{{variable}}`}</code>{" "}
				in URLs, headers, body, and scripts. Environment variables take precedence.
			</InfoBanner>

			<VariableTableEditor config={{ type: "collection", collection }} embedded />
		</div>
	);
}
