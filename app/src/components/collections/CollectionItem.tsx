import {
    ChevronRight,
    ChevronDown,
    Folder,
    MoreVertical,
    Loader2,
} from "lucide-react";
import RequestItem from "./RequestItem";
import type { Collection, Request } from "@/types";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface CollectionItemProps {
    collection: Collection;
    allCollections: Collection[];
    depth: number;
    expandedCollectionIds: Set<string>;
    selectedCollectionId: string | null;
    selectedRequestId: string | null;
    renamingId: string | null;
    renameValue: string;
    deletingCollectionId: string | null;
    deletingRequestId: string | null;
    creatingSubfolder: string | null;
    newSubfolderName: string;
    isCreatingSubfolder: boolean;
    renamingRequestId: string | null;
    renameRequestValue: string;
    getRequestsByCollection: (collectionId: string) => Request[];
    onCollectionClick: (collection: Collection) => void;
    onRequestClick: (collectionId: string, requestId: string) => void;
    onShowContextMenu: (e: React.MouseEvent, collectionId: string) => void;
    onRenameChange: (value: string) => void;
    onRenameSubmit: (collectionId: string) => void;
    onRenameCancel: () => void;
    onStartRename: (collection: Collection) => void;
    onDeleteRequest: (requestId: string) => Promise<void>;
    onSubfolderNameChange: (value: string) => void;
    onCreateSubfolder: (parentId: string) => void;
    onCancelSubfolder: () => void;
    onRequestRenameChange: (value: string) => void;
    onRequestRenameSubmit: (requestId: string) => void;
    onRequestRenameCancel: () => void;
    onStartRequestRename: (request: Request) => void;
}

export default function CollectionItem({
    collection,
    allCollections,
    depth,
    expandedCollectionIds,
    selectedCollectionId,
    selectedRequestId,
    renamingId,
    renameValue,
    deletingCollectionId,
    deletingRequestId,
    creatingSubfolder,
    newSubfolderName,
    isCreatingSubfolder,
    renamingRequestId,
    renameRequestValue,
    getRequestsByCollection,
    onCollectionClick,
    onRequestClick,
    onShowContextMenu,
    onRenameChange,
    onRenameSubmit,
    onRenameCancel,
    onStartRename,
    onDeleteRequest,
    onSubfolderNameChange,
    onCreateSubfolder,
    onCancelSubfolder,
    onRequestRenameChange,
    onRequestRenameSubmit,
    onRequestRenameCancel,
    onStartRequestRename,
}: CollectionItemProps) {
    const isExpanded = expandedCollectionIds.has(collection.id);
    const requests = getRequestsByCollection(collection.id);
    const isRenaming = renamingId === collection.id;
    const isDeleting = deletingCollectionId === collection.id;
    const childCollections = allCollections
        .filter((c) => c.parent_id === collection.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    return (
        <div className={cn("select-none", isDeleting && "opacity-50")}>
            {/* Collection Header */}
            <div className={cn(
                "flex items-center gap-1 px-2 py-1.5 rounded group transition-colors",
                selectedCollectionId === collection.id
                    ? "bg-primary/10 hover:bg-primary/15 ring-1 ring-inset ring-primary/20"
                    : "hover:bg-accent"
            )}>
                <button
                    onClick={() => onCollectionClick(collection)}
                    className="flex items-center gap-2 flex-1 text-left"
                    disabled={isDeleting}
                >
                    {isDeleting ? (
                        <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                    ) : isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    ) : (
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    )}
                    <Folder className={cn("w-4 h-4", depth === 0 ? "text-primary" : "text-primary/70")} />
                    {isRenaming ? (
                        <Input
                            type="text"
                            value={renameValue}
                            onChange={(e) => onRenameChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    onRenameSubmit(collection.id);
                                } else if (e.key === "Escape") {
                                    onRenameCancel();
                                }
                            }}
                            onBlur={() => onRenameSubmit(collection.id)}
                            className="flex-1 h-6 text-sm"
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                        />
                    ) : (
                        <>
                                <span
                                    className={cn("text-sm text-foreground", depth === 0 && "font-medium")}
                                    onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        onStartRename(collection);
                                    }}
                                >
                                {collection.name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                ({requests.length + childCollections.length})
                            </span>
                        </>
                    )}
                </button>

                {!isRenaming && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onShowContextMenu(e, collection.id);
                            }}
                        >
                            <MoreVertical className="w-3 h-3" />
                        </Button>
                    </div>
                )}
            </div>

            {/* Children (Subfolders + Requests) */}
            {isExpanded && (
                <div className="ml-6 mt-1 space-y-0.5">
                    {/* Subfolder Creation Form */}
                    {creatingSubfolder === collection.id && (
                        <div className="flex gap-2 py-1 px-2">
                            <Input
                                type="text"
                                value={newSubfolderName}
                                onChange={(e) => onSubfolderNameChange(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") onCreateSubfolder(collection.id);
                                    if (e.key === "Escape") onCancelSubfolder();
                                }}
                                placeholder="Folder name"
                                className="flex-1 h-7 text-sm"
                                disabled={isCreatingSubfolder}
                                autoFocus
                            />
                            <Button
                                size="sm"
                                onClick={() => onCreateSubfolder(collection.id)}
                                disabled={isCreatingSubfolder}
                                className="h-7 text-xs"
                            >
                                {isCreatingSubfolder && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                                Add
                            </Button>
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={onCancelSubfolder}
                                disabled={isCreatingSubfolder}
                                className="h-7 text-xs"
                            >
                                Cancel
                            </Button>
                        </div>
                    )}

                    {/* Child Collections (Subfolders) - Recursive */}
                    {childCollections.map((childCollection) => (
                        <CollectionItem
                            key={childCollection.id}
                            collection={childCollection}
                            allCollections={allCollections}
                            depth={depth + 1}
                            expandedCollectionIds={expandedCollectionIds}
                            selectedCollectionId={selectedCollectionId}
                            selectedRequestId={selectedRequestId}
                            renamingId={renamingId}
                            renameValue={renameValue}
                            deletingCollectionId={deletingCollectionId}
                            deletingRequestId={deletingRequestId}
                            creatingSubfolder={creatingSubfolder}
                            newSubfolderName={newSubfolderName}
                            isCreatingSubfolder={isCreatingSubfolder}
                            getRequestsByCollection={getRequestsByCollection}
                            onCollectionClick={onCollectionClick}
                            onRequestClick={onRequestClick}
                            onShowContextMenu={onShowContextMenu}
                            onRenameChange={onRenameChange}
                            onRenameSubmit={onRenameSubmit}
                            onRenameCancel={onRenameCancel}
                            onStartRename={onStartRename}
                            onDeleteRequest={onDeleteRequest}
                            onSubfolderNameChange={onSubfolderNameChange}
                            onCreateSubfolder={onCreateSubfolder}
                            onCancelSubfolder={onCancelSubfolder}
                            onRequestRenameChange={onRequestRenameChange}
                            onRequestRenameSubmit={onRequestRenameSubmit}
                            onRequestRenameCancel={onRequestRenameCancel}
                            onStartRequestRename={onStartRequestRename}
                            renamingRequestId={renamingRequestId}
                            renameRequestValue={renameRequestValue}
                        />
                    ))}

                    {/* Requests */}
                    {requests.length === 0 && childCollections.length === 0 && creatingSubfolder !== collection.id && (
                        <div className="py-2 px-3 text-xs text-muted-foreground">
                            Empty folder
                        </div>
                    )}
                    {requests.map((request) => (
                        <RequestItem
                            key={request.id}
                            request={request}
                            collectionId={collection.id}
                            onSelect={onRequestClick}
                            onDelete={onDeleteRequest}
                            isDeleting={deletingRequestId === request.id}
                            isSelected={selectedCollectionId === collection.id && selectedRequestId === request.id}
                            isRenaming={renamingRequestId === request.id}
                            renameValue={renameRequestValue}
                            onRenameChange={onRequestRenameChange}
                            onRenameSubmit={onRequestRenameSubmit}
                            onRenameCancel={onRequestRenameCancel}
                            onStartRename={onStartRequestRename}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
