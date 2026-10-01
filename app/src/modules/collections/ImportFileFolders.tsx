/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an import's file references need, with the one action that settles
 * most of them.
 *
 * Every path an import carries is `unresolved`: nobody chose it on this
 * machine, so the engine sends it only from a folder allowed in Settings >
 * Files. A collection exported on this same machine names files that are
 * right here, and relinking them one request at a time is the chore this
 * exists to remove - so the preview lists each distinct folder the paths sit
 * in, with an "Allow folder" beside it. A folder that does not exist here is
 * refused by the engine with its own message (`useAllowFolder`), which is the
 * honest answer for a collection from another computer: relink those in the
 * request instead.
 *
 * Shared by the single-file preview and the batch ledger (across every file
 * the batch will import), so a folder is offered once however many files
 * reference it.
 */

import { AlertTriangle, Check, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui";
import { FieldError } from "@/components/shared";
import { useAllowFolder } from "@/hooks/useAllowFolder";
import { useFileRootsQuery } from "@/queries";
import { isUnderFolder } from "@/lib/file-path";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { ImportResult } from "@/services/importers/types";
import { bodiesWithoutFileNotice, fileReferenceNeeds } from "./import-notices";

/** Whether `folder` is an allowed folder, or inside one. */
function covered(folder: string, roots: readonly { path: string }[]): boolean {
	return roots.some((root) => isUnderFolder(`${folder}/x`, root.path));
}

export function ImportFileFolders({ results }: { results: readonly ImportResult[] }) {
	const { folders, bodiesWithoutFile } = fileReferenceNeeds(results);
	const { data: roots = [] } = useFileRootsQuery();
	const { allow, isPending } = useAllowFolder();
	const bodiesNotice = bodiesWithoutFileNotice(bodiesWithoutFile);

	if (folders.length === 0 && !bodiesNotice) return null;

	return (
		<div className="space-y-1.5">
			{bodiesNotice && (
				<FieldError as="span" icon={AlertTriangle}>
					{bodiesNotice.text}
				</FieldError>
			)}
			{folders.length > 0 && (
				<>
					<FieldError as="span" icon={AlertTriangle}>
						{`${folders.reduce((n, f) => n + f.count, 0)} imported file ${pluralize(
							folders.reduce((n, f) => n + f.count, 0),
							"path is",
							"paths are"
						)} sent only from an allowed folder - allow ${pluralize(
							folders.length,
							"its folder",
							"their folders"
						)}, or choose each file in its request`}
					</FieldError>
					<ul aria-label="Folders the imported files are in" className="space-y-1 pl-5">
						{folders.map(({ folder, count }) => {
							const allowed = covered(folder, roots);
							return (
								<li key={folder} className="flex items-center gap-2 text-xs">
									<FolderOpen
										className="size-icon-sm shrink-0 text-muted-foreground"
										aria-hidden="true"
									/>
									<span className="min-w-0 truncate font-mono" title={folder}>
										{folder}
									</span>
									<span className="shrink-0 text-muted-foreground">
										{count} {pluralize(count, "file")}
									</span>
									{allowed ? (
										<span className="ml-auto flex shrink-0 items-center gap-1 text-status-success-text">
											<Check className="size-icon-sm" aria-hidden="true" />
											Allowed
										</span>
									) : (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="ml-auto h-6 shrink-0 px-2 text-xs"
											disabled={isPending}
											onClick={() => void allow(folder)}
											aria-label={`Allow folder ${folder}`}
										>
											Allow folder
										</Button>
									)}
								</li>
							);
						})}
					</ul>
				</>
			)}
		</div>
	);
}
