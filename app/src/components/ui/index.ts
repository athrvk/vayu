
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Vayu UI Components
// Re-exported from shadcn/ui with Vayu theming

export { Button, buttonVariants } from "./button";
export type { ButtonProps } from "./button";

export { Input } from "./input";
export { Textarea } from "./textarea";
export type { TextareaProps } from "./textarea";

export { Badge, badgeVariants } from "./badge";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent } from "./card";

export {
	Dialog,
	DialogPortal,
	DialogOverlay,
	DialogTrigger,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
} from "./dialog";

export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuRadioItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuGroup,
	DropdownMenuPortal,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuRadioGroup,
} from "./dropdown-menu";

export { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./tooltip";

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
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandShortcut,
	CommandSeparator,
} from "./command";

export { Separator } from "./separator";

export { ScrollArea, ScrollBar } from "./scroll-area";

export { Label } from "./label";

// Variable components (system-wide)
export { VariableScopeBadge } from "./variable-scope-badge";
export type { VariableScopeBadgeProps, VariableScope } from "./variable-scope-badge";

export { VariablePopover } from "./variable-popover";
export type { VariablePopoverProps, VariableInfo as VariablePopoverInfo } from "./variable-popover";

export { VariableAutocomplete } from "./variable-autocomplete";
export type {
	VariableAutocompleteProps,
	VariableInfo as VariableAutocompleteInfo,
} from "./variable-autocomplete";

export { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./resizable";

export { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./collapsible";

export { Skeleton } from "./skeleton";

export { Switch } from "./switch";
