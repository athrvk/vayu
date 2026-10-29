/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Callout } from "@/components/shared";
import type { RefReport } from "@/services/importers/ref-bundler";
import { pluralize } from "@/modules/dashboard/utils/format";

/**
 * What bundling a spec's external `$ref`s did and did not manage, shown beside
 * the document it was done to: the references that could not be followed, named
 * where the bundler knows why, and the remote files it pulled in. Shared by the
 * Sync comparison and the Spec tab's pick (#3032), which bundle the same way.
 *
 * @param missingFrom what the unfollowed references leave incomplete, finishing
 * the sentence "whatever they describe is missing from ..."
 */
export default function RefDisclosure({
	unresolvedRefs,
	refReport,
	missingFrom,
}: {
	unresolvedRefs: number;
	refReport: RefReport;
	missingFrom: string;
}) {
	return (
		<>
			{unresolvedRefs > 0 && (
				<Callout severity="warning" title="Couldn't read some references">
					{unresolvedRefs} {pluralize(unresolvedRefs, "reference")} to another file
					couldn&apos;t be followed, so whatever they describe is missing from{" "}
					{missingFrom}.
					{refReport.refused.map(({ target, reason }) => (
						<span key={target} className="block">
							Not followed: {target} ({reason})
						</span>
					))}
				</Callout>
			)}
			{refReport.fetched.length > 0 && (
				<p className="text-label text-muted-foreground">
					Fetched from: {refReport.fetched.join(", ")}
				</p>
			)}
		</>
	);
}
