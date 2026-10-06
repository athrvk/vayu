/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SaveAgentRunButton
 *
 * "Save to request" for a run an agent started that no saved request stands
 * behind (issue #1817). It is the header's primary action there: the run is the
 * only record of what was sent, and Save is how it stops being disposable.
 *
 * The flow is `useNewRequest`'s, not a copy of it: the last-used collection
 * when there is one, a new collection when there are none, the picker when it
 * would be a guess - and the new request opens in its own tab, which is the
 * confirmation. The run itself is an immutable record and keeps its null
 * `requestId`, so the button stays: a second press saves a second copy, which
 * is what pressing it twice asks for.
 *
 * Mounted only for such a run, so no other run view pays for the hook's
 * collections query.
 */

import { Save } from "lucide-react";
import { Button, ICON_MOTION } from "@/components/ui";
import { useNewRequest } from "@/hooks/useNewRequest";
import { CollectionPicker } from "@/modules/welcome/components/CollectionPicker";
import type { Run } from "@/types";
import type { DesignRunSeed } from "./design-run-seed";
import { presetFromRun } from "./save-run-as-request";

interface SaveAgentRunButtonProps {
	run: Run;
	seed: DesignRunSeed;
}

export default function SaveAgentRunButton({ run, seed }: SaveAgentRunButtonProps) {
	const { newRequest, pickerProps } = useNewRequest();

	return (
		<>
			<Button size="sm" onClick={() => newRequest(presetFromRun(run, seed))}>
				<Save className="size-icon-sm mr-1.5" data-icon-motion={ICON_MOTION.press} />
				Save to request
			</Button>
			<CollectionPicker {...pickerProps} />
		</>
	);
}
