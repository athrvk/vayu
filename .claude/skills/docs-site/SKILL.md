---
name: docs-site
description: Rules for the published MkDocs site under docs/ - nav entries, relative links, heading anchors, analytics gating, and local preview. Use when adding, renaming, moving or linking a page under docs/, or when touching .github/mkdocs.yml, the docs workflow or its hooks.
---

# `docs/` is published, so a broken link is a build failure

`docs/` ships to <https://athrvk.github.io/vayu/> via MkDocs Material
(`.github/mkdocs.yml`, `.github/workflows/docs.yml`, deps pinned in
`requirements-docs.txt`). `mkdocs build --strict` runs on every docs-touching
pull request and fails on an unresolvable relative `.md` link or a missing
heading anchor, so:

- **Add a new page to the `nav:` in `.github/mkdocs.yml`** in the same commit.
  Off-nav pages build and are reachable by URL, but never appear in the sidebar.
- **Do not rename or move a doc file** without checking for readers. Tests read
  doc paths (`app/src/design-system-doc.test.ts` reads `docs/design-system.md`;
  `app/src/state-management-doc.test.ts` reads `docs/app/state-management.md`,
  `architecture.md` and `api-integration.md`, and fails on a `useXxx` or
  `SCREAMING_CASE` name they quote that no longer exists in the app source),
  and every relative cross-link is validated by the build.
- **Anchors follow GitHub's slug rules** (`pymdownx.slugs.slugify` is configured
  for exactly this), so one anchor form works both in GitHub's markdown view and
  on the site. Heading punctuation counts: `## Shared Auth Fields
  (components/shared/AuthFields/)` is `#shared-auth-fields-componentssharedauthfields`.
- **Links out of `docs/`** (`SECURITY.md`, `LICENSE`, `CONTRIBUTING.md`) must be
  absolute `https://github.com/athrvk/vayu/blob/master/...` URLs - those files
  are outside the published tree.
- **Analytics is on the published site only, and only when it has an ID.** The
  GA4 measurement ID comes from the `GOOGLE_ANALYTICS_KEY` Actions *repository
  variable* (Settings -> Secrets and variables -> Actions -> Variables), read by
  `extra.analytics.property` via `!ENV`. With it unset - every fork, every
  pull-request preview, every local `mkdocs serve` - `.github/hooks/analytics.py`
  strips `extra.analytics`, `extra.consent` and the footer's "Cookie settings"
  link, so those builds ship no tracker and no banner. `!ENV` alone does **not**
  do this: Material emits its gtag snippet even for an empty property, which is
  the whole reason that hook exists. On the published site GA is consent-gated -
  the snippet is defined but only runs once the visitor accepts. **This is the
  docs website, not the app**; `no telemetry` in `docs/index.md` and `README.md`
  is a claim about the app and stays true, so keep the two apart when editing
  either.
- **Every page needs a front-matter `description:`.** It is the page's
  `<meta name="description">` *and* the description on its social card, and the
  strict build does not check for it - a page without one silently inherits
  `site_description`, which describes the product rather than the page. New
  pages get one in the same commit.
- **One social card for the whole site.** `og:image` / `twitter:image` point at
  `docs/images/social-card.png`, a designed 1200x630 asset wired in
  `.github/overrides/main.html`. Its source and the exact regeneration command
  are in `.github/social-card/social-card.html` - edit that and re-render rather
  than touching the PNG, because the card carries the positioning sentence and a
  benchmark figure that both move. The same asset is the repo's GitHub social
  preview. `main.html` also emits every page's `<title>` and the home page's
  structured data, which is why `.github/overrides/**` is in `docs.yml`'s
  `paths:` filters: an edit there changes every published page with nothing
  under `docs/` to trigger the deploy.
- **Jekyll is not an option here** and the workflow says why: Pages' default
  Jekyll build runs Liquid over page content, and these docs contain 40+
  `{{variable}}` examples (rendered as empty strings) plus `{% ... %}` (an
  unknown tag, which fails the build). MkDocs never templates page content.

Preview locally with `pip install -r requirements-docs.txt && mkdocs serve -f
.github/mkdocs.yml`. The `-f` is required - the config is not at the repo root -
and the site serves under `/vayu/`. The favicon/logo are not files under `docs/`:
`.github/hooks/brand_assets.py` pulls `shared/icon_png/vayu_icon_256x256.png`
into the build, so do not add a copy.

`install.sh` at the repo root is also published at the site root by
`.github/hooks/install_script.py`, which is why it appears in the `paths:`
filters of `docs.yml`.
