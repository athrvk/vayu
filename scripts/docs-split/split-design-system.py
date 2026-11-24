#!/usr/bin/env python3
"""
Splits docs/design-system.md into the pages of docs/design-system/ (#3854), re-aims
every link to it, and proves the move lost nothing. The machinery and what a move
changes are in docsplit.py; this file holds where the sections go and the new text
(titles, descriptions, the index's table of pages).

Usage: split-design-system.py [--root DIR] [--rev REV] [--check | --verify | --render]
"""

import sys

from docsplit import Page, Split, main

# A section starts at a marker and runs to the next one. The color tokens are
# grouped by family and the rest by what a page is about; a page that holds
# sections from two places in the source has the earlier one first.
MARKERS = [
    ("---", "index"),
    ("### Elevation", "surfaces"),
    ("### Primary (Accent Color)", "accent-and-status"),
    ("### Chart series tier", "chart-colors"),
    ("### `border-rule`: let the surface pick the token", "surfaces"),
    ("### Variable Scope Colors (Categorical)", "categorical-colors"),
    ("### Run / Status Indicator Colors", "accent-and-status"),
    ("### Decorative categorical palettes (the one token exception)", "categorical-colors"),
    ("### HTTP Method Color Tokens", "categorical-colors"),
    ("### Charts", "chart-colors"),
    ("## Color Schemes (Accent Themes)", "color-schemes"),
    ("## Typography", "typography"),
    ("### Spacing Scale Conventions", "spacing-and-floors"),
    ("## Geometry", "geometry"),
    ("## Animations", "motion"),
    ("## Focus & Interaction States", "focus-states"),
    ("## Accessibility", "accessibility"),
    ("## Row Actions", "rows-and-drawers"),
    ("## Overflowing Text", "overflow-and-shrink"),
    ("## Tree Navigation (roving tabindex)", "tree-navigation"),
    ("## Flex Items Must Be Told They May Shrink", "overflow-and-shrink"),
    ("### Dialog widths: four sizes", "dialogs"),
    ("## Layout Structure", "layout"),
    ("## Component Patterns", "component-patterns"),
    ("### Toasts", "feedback-and-dashboard"),
    ("## Tailwind Utility Reference", "utilities-editor-scrollbar"),
    ("## Motion", "motion"),
    ("## Source Files", "index"),
]

PAGES = {
    "index": Page(None, None),
    "surfaces": Page(
        "Surface, foreground and border tokens",
        "The elevation, foreground, interactive-state and border tokens, and the rule for letting a "
        "surface pick its border token.",
        ("Elevation, foreground scale, interactive states, borders, `border-rule`",),
    ),
    "accent-and-status": Page(
        "Accent and status color tokens",
        "The primary accent token, the semantic status colors and the run and status indicator "
        "colors.",
        ("Primary, semantic status colors, run and status indicators",),
    ),
    "chart-colors": Page(
        "Chart series and text color tokens",
        "The chart series tier, the `-text` variants that make a color legible as text, the contrast "
        "bars and how a chart takes its colors.",
        ("Chart series tier, `-text` variants, contrast bars, charts",),
    ),
    "categorical-colors": Page(
        "Scope, decorative and HTTP method colors",
        "The categorical colors: variable scopes, the one decorative palette exception and the "
        "HTTP method tokens.",
        ("Variable scope colors, decorative palettes, HTTP method tokens",),
    ),
    "color-schemes": Page(
        None,
        "The accent color schemes applied through `data-color-scheme`, the tokens each one sets and a table of their values.",
        ("The accent themes and their values",),
    ),
    "typography": Page(
        None,
        "The fonts the app bundles, their measured x-heights and the type scale conventions.",
        ("Fonts, type scale",),
    ),
    "spacing-and-floors": Page(
        "Spacing, chrome floors and tree indent guides",
        "The spacing scale, the floors for chrome bands, targets and icons, and the tree indent "
        "guides.",
        ("Spacing scale, chrome, target and icon floors, tree indent guides",),
    ),
    "geometry": Page(
        None,
        "The geometry tokens: the base radius, the dock height and the rail width, and why a fixed element reads them.",
        ("Radius, dock height, rail width",),
    ),
    "motion": Page(
        "Animations and motion",
        "The keyframe table, the motion vocabulary for entrances and exits, the reduced-motion rules and "
        "icon motion.",
        ("Animations, motion vocabulary, motion, icon motion",),
    ),
    "focus-states": Page(
        None,
        "The keyboard focus ring baseline, the hover transition and the interaction states every control "
        "follows.",
        ("Focus rings and interaction states",),
    ),
    "accessibility": Page(
        None,
        "The accessibility rules, and the list of `jsx-a11y` suppressions that a guard holds to the "
        "sources.",
        ("Accessibility rules, the `jsx-a11y` suppressions",),
    ),
    "rows-and-drawers": Page(
        "Row actions, list rows and drawer panels",
        "Row actions, full-width list rows, the drawer panel frame and the drawer row metric.",
        ("Row actions, full-width list rows, drawer panel frame, drawer row metric",),
    ),
    "overflow-and-shrink": Page(
        "Overflowing text and flex shrink",
        "How text overflows inside a row, and why a flex item or a grid track must be told it may "
        "shrink.",
        ("Overflowing text, flex items, grid tracks",),
    ),
    "tree-navigation": Page(
        None,
        "The collection tree as a WAI-ARIA treeview with one tab stop: its roles, keys and the roving-tabindex "
        "protocol.",
        ("Roving tabindex trees",),
    ),
    "dialogs": Page(
        "Dialog widths and height",
        "The four dialog widths, the one height cap and the band that scrolls.",
        ("Dialog widths, dialog height",),
    ),
    "layout": Page(
        None,
        "The window layout: the shell structure, the rails, the dock, the bottom panel, the drawer and how "
        "the side panels behave at a narrow window.",
        ("Push or overlay, resizable panels, rails, dock, bottom panel, drawer, pane toggles",),
    ),
    "component-patterns": Page(
        None,
        "Component patterns: the states of a data pane, error text, tab strips, loading, cards, "
        "eyebrow labels and status badges.",
        ("Empty, error and loading, tab strips, cards, eyebrows, status badges",),
    ),
    "feedback-and-dashboard": Page(
        "Toasts, feedback, destructive actions and dashboard components",
        "Toasts, inline rename, copy feedback, times, disabled hints, destructive actions and the "
        "dashboard header, metric cards and progress bar.",
        ("Toasts, inline rename, copy feedback, `DisabledHint`, destructive actions, dashboard parts",),
    ),
    "utilities-editor-scrollbar": Page(
        "Utility classes, editor widgets and scrollbars",
        "The Tailwind utility reference and the classes never to use, how the Monaco editor widgets are "
        "themed, and the scrollbar rules.",
        ("Tailwind utility reference, Monaco widgets, scrollbars",),
    ),
}

SPLIT = Split(
    source="docs/design-system.md",
    markers=MARKERS,
    pages=PAGES,
    table_columns=("Covers",),
    table_intro="Each page holds the tokens or the patterns of one family.",
    table_before="## Source Files",
    prog="split-design-system",
)

if __name__ == "__main__":
    sys.exit(main(SPLIT))
