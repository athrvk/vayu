/**
 * The description a shared argument carries on every tool but the one that
 * states it in full (#3747). Every session pays for `tools/list` whole, so a
 * long argument description is written once, on @p tool, and the others point
 * at it; @p specific adds only what differs on this tool.
 */
export function asOn(tool: string, specific?: string): string {
	return specific ? `As on \`${tool}\`; ${specific}` : `As on \`${tool}\`.`;
}
