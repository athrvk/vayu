"""Drop analytics and the cookie banner from builds that have no measurement ID.

`extra.analytics.property` in mkdocs.yml is `!ENV GOOGLE_ANALYTICS_KEY`, which
resolves to `None` on a fork, a pull-request preview or a local `mkdocs serve`.
That is *not* enough on its own to switch analytics off: Material's
`partials/integrations/analytics/google.html` has no guard on an empty property,
so it still emits the `__md_analytics()` snippet and would still request
`gtag/js?id=` with an empty id once a visitor accepted cookies. Nothing is
collected - Google has no property to attribute an empty id to - but the page
carries dead tracking code and, worse, shows a cookie-consent banner asking
permission for a tracker that does not exist.

So the switch lives here instead: no key, no `extra.analytics` and no
`extra.consent`, and the two are removed together on purpose. A consent banner
whose only cookie is one the build cannot set is a dialog that lies to the
visitor, and it would be the *only* thing most contributors ever saw of this
feature, on every local preview.

The same switch owns the footer's "Cookie settings" link, for the same reason: it
is the only route back into the dialog once the banner has been dismissed, and
`#__consent` resolves to nothing on a build that has no dialog.

Wired up via `hooks:` in mkdocs.yml, after brand_assets. Deleting this file
leaves a working site - just one that ships the inert snippet and the banner
everywhere, and no way to reopen the banner.
"""

from __future__ import annotations

import logging

log = logging.getLogger("mkdocs.hooks.analytics")

# Material re-opens the consent dialog for this anchor specifically; it is not a
# link to a page. Appended to `copyright` in mkdocs.yml.
CONSENT_LINK = ' &middot; <a href="#__consent">Cookie settings</a>'


def on_config(config):
    analytics = config.extra.get("analytics") or {}

    # `.strip()` so a repository variable that exists but was blanked out counts
    # as "off" - emptying the variable is the documented way to disable
    # analytics without a commit, and GitHub hands an empty variable through as
    # an empty string rather than leaving it unset.
    if (analytics.get("property") or "").strip():
        if config.copyright and CONSENT_LINK not in config.copyright:
            config.copyright += CONSENT_LINK
        return config

    config.extra.pop("analytics", None)
    config.extra.pop("consent", None)

    # INFO, not a warning: this is the correct and expected state for every
    # build that is not the deploy from master, and `mkdocs build --strict`
    # turns warnings into failures.
    log.info(
        "GOOGLE_ANALYTICS_KEY is unset - building without analytics or the "
        "cookie consent banner."
    )
    return config
