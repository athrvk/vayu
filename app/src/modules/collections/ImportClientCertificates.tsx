/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The client certificates a Postman import offers to register (issue #2363).
 *
 * A registered certificate is host-wide: every later request to that host, from
 * any collection, presents it and signs the handshake with its key, and the
 * row stays after the collection is gone. The document chose the host and the
 * path, so each candidate is listed with both and registers only when ticked.
 * The passphrase is never shown, and the key is shown as a path and nothing
 * more.
 */

import { Checkbox } from "@/components/ui";
import { certificateCandidates } from "@/services/importers/client-certificate-selection";
import { entryLabel, type BatchEntry } from "@/services/importers/batch";
import type { ImportApplyClientCertificate } from "@/types";

interface ImportClientCertificatesProps {
	/** The entries the apply will send; one with no candidates contributes nothing. */
	entries: readonly BatchEntry[];
	disabled: boolean;
	onToggle: (entryId: string, index: number, ticked: boolean) => void;
}

/** "host" or "host:port": the (host, port) the registry row would match. */
function endpoint({ host, port }: ImportApplyClientCertificate): string {
	return port === undefined ? host : `${host}:${port}`;
}

export function ImportClientCertificates({
	entries,
	disabled,
	onToggle,
}: ImportClientCertificatesProps) {
	const offering = entries
		.map((entry) => ({
			entry,
			candidates: entry.result ? certificateCandidates(entry.result) : [],
		}))
		.filter(({ candidates }) => candidates.length > 0);
	if (offering.length === 0) return null;
	// A file name only when it tells groups apart: one file's candidates need no heading.
	const named = entries.length > 1;

	return (
		<fieldset className="flex max-h-32 min-w-0 flex-col gap-1.5 overflow-y-auto text-label text-muted-foreground">
			<legend className="font-medium text-foreground">Client certificates</legend>
			<p>
				Registered for every request to that host, not only this collection. Leave one
				unticked to add it in Settings later.
			</p>
			{offering.map(({ entry, candidates }) => (
				<div key={entry.id} className="flex flex-col gap-1">
					{named && (
						<span className="font-medium text-foreground">{entryLabel(entry)}</span>
					)}
					{candidates.map((candidate, index) => (
						<label key={index} className="flex w-fit items-start gap-1.5">
							<Checkbox
								className="size-target"
								checked={entry.selectedCertificates?.includes(index) ?? false}
								disabled={disabled}
								onChange={(e) => onToggle(entry.id, index, e.target.checked)}
							/>
							<span className="min-w-0">
								<span className="block font-medium text-foreground">
									{endpoint(candidate)}
								</span>
								<span className="block break-all font-mono">
									{candidate.certPath}
								</span>
								{candidate.keyPath && (
									<span className="block break-all font-mono">
										Key: {candidate.keyPath}
									</span>
								)}
							</span>
						</label>
					))}
				</div>
			))}
		</fieldset>
	);
}
