/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The file a stored run's `binary` body sent: name, size, and the start of its
 * sha256, with the whole hash a hover away. One line for every run surface
 * that shows a stored exchange - the design-run copy's header and a scenario
 * step's expansion - so a file is described in the same words wherever it is.
 *
 * Never the path: the engine does not record it here, and a path is the part
 * of a file reference that differs between machines anyway.
 */

import { FileUp } from "lucide-react";
import { formatSize } from "./response-viewer/utils";
import { SHORT_SHA_LENGTH, type SentBodyFile } from "@/lib/sent-body-file";
import { cn } from "@/lib/utils";

export function SentBodyFileNote({ file, className }: { file: SentBodyFile; className?: string }) {
	const parts = [
		file.fileName ?? "file",
		file.size !== undefined ? formatSize(file.size) : null,
	].filter(Boolean);
	return (
		<span
			className={cn(
				"flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
				className
			)}
		>
			<FileUp className="size-icon-sm shrink-0" aria-hidden="true" />
			<span className="min-w-0 truncate">
				Sent file {parts.join(" · ")}
				{file.sha256 && (
					<>
						{" · sha256 "}
						<code className="font-mono" title={file.sha256}>
							{file.sha256.slice(0, SHORT_SHA_LENGTH)}
						</code>
					</>
				)}
			</span>
		</span>
	);
}
