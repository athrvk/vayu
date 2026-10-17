#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/chart_decode.hpp
 * @brief Reads a rendered chart back (#2135): the values a series is drawn
 *        at, recovered from its pixel coordinates and the panel's own tick
 *        labels, so a test asserts what a reader would see rather than how
 *        the renderer got there.
 */

#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::tests {

/// One y tick label of a panel: where it sits and what it says.
struct YTick {
    double y = 0.0;
    std::string label;
};

/// The text of @p attribute in @p tag, or empty.
inline std::string attribute_of (std::string_view tag, std::string_view attribute) {
    const std::string needle = " " + std::string (attribute) + "=\"";
    const auto start         = tag.find (needle);
    if (start == std::string_view::npos) {
        return {};
    }
    const auto from = start + needle.size ();
    return std::string (tag.substr (from, tag.find ('"', from) - from));
}

/// The numeric value of a tick label, `1,200` included.
inline double tick_value (std::string label) {
    std::erase (label, ',');
    return std::strtod (label.c_str (), nullptr);
}

/// Every `<text class="tick y" ...>label</text>` in @p markup, in document order.
inline std::vector<YTick> y_ticks_in (std::string_view markup) {
    constexpr std::string_view OPEN = "<text class=\"tick y\"";
    std::vector<YTick> ticks;
    for (auto at = markup.find (OPEN); at != std::string_view::npos;
    at           = markup.find (OPEN, at + 1)) {
        const auto tag_end = markup.find ('>', at);
        const auto close   = markup.find ("</text>", tag_end);
        const auto tag     = markup.substr (at, tag_end - at);
        ticks.push_back ({ std::strtod (attribute_of (tag, "y").c_str (), nullptr),
        std::string (markup.substr (tag_end + 1, close - tag_end - 1)) });
    }
    return ticks;
}

/// The `<g class="panel">` segments of @p svg, each a view up to the next.
inline std::vector<std::string_view> panels_in (std::string_view svg) {
    constexpr std::string_view OPEN = "<g class=\"panel\">";
    std::vector<std::string_view> panels;
    for (auto at = svg.find (OPEN); at != std::string_view::npos;) {
        const auto next = svg.find (OPEN, at + 1);
        panels.push_back (
        svg.substr (at, next == std::string_view::npos ? next : next - at));
        at = next;
    }
    return panels;
}

/// The panel's y tick labels, the floor of the plot first.
inline std::vector<std::string> y_labels_bottom_up (std::string_view panel) {
    std::vector<std::string> labels;
    for (const YTick& tick : y_ticks_in (panel)) {
        labels.push_back (tick.label);
    }
    return labels;
}

/// The polyline of the series styled `s-<style>` inside @p panel, as (x, y) pixels.
inline std::optional<std::vector<std::pair<double, double>>>
polyline_pixels (std::string_view panel, std::string_view style) {
    const std::string open = "<polyline class=\"line s-" + std::string (style) + "\"";
    const auto at = panel.find (open);
    if (at == std::string_view::npos) {
        return std::nullopt;
    }
    const auto tag  = panel.substr (at, panel.find ("/>", at) - at);
    const auto text = attribute_of (tag, "points");
    std::vector<std::pair<double, double>> pixels;
    for (std::size_t from = 0; from < text.size ();) {
        const auto end = text.find (' ', from);
        const auto pair = text.substr (from, end == std::string::npos ? end : end - from);
        const auto comma = pair.find (',');
        pixels.emplace_back (std::strtod (pair.substr (0, comma).c_str (), nullptr),
        std::strtod (pair.substr (comma + 1).c_str (), nullptr));
        from = end == std::string::npos ? text.size () : end + 1;
    }
    return pixels;
}

/// The values the series styled `s-<style>` is drawn at, recovered through the
/// panel's lowest and highest tick labels. Empty when it is not drawn.
inline std::vector<double> drawn_values (std::string_view panel, std::string_view style) {
    const auto pixels = polyline_pixels (panel, style);
    const auto ticks  = y_ticks_in (panel);
    if (!pixels || ticks.size () < 2) {
        return {};
    }
    const YTick& floor = ticks.front ();
    const YTick& ceil  = ticks.back ();
    const double per_pixel =
    (tick_value (ceil.label) - tick_value (floor.label)) / (ceil.y - floor.y);
    std::vector<double> values;
    for (const auto& [x, y] : *pixels) {
        values.push_back (tick_value (floor.label) + ((y - floor.y) * per_pixel));
    }
    return values;
}

} // namespace vayu::tests
