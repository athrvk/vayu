/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The glyphs `index.css` brings down half a grid unit, read off the installed
 * lucide-react (#1830). The rule
 * `:has(> .cap-centred) :is(svg.lucide-folder, svg.lucide-folder-open,
 * svg.lucide-gauge) { transform: translateY(calc(100% / 48)) }` is a fact
 * about how lucide draws these three: their ink is centred at y=11.5 on a
 * 24-unit grid every other glyph centres at 12. A lucide upgrade that redraws
 * one makes the nudge a misplacement, so this reads each icon's node data from
 * the package and fails naming the icon whose extent moved.
 *
 * The extent is the geometry the path describes, with the stroke excluded
 * (lucide strokes every glyph at the same width, so it widens every extent by
 * the same amount and leaves the centre where it was). Lines and moves are
 * exact; elliptical arcs are exact too, solved to their centre form (SVG 1.1
 * F.6.5) and checked for the top and bottom of the ellipse inside the swept
 * angle, because the gauge's dial is one arc whose top lies between its
 * endpoints. Bezier segments are bounded by their control points, an upper
 * bound on the curve; none of the three glyphs has one today.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

type IconNode = [tag: string, attrs: Record<string, string>][];

const iconsDir = join(
	dirname(createRequire(import.meta.url).resolve("lucide-react")),
	"..",
	"esm",
	"icons"
);

async function iconNode(name: string): Promise<IconNode> {
	const file = join(iconsDir, `${name}.mjs`);
	if (!existsSync(file)) throw new Error(`lucide-react no longer ships ${file}`);
	const mod: { __iconNode?: IconNode } = await import(
		/* @vite-ignore */ pathToFileURL(file).href
	);
	if (!mod.__iconNode) throw new Error(`${name}.mjs exports no __iconNode`);
	return mod.__iconNode;
}

/** Every number in a path's argument list, in order. */
function numbers(args: string): number[] {
	return (args.match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi) ?? []).map(Number);
}

/** The y-extent of an elliptical arc from (x1, y1), exact (SVG 1.1 F.6.5). */
function arcYs(
	x1: number,
	y1: number,
	[rxIn, ryIn, phiDeg, largeArc, sweep, x2, y2]: number[]
): number[] {
	let rx = Math.abs(rxIn);
	let ry = Math.abs(ryIn);
	if (rx === 0 || ry === 0) return [y1, y2];
	const phi = (phiDeg * Math.PI) / 180;
	const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
	const dx = (x1 - x2) / 2;
	const dy = (y1 - y2) / 2;
	const x1p = cos * dx + sin * dy;
	const y1p = -sin * dx + cos * dy;
	const scale = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (scale > 1) [rx, ry] = [rx * Math.sqrt(scale), ry * Math.sqrt(scale)];
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
	const k = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
	const cxp = (k * rx * y1p) / ry;
	const cyp = (-k * ry * x1p) / rx;
	const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
	const angle = (ux: number, uy: number) => Math.atan2(uy, ux);
	const t1 = angle((x1p - cxp) / rx, (y1p - cyp) / ry);
	let dt = angle((-x1p - cxp) / rx, (-y1p - cyp) / ry) - t1;
	if (sweep && dt < 0) dt += 2 * Math.PI;
	if (!sweep && dt > 0) dt -= 2 * Math.PI;
	const yAt = (t: number) => cy + sin * rx * Math.cos(t) + cos * ry * Math.sin(t);
	const ys = [y1, y2];
	// y is extreme where dy/dt = -sin*rx*sin(t) + cos*ry*cos(t) = 0.
	const tExtreme = Math.atan2(cos * ry, sin * rx);
	for (const t of [tExtreme, tExtreme + Math.PI]) {
		for (const wrap of [-2, -1, 0, 1, 2]) {
			const tt = t + wrap * 2 * Math.PI;
			const along = (tt - t1) / dt;
			if (along > 0 && along < 1) ys.push(yAt(tt));
		}
	}
	return ys;
}

/** The y values a path's geometry reaches, stroke excluded. */
function pathYs(d: string): number[] {
	const ys: number[] = [];
	let [x, y, startX, startY] = [0, 0, 0, 0];
	for (const [, cmd, args] of d.matchAll(/([MmLlHhVvAaCcSsQqTtZz])([^MmLlHhVvAaCcSsQqTtZz]*)/g)) {
		const n = numbers(args);
		const rel = cmd === cmd.toLowerCase();
		switch (cmd.toUpperCase()) {
			case "M":
			case "L":
			case "T":
				for (let i = 0; i + 1 < n.length; i += 2) {
					x = rel ? x + n[i] : n[i];
					y = rel ? y + n[i + 1] : n[i + 1];
					ys.push(y);
					if (cmd.toUpperCase() === "M" && i === 0) [startX, startY] = [x, y];
				}
				break;
			case "H":
				for (const v of n) x = rel ? x + v : v;
				ys.push(y);
				break;
			case "V":
				for (const v of n) {
					y = rel ? y + v : v;
					ys.push(y);
				}
				break;
			case "A":
				for (let i = 0; i + 6 < n.length; i += 7) {
					const seg = n.slice(i, i + 7);
					const x2 = rel ? x + seg[5] : seg[5];
					const y2 = rel ? y + seg[6] : seg[6];
					ys.push(...arcYs(x, y, [seg[0], seg[1], seg[2], seg[3], seg[4], x2, y2]));
					[x, y] = [x2, y2];
				}
				break;
			case "C":
			case "S":
			case "Q": {
				// Control points bound the curve: an upper bound, not the extreme.
				const step = cmd.toUpperCase() === "C" ? 6 : 4;
				for (let i = 0; i + step - 1 < n.length; i += step) {
					for (let j = 1; j < step; j += 2) ys.push(rel ? y + n[i + j] : n[i + j]);
					x = rel ? x + n[i + step - 2] : n[i + step - 2];
					y = rel ? y + n[i + step - 1] : n[i + step - 1];
				}
				break;
			}
			case "Z":
				[x, y] = [startX, startY];
				break;
		}
	}
	return ys;
}

/** The y values one icon-node shape reaches, stroke excluded. */
function shapeYs([tag, a]: IconNode[number]): number[] {
	const num = (k: string) => Number(a[k] ?? 0);
	switch (tag) {
		case "path":
			return pathYs(a.d ?? "");
		case "circle":
			return [num("cy") - num("r"), num("cy") + num("r")];
		case "ellipse":
			return [num("cy") - num("ry"), num("cy") + num("ry")];
		case "rect":
			return [num("y"), num("y") + num("height")];
		case "line":
			return [num("y1"), num("y2")];
		case "polyline":
		case "polygon":
			return numbers(a.points ?? "").filter((_, i) => i % 2 === 1);
		default:
			throw new Error(`no y-extent rule for <${tag}>`);
	}
}

const round = (v: number) => Math.round(v * 1000) / 1000;

describe("the glyphs index.css brings down half a unit", () => {
	// Drawn extents today: each centres at y=11.5, half a unit above 12.
	const cases: [name: string, top: number, bottom: number][] = [
		["folder", 3, 20],
		["folder-open", 3, 20],
		["gauge", 4, 19],
	];

	it.each(cases)("%s spans y=%d..%d, centred at 11.5", async (name, top, bottom) => {
		const node = await iconNode(name);
		expect(node.length, `${name}: an empty icon node, nothing was read`).toBeGreaterThan(0);
		const ys = node.flatMap(shapeYs);
		expect(ys.length, `${name}: no geometry read from its node`).toBeGreaterThan(2);
		const extent = [round(Math.min(...ys)), round(Math.max(...ys))];
		expect(
			{ name, extent, centre: (extent[0] + extent[1]) / 2 },
			`lucide-react redrew ${name}: index.css's translateY(calc(100% / 48)) assumes its ink is centred half a unit above the 24-unit grid's centre`
		).toEqual({ name, extent: [top, bottom], centre: 11.5 });
	});

	it("reads a glyph lucide draws centred as centred, so the method is not blind", async () => {
		// `chevron-down` is `m6 9 6 6 6-6`: y 9..15, centred at 12.
		const ys = (await iconNode("chevron-down")).flatMap(shapeYs);
		expect([round(Math.min(...ys)), round(Math.max(...ys))]).toEqual([9, 15]);
	});
});
