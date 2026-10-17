#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/svg_chart.hpp
 * @brief Line charts of a run's time series as inline `<svg>` (#2135).
 *
 * The markup carries no script, no external reference and no `url(...)`, so a
 * page that embeds it loads nothing. Colour comes from CSS classes the host
 * page defines (`s-<style>` per series), which is what lets one stylesheet
 * switch the charts between light, dark and print. A chart holds to four
 * rules a reader would otherwise have to check by eye: every y-axis starts at
 * 0 and names its unit; a series is drawn from at most
 * @ref MAX_CHART_POINTS points however long the run, with each bucket's
 * minimum and maximum kept so a one-sample spike survives; each series is
 * labelled where it ends instead of in a legend; and the chart states each
 * series' minimum, maximum and the time of its peak in its `<desc>`.
 */

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

namespace vayu::core {

/// The most points a series is drawn from: 240 buckets of a minimum and a maximum.
inline constexpr std::size_t MAX_CHART_POINTS = 480;

struct ChartPoint {
    /// Seconds from the start of the run.
    double x = 0.0;
    double y = 0.0;
};

struct ChartSeries {
    /// Said beside the line's end and in the description: `p95`, `Virtual users`.
    std::string name;
    /// The class suffix the host page's stylesheet colours: `p95` is `s-p95`.
    std::string style;
    /// Appended to a figure in the description: ` ms`, ` req/s`, or empty.
    std::string unit;
    /// Every sample, in time order; the chart thins them itself.
    std::vector<ChartPoint> points;
};

/// A horizontal line the data is read against (a budget).
struct ChartReference {
    std::string label;
    double value = 0.0;
};

/// One y-axis and the series drawn against it. Panels stack and share the x-axis.
struct ChartPanel {
    /// Names the axis and its unit: `Throughput (req/s)`.
    std::string title;
    std::vector<ChartSeries> series;
    std::optional<ChartReference> reference;
};

struct Chart {
    /// Distinguishes the chart's description from another's on the same page.
    std::string id;
    /// The chart's accessible name.
    std::string label;
    std::string x_title = "Seconds from start";
    std::vector<ChartPanel> panels;
};

/// @p points thinned to at most @p limit, each bucket of consecutive samples
/// reduced to the pair holding its minimum and its maximum, in time order.
/// Fewer samples than @p limit come back unchanged.
[[nodiscard]] std::vector<ChartPoint> chart_envelope (const std::vector<ChartPoint>& points,
std::size_t limit = MAX_CHART_POINTS);

/// @p value to one decimal for SVG markup, a tie rounding away from zero on
/// every platform however the value was computed (see the definition).
[[nodiscard]] std::string format_chart_coordinate (double value);

/// @p chart as one `<svg>` element.
[[nodiscard]] std::string render_svg_chart (const Chart& chart);

} // namespace vayu::core
