/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * FilesPanel
 *
 * The folders a request-body file may be sent from without a per-file pick.
 *
 * **The rule, in the words the user sees:** Vayu sends a file you chose in
 * the editor, or any file under a folder you allowed here. Everything else -
 * a path an import carried, a curl paste, an AI agent, a `{{var}}` path, a
 * data-file column - is refused at send time by the engine, naming the file
 * and pointing here. This list is the engine's (`GET /file-roots`), it is the
 * one the engine checks, and it applies to design sends, load runs and
 * collection runs alike.
 *
 * **The engine owns the path.** A folder is stored canonical (symlinks
 * resolved, no trailing separator), so the row shown is the one the engine
 * returned, not the text typed. A path that is not an existing directory on
 * this machine is refused with the engine's own message.
 */

import { useState } from "react";
import { FolderLock, FolderOpen, Loader2, Trash2 } from "lucide-react";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
} from "@/components/ui";
import { useDeleteFileRootMutation, useFileRootsQuery } from "@/queries";
import { useAllowFolder } from "@/hooks/useAllowFolder";
import { isCommitEnter } from "@/lib/keyboard";
import { useToastStore } from "@/stores";
import { appSetting } from "../app-settings";

// Headings come from the catalogue so search cannot offer a name this panel
// does not print - see `app-settings.ts`.
const ALLOWED_FOLDERS = appSetting("allowed-folders");

export default function FilesPanel() {
	const { data: roots = [], isError, isLoading } = useFileRootsQuery();
	const deleteRoot = useDeleteFileRootMutation();
	const { allow, chooseAndAllow, isPending } = useAllowFolder();
	const showToast = useToastStore((s) => s.showToast);
	const [typed, setTyped] = useState("");

	const submitTyped = async () => {
		const path = typed.trim();
		if (!path) return;
		if (await allow(path)) setTyped("");
	};

	const remove = async (id: string, path: string) => {
		try {
			await deleteRoot.mutateAsync(id);
			showToast(`${path} is no longer an allowed folder.`, "success");
		} catch {
			showToast(`Couldn't remove ${path}.`, "error");
		}
	};

	return (
		<Card data-setting-anchor={ALLOWED_FOLDERS.anchor}>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<FolderLock className="w-5 h-5 text-muted-foreground" />
					<CardTitle>{ALLOWED_FOLDERS.label}</CardTitle>
				</div>
				<CardDescription>
					Vayu sends a file you chose in the editor, or any file under a folder you allow
					here. Files from an import, a pasted curl command, an AI agent, a data file or a
					path with a variable in it are sent only from these folders.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{isError ? (
					<p className="text-sm text-muted-foreground">
						The engine did not answer, so the allowed folders are unknown.
					</p>
				) : isLoading ? null : roots.length === 0 ? (
					<p className="text-sm text-muted-foreground">No folders allowed yet.</p>
				) : (
					<ul aria-label="Allowed folders">
						{roots.map((root) => (
							<li
								key={root.id}
								className="flex items-center justify-between gap-3 border-b border-rule py-2 last:border-b-0"
							>
								<span
									className="min-w-0 truncate font-mono text-xs"
									title={root.path}
								>
									{root.path}
								</span>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => void remove(root.id, root.path)}
									disabled={deleteRoot.isPending}
									aria-label={`Remove ${root.path}`}
								>
									<Trash2 className="size-icon" />
								</Button>
							</li>
						))}
					</ul>
				)}

				<div className="flex items-center gap-2">
					<Input
						size="sm"
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						onKeyDown={(e) => {
							if (isCommitEnter(e)) {
								e.preventDefault();
								void submitTyped();
							}
						}}
						placeholder="/path/to/folder"
						aria-label="Folder to allow"
						className="font-mono text-xs"
					/>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void submitTyped()}
						disabled={isPending || !typed.trim()}
					>
						{isPending && <Loader2 className="size-icon mr-1.5 animate-spin" />}
						Allow
					</Button>
					{chooseAndAllow && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => void chooseAndAllow()}
							disabled={isPending}
						>
							<FolderOpen className="size-icon mr-1.5" />
							Choose folder...
						</Button>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
