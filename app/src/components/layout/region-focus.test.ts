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
 * The F6 cycle and ⌘L, against a real DOM rather than a rendered Shell (#1219).
 *
 * The shape of the window is what these answer questions about - which bands
 * exist, which hold anything focusable, where focus is now - and building that
 * shape by hand is the only way to write the cases that matter: a band that is
 * present but empty, a band that is closed and therefore absent, focus starting
 * outside every band. A rendered Shell can produce one of those arrangements
 * per test at best, and mocks away the panels that make the others.
 */

import { describe, it, expect, afterEach } from "vitest";
import { REQUEST_URL_INPUT_ID } from "@/constants/dom-ids";
import {
	REGION_ATTRIBUTE,
	appRegions,
	cycleRegionFocus,
	focusRequestUrl,
	type AppRegion,
} from "./region-focus";

/** Build a band holding one button per name given, in document order. */
function region(name: AppRegion, ...buttonIds: string[]): HTMLElement {
	const el = document.createElement("div");
	el.setAttribute(REGION_ATTRIBUTE, name);
	for (const id of buttonIds) {
		const button = document.createElement("button");
		button.id = id;
		el.append(button);
	}
	document.body.append(el);
	return el;
}

/** The whole window, in the order the Shell renders it. */
function fullShell(): void {
	region("banner", "banner-search");
	region("drawer", "drawer-first", "drawer-second");
	region("main", "main-first");
	region("context", "context-first");
}

const activeId = () => document.activeElement?.id ?? null;

afterEach(() => {
	document.body.innerHTML = "";
});

describe("the regions on screen", () => {
	it("finds them in document order, and finds none on an empty page", () => {
		expect(appRegions()).toHaveLength(0);
		fullShell();
		expect(appRegions().map((el) => el.getAttribute(REGION_ATTRIBUTE))).toEqual([
			"banner",
			"drawer",
			"main",
			"context",
		]);
	});
});

describe("cycling forward", () => {
	it("moves to the first control of the next band", () => {
		fullShell();
		document.getElementById("drawer-second")?.focus();

		expect(cycleRegionFocus(1)).toBe(true);
		expect(activeId()).toBe("main-first");
	});

	it("wraps from the last band to the first", () => {
		fullShell();
		document.getElementById("context-first")?.focus();

		expect(cycleRegionFocus(1)).toBe(true);
		expect(activeId()).toBe("banner-search");
	});

	it("starts at the first band when focus is outside every one of them", () => {
		fullShell();
		expect(activeId()).toBe("");

		expect(cycleRegionFocus(1)).toBe(true);
		expect(activeId()).toBe("banner-search");
	});
});

describe("cycling backward", () => {
	it("moves to the previous band", () => {
		fullShell();
		document.getElementById("main-first")?.focus();

		expect(cycleRegionFocus(-1)).toBe(true);
		expect(activeId()).toBe("drawer-first");
	});

	it("wraps from the first band to the last", () => {
		fullShell();
		document.getElementById("banner-search")?.focus();

		expect(cycleRegionFocus(-1)).toBe(true);
		expect(activeId()).toBe("context-first");
	});

	it("starts at the last band when focus is outside every one of them", () => {
		fullShell();

		expect(cycleRegionFocus(-1)).toBe(true);
		expect(activeId()).toBe("context-first");
	});
});

describe("bands the cycle has to step over", () => {
	it("skips one holding nothing focusable", () => {
		region("banner", "banner-search");
		// The context bar renders its frame with no controls in it - a real
		// arrangement, since every section it holds can be collapsed.
		region("drawer");
		region("main", "main-first");
		document.getElementById("banner-search")?.focus();

		expect(cycleRegionFocus(1)).toBe(true);
		expect(activeId()).toBe("main-first");
	});

	it("skips one that is hidden from assistive technology", () => {
		region("banner", "banner-search");
		region("drawer", "drawer-first").setAttribute("aria-hidden", "true");
		region("main", "main-first");
		document.getElementById("banner-search")?.focus();

		expect(cycleRegionFocus(1)).toBe(true);
		expect(activeId()).toBe("main-first");
	});

	it("counts a closed band as absent - the drawer is not in the DOM at all", () => {
		region("banner", "banner-search");
		region("main", "main-first");
		document.getElementById("banner-search")?.focus();

		expect(cycleRegionFocus(1)).toBe(true);
		expect(activeId()).toBe("main-first");
	});
});

describe("nowhere to go", () => {
	it("leaves focus alone when this is the only band with anything in it", () => {
		region("main", "main-first");
		document.getElementById("main-first")?.focus();

		expect(cycleRegionFocus(1)).toBe(false);
		expect(activeId()).toBe("main-first");
	});

	it("leaves focus alone when there are no bands at all", () => {
		expect(cycleRegionFocus(1)).toBe(false);
	});

	// The band focus is in is never a destination: a press that re-focused the
	// drawer's first row from its fourth would read as a random jump.
	it("does not re-enter the band it started in", () => {
		region("drawer", "drawer-first", "drawer-second");
		document.getElementById("drawer-second")?.focus();

		expect(cycleRegionFocus(1)).toBe(false);
		expect(activeId()).toBe("drawer-second");
	});
});

describe("focusing the URL bar", () => {
	function urlField(): HTMLInputElement {
		const input = document.createElement("input");
		input.id = REQUEST_URL_INPUT_ID;
		input.value = "https://api.example.com/v1/orders";
		document.body.append(input);
		return input;
	}

	it("focuses the field and selects what is in it, the way ⌘L does", () => {
		const input = urlField();

		expect(focusRequestUrl()).toBe(true);
		expect(document.activeElement).toBe(input);
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe(input.value.length);
	});

	it("does nothing when no request tab is open, so no field is on screen", () => {
		expect(focusRequestUrl()).toBe(false);
	});

	// The id is the contract between `UrlInput` and a Shell that has no ref into
	// the request builder; an element that is not the field must not answer to
	// it.
	it("refuses an element carrying the id that is not an input", () => {
		const impostor = document.createElement("div");
		impostor.id = REQUEST_URL_INPUT_ID;
		document.body.append(impostor);

		expect(focusRequestUrl()).toBe(false);
	});
});
