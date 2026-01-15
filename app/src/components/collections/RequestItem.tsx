import { Loader2, Trash2 } from "lucide-react";
import { getMethodColor } from "@/utils";
import type { Request } from "@/types";
import { Button, Badge, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface RequestItemProps {
    request: Request;
    collectionId: string;
    onSelect: (collectionId: string, requestId: string) => void;
    onDelete: (requestId: string) => Promise<void>;
    isDeleting?: boolean;
    isSelected?: boolean;
    isRenaming?: boolean;
    renameValue?: string;
    onRenameChange?: (value: string) => void;
    onRenameSubmit?: (requestId: string) => void;
    onRenameCancel?: () => void;
    onStartRename?: (request: Request) => void;
}

export default function RequestItem({
    request,
    collectionId,
    onSelect,
    onDelete,
    isDeleting,
    isSelected,
    isRenaming,
    renameValue,
    onRenameChange,
    onRenameSubmit,
    onRenameCancel,
    onStartRename,
}: RequestItemProps) {
    return (
        <div className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded group cursor-pointer transition-colors",
            isDeleting && "opacity-50",
            isSelected
                ? "bg-primary/10 ring-1 ring-inset ring-primary/20 hover:bg-primary/15"
                : "hover:bg-accent"
        )}>
            <button
                onClick={() => onSelect(collectionId, request.id)}
                className="flex items-center gap-2 flex-1 text-left"
                disabled={isDeleting || isRenaming}
            >
                <Badge
                    variant="outline"
                    className={cn("text-xs font-mono font-semibold px-1.5 py-0.5", getMethodColor(request.method))}
                >
                    {request.method}
                </Badge>
                {isRenaming ? (
                    <Input
                        type="text"
                        value={renameValue ?? ""}
                        onChange={(e) => onRenameChange?.(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                onRenameSubmit?.(request.id);
                            } else if (e.key === "Escape") {
                                onRenameCancel?.();
                            }
                        }}
                        onBlur={() => onRenameSubmit?.(request.id)}
                        className="flex-1 h-6 text-sm"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                    />
                ) : (
                    <span
                        className="text-sm text-foreground truncate"
                        onDoubleClick={(e) => {
                            e.stopPropagation();
                            onStartRename?.(request);
                        }}
                    >
                        {request.name}
                    </span>
                )}
            </button>

            {!isRenaming && (
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(request.id)}
                    disabled={isDeleting}
                    className={cn(
                        "h-6 w-6 hover:bg-destructive/10 hover:text-destructive transition-opacity",
                        isDeleting ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}
                >
                    {isDeleting ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                        <Trash2 className="w-3 h-3" />
                    )}
                </Button>
            )}
        </div>
    );
}
