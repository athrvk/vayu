/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Vayu UI Components
// Re-exported from shadcn/ui with Vayu theming

export { Button } from "./button";
export { buttonVariants } from "./button-variants";
export type { ButtonProps } from "./button";

export { CodeEditor } from "./code-editor";
export type { CodeEditorProps } from "./code-editor";

export { Input } from "./input";
export { SecretInput } from "./secret-input";
export { Textarea } from "./textarea";
export type { TextareaProps } from "./textarea";

export { Badge } from "./badge";
export { badgeVariants } from "./badge-variants";

export { Kbd } from "./kbd";
export type { KbdProps } from "./kbd";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent } from "./card";

export {
	Dialog,
	DialogPortal,
	DialogOverlay,
	DialogTrigger,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogBody,
	DialogFooter,
	DialogTitle,
	DialogDescription,
} from "./dialog";

export { DeleteConfirmDialog } from "./delete-confirm-dialog";
export type { DeleteConfirmDialogProps } from "./delete-confirm-dialog";

export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuRadioItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuGroup,
	DropdownMenuPortal,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuRadioGroup,
} from "./dropdown-menu";

export { Tabs, TabsList, TabsTrigger, TabsContent, TabLabel, TabCount, TabErrorDot } from "./tabs";
export { Eyebrow, EYEBROW_CLASS } from "./eyebrow";
export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./table";

export {
	ToastProvider,
	ToastViewport,
	Toast,
	ToastIcon,
	ToastTitle,
	ToastDescription,
	ToastAction,
	ToastClose,
} from "./toast";
export type { ToastVariantName } from "./toast";

export { ToggleGroup, ToggleGroupItem } from "./toggle-group";
export type { ToggleGroupProps } from "./toggle-group";
export {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
	TooltipHint,
	TooltipValue,
	TooltipProvider,
} from "./tooltip";
export { TooltipIconButton } from "./tooltip-icon-button";
export type { TooltipIconButtonProps } from "./tooltip-icon-button";
export { InfoChip } from "./info-chip";
export type { InfoChipProps } from "./info-chip";

export {
	Select,
	SelectGroup,
	SelectValue,
	SelectTrigger,
	SelectContent,
	SelectLabel,
	SelectItem,
	SelectSeparator,
	SelectScrollUpButton,
	SelectScrollDownButton,
} from "./select";

export { Popover, PopoverTrigger, PopoverContent } from "./popover";

export {
	Command,
	CommandDialog,
	CommandInput,
	CommandList,
	CommandFooter,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandSeparator,
	CommandListboxProbe,
	CommandScrollIntoView,
} from "./command";
export type { CommandListboxState } from "./command";

export { Separator } from "./separator";

export { ScrollArea, ScrollBar } from "./scroll-area";

export { Label } from "./label";

// Variable components (system-wide)
export { VariableScopeBadge } from "./variable-scope-badge";
export type { VariableScopeBadgeProps, VariableScope } from "./variable-scope-badge";

export { MarkdownView } from "./markdown-view";
export type { MarkdownViewProps } from "./markdown-view";
export { MarkdownEditor } from "./markdown-editor";
export type { MarkdownEditorProps } from "./markdown-editor";
export { VariablePopover } from "./variable-popover";
export type { VariablePopoverProps, VariableInfo as VariablePopoverInfo } from "./variable-popover";

export { VariableAutocomplete } from "./variable-autocomplete";
export { SuggestionList, SUGGESTION_LIST_LIMIT } from "./suggestion-list";
export type { SuggestionListProps } from "./suggestion-list";
export type {
	VariableAutocompleteProps,
	VariableInfo as VariableAutocompleteInfo,
} from "./variable-autocomplete";

export { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./resizable";

export { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./collapsible";

export { Progress } from "./progress";
export type { ProgressProps } from "./progress";
export { Skeleton } from "./skeleton";

export { Switch } from "./switch";
export { toastVariants } from "./toast-variants";
