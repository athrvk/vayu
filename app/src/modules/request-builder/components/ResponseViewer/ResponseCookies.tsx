/**
 * ResponseCookies Component
 *
 * Displays cookies extracted from Set-Cookie headers.
 */

export interface ResponseCookiesProps {
	headers: Record<string, string>;
}

export default function ResponseCookies({ headers }: ResponseCookiesProps) {
	// Extract cookies from Set-Cookie header
	const setCookie = headers["set-cookie"] || headers["Set-Cookie"];

	if (!setCookie) {
		return <div className="p-8 text-center text-muted-foreground">No cookies in response</div>;
	}

	// Parse cookies (simplified)
	const cookies = setCookie.split(",").map((cookie) => {
		const [nameValue, ...attrs] = cookie.split(";");
		const [name, value] = nameValue.split("=");
		return { name: name?.trim(), value: value?.trim(), attrs: attrs.join(";") };
	});

	return (
		<div className="p-4 overflow-auto h-full">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border">
						<th className="text-left py-2 px-3 font-medium text-muted-foreground">
							Name
						</th>
						<th className="text-left py-2 px-3 font-medium text-muted-foreground">
							Value
						</th>
					</tr>
				</thead>
				<tbody>
					{cookies.map((cookie, i) => (
						<tr key={i} className="border-b border-border/50 hover:bg-muted/50">
							<td className="py-2 px-3 font-mono text-primary">{cookie.name}</td>
							<td className="py-2 px-3 font-mono break-all">{cookie.value}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
