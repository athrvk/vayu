/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import * as React from "react";
import { type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { badgeVariants } from "./badge-variants";

export interface BadgeProps
	extends React.ComponentProps<"div">, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
	return (
		<div data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
	);
}

export { Badge };
