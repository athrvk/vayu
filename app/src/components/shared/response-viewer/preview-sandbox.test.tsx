/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The HTML Preview frame never shares the renderer's origin.
 *
 * A response body is the server's markup. With `allow-scripts` and
 * `allow-same-origin` together the frame runs that markup's script as the
 * renderer, which reaches `window.parent.electronAPI`. The rendered attribute is
 * asserted exactly, the document's policy is asserted to come before anything
 * the server wrote, and a scan of every frame in `src` holds the rule for the
 * next one somebody adds.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { render } from "@testing-library/react";
import { buildPreviewDocument, PREVIEW_CSP } from "./preview-document";

vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: () => <div data-testid="code-editor" />,
}));

import ResponseBody from "./ResponseBody";

const HOSTILE =
	"<!DOCTYPE html><html><head><title>x</title>" +
	'<meta http-equiv="Content-Security-Policy" content="default-src *">' +
	'<base href="https://elsewhere.test/" target="_self"></head>' +
	'<body><a href="https://elsewhere.test/">go</a>' +
	"<script>window.parent.electronAPI</script></body></html>";

function renderPreview(html: string) {
	const { container } = render(
		<ResponseBody
			body={html}
			bodyRaw={html}
			headers={{ "content-type": "text/html" }}
			defaultMode="preview"
		/>
	);
	const frame = container.querySelector("iframe");
	expect(frame, "the preview must render a frame").not.toBeNull();
	return frame!;
}

describe("the preview frame", () => {
	it("is sandboxed with no tokens at all", () => {
		const frame = renderPreview(HOSTILE);

		expect(frame.getAttribute("sandbox")).toBe("");
	});

	it("renders the document with the policy in front of the server's markup", () => {
		const frame = renderPreview(HOSTILE);

		expect(frame.getAttribute("srcdoc")).toBe(buildPreviewDocument(HOSTILE));
	});
});

describe("buildPreviewDocument", () => {
	it("puts the policy and the top-targeted base first in the parsed head", () => {
		const doc = new DOMParser().parseFromString(buildPreviewDocument(HOSTILE), "text/html");
		const head = Array.from(doc.head.children);

		expect(head[0].getAttribute("http-equiv")).toBe("Content-Security-Policy");
		expect(head[0].getAttribute("content")).toBe(PREVIEW_CSP);
		// The first `<base>` with a target is the one that counts.
		expect(doc.querySelector("base[target]")?.getAttribute("target")).toBe("_top");
		expect(doc.compatMode).toBe("CSS1Compat");
	});

	it("leaves the document without a doctype when the server sent none", () => {
		const out = buildPreviewDocument("<p>hi</p>");

		expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
		expect(out.endsWith("<p>hi</p>")).toBe(true);
	});

	it("adds no script of its own", () => {
		expect(buildPreviewDocument("<p>hi</p>")).not.toMatch(/<script/i);
	});

	it("loads nothing from the network and submits nothing", () => {
		const directives = new Map(
			PREVIEW_CSP.split(";").map((d) => {
				const [name, ...sources] = d.trim().split(/\s+/);
				return [name, sources] as const;
			})
		);

		expect(directives.get("default-src")).toEqual(["'none'"]);
		expect(directives.get("form-action")).toEqual(["'none'"]);
		expect(directives.get("base-uri")).toEqual(["'none'"]);
		for (const [name, sources] of directives) {
			for (const source of sources) {
				expect(
					source === "'none'" || source === "'unsafe-inline'" || source === "data:",
					`${name} allows ${source}`
				).toBe(true);
			}
		}
	});
});

describe("every frame in src", () => {
	const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
	// globSync returns platform separators; the assertions below name files
	// with forward slashes, so the scan is normalised before anything reads it.
	const files = globSync("**/*.tsx", { cwd: srcRoot })
		.map((file) => file.split(sep).join("/"))
		.filter((file) => !file.includes(".test.") && !file.includes(".testkit."));
	const frames = files.flatMap((file) => {
		const text = readFileSync(join(srcRoot, file), "utf8");
		return Array.from(text.matchAll(/<iframe\b[^>]*>/g), (m) => ({ file, tag: m[0] }));
	});

	it("scanned the source tree and found the preview frame", () => {
		expect(files.length).toBeGreaterThan(100);
		expect(frames.map((f) => f.file)).toContain(
			"components/shared/response-viewer/ResponseBody.tsx"
		);
	});

	it("declares a sandbox without allow-same-origin", () => {
		for (const { file, tag } of frames) {
			expect(tag, `${file}: an iframe without a sandbox`).toMatch(/\bsandbox=/);
			expect(tag, `${file}: a sandbox that shares the renderer's origin`).not.toMatch(
				/allow-same-origin/
			);
		}
	});
});
