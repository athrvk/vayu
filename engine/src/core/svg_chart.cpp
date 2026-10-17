/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/svg_chart.cpp
 * @brief Line charts of a run's time series as inline `<svg>` (#2135).
 */

#include "svg_chart.hpp"

#include "vayu/core/run_export_view.hpp"
#include "vayu/utils/text_escape.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <format>
#include <ranges>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::core {

using vayu::utils::escape_html;

std::vector<ChartPoint>
chart_envelope (const std::vector<ChartPoint>& points, std::size_t limit) {
    const std::size_t buckets = limit / 2;
    if (points.size () <= limit || buckets == 0) {
        return points;
    }
    std::vector<ChartPoint> out;
    out.reserve (buckets * 2);
    for (std::size_t bucket = 0; bucket < buckets; ++bucket) {
        const auto first = points.begin () +
        static_cast<std::ptrdiff_t> (bucket * points.size () / buckets);
        const auto last = points.begin () +
        static_cast<std::ptrdiff_t> ((bucket + 1) * points.size () / buckets);
        const auto [lowest, highest] = std::minmax_element (first, last,
        [] (const ChartPoint& a, const ChartPoint& b) { return a.y < b.y; });
        // minmax_element returns the last of equal maxima; time order is what matters.
        if (lowest == highest) {
            out.push_back (*lowest);
        } else if (lowest < highest) {
            out.insert (out.end (), { *lowest, *highest });
        } else {
            out.insert (out.end (), { *highest, *lowest });
        }
    }
    return out;
}

std::string format_chart_coordinate (double value) {
    // Layout arithmetic lands on exact decimal ties (106.85) one ulp either
    // side of the tie, and the side depends on whether the compiler contracts
    // a*b+c into a fused multiply-add: Apple clang on arm64 does, GCC and MSVC
    // on x86 do not, so "{:.1f}" alone printed 106.9 on one and 106.8 on the
    // other. The tie is resolved here, half away from zero, by an offset far
    // above the arithmetic's error (~1e-13) and far below the 0.05 between a
    // tie and the next value that rounds differently. The goldens are compared
    // byte for byte on every platform (#2135).
    constexpr double TIE_NUDGE = 1e-6;
    const double tenths = std::round ((value * 10.0) + std::copysign (TIE_NUDGE, value));
    return std::format ("{:.1f}", tenths / 10.0);
}

namespace {

// --- layout, in the viewBox's units ------------------------------------------------------------

constexpr double WIDTH        = 720.0;
constexpr double LEFT         = 58.0;
constexpr double RIGHT_MARGIN = 124.0;
constexpr double PLOT_WIDTH   = WIDTH - LEFT - RIGHT_MARGIN;
constexpr double PLOT_HEIGHT  = 140.0;
constexpr double TOP          = 6.0;
constexpr double TITLE_HEIGHT = 20.0;
constexpr double PANEL_GAP    = 16.0;
constexpr double X_AXIS_BAND  = 44.0;
constexpr double LABEL_GAP    = 13.0;

constexpr int MAX_Y_INTERVALS = 5;
constexpr int MAX_X_INTERVALS = 6;

/// @p text escaped, for the one door every interpolated string goes through.
std::string safe (std::string_view text) {
    return escape_html (text);
}

// --- axes ------------------------------------------------------------------------------------------------

/// The smallest 1, 2 or 5 times a power of ten that covers [0, @p max_value] in
/// at most @p max_intervals steps.
double nice_step (double max_value, int max_intervals) {
    if (!(max_value > 0)) {
        return 1.0;
    }
    const double base =
    std::pow (10.0, std::floor (std::log10 (max_value / max_intervals)));
    for (const double multiple : { 1.0, 2.0, 5.0 }) {
        if (std::ceil ((max_value / (multiple * base)) - 1e-9) <= max_intervals) {
            return multiple * base;
        }
    }
    return 10.0 * base;
}

struct YAxis {
    double top  = 1.0;
    double step = 0.5;
};

/// 0 up to a round number that covers @p max_value.
YAxis y_axis_for (double max_value) {
    if (!(max_value > 0)) {
        return {};
    }
    const double step = nice_step (max_value, MAX_Y_INTERVALS);
    return { std::ceil ((max_value / step) - 1e-9) * step, step };
}

/// The multiples of @p step from 0 to @p top.
std::vector<double> tick_values (double top, double step) {
    std::vector<double> ticks;
    for (int index = 0; index * step <= top + 1e-9; ++index) {
        ticks.push_back (index * step);
    }
    return ticks;
}

struct Frame {
    double top_px = 0.0;
    double x_max  = 1.0;
    double y_top  = 1.0;

    [[nodiscard]] double x_of (double seconds) const {
        return LEFT + (std::clamp (seconds / x_max, 0.0, 1.0) * PLOT_WIDTH);
    }
    [[nodiscard]] double y_of (double value) const {
        return top_px + PLOT_HEIGHT - (std::clamp (value / y_top, 0.0, 1.0) * PLOT_HEIGHT);
    }
};

std::string y_axis_markup (const Frame& frame, const YAxis& axis, std::string_view title) {
    std::string grid = "<path class=\"grid\" d=\"";
    std::string labels;
    for (const double value : tick_values (axis.top, axis.step)) {
        const std::string y = format_chart_coordinate (frame.y_of (value));
        grid += "M" + format_chart_coordinate (LEFT) + " " + y + "H" +
        format_chart_coordinate (LEFT + PLOT_WIDTH);
        labels += "<text class=\"tick y\" x=\"" + format_chart_coordinate (LEFT - 8) +
        "\" y=\"" + y + "\" text-anchor=\"end\" dominant-baseline=\"central\">" +
        safe (format_run_figure (value)) + "</text>";
    }
    grid += "\"/>";
    const std::string bottom = format_chart_coordinate (frame.top_px + PLOT_HEIGHT);
    return "<text class=\"axis-title\" x=\"" + format_chart_coordinate (LEFT) +
    "\" y=\"" + format_chart_coordinate (frame.top_px - 8) + "\">" +
    safe (title) + "</text>" + grid + labels + "<path class=\"axis\" d=\"M" +
    format_chart_coordinate (LEFT) + " " + format_chart_coordinate (frame.top_px) +
    "V" + bottom + "H" + format_chart_coordinate (LEFT + PLOT_WIDTH) + "\"/>";
}

std::string x_axis_markup (const Frame& frame, std::string_view title) {
    const double step = nice_step (frame.x_max, MAX_X_INTERVALS);
    const double base = frame.top_px + PLOT_HEIGHT;
    std::string out;
    for (const double value : tick_values (frame.x_max, step)) {
        out += "<text class=\"tick x\" x=\"" +
        format_chart_coordinate (frame.x_of (value)) + "\" y=\"" +
        format_chart_coordinate (base + 15) + "\" text-anchor=\"middle\">" +
        safe (format_run_figure (value)) + "</text>";
    }
    return out + "<text class=\"axis-title\" x=\"" +
    format_chart_coordinate (LEFT + (PLOT_WIDTH / 2)) + "\" y=\"" +
    format_chart_coordinate (base + 34) + "\" text-anchor=\"middle\">" +
    safe (title) + "</text>";
}

// --- series ------------------------------------------------------------------------------------------------

struct Extremes {
    double min    = 0.0;
    double max    = 0.0;
    double peak_x = 0.0;
};

Extremes extremes_of (const std::vector<ChartPoint>& points) {
    Extremes out;
    if (points.empty ()) {
        return out;
    }
    out.min = out.max = points.front ().y;
    out.peak_x        = points.front ().x;
    for (const ChartPoint& point : points) {
        out.min = std::min (out.min, point.y);
        if (point.y > out.max) {
            out.max    = point.y;
            out.peak_x = point.x;
        }
    }
    return out;
}

/// `p95: min 171 ms, max 903 ms, peak at 42 s`, from every sample.
std::string describe_series (const ChartSeries& series) {
    const Extremes seen = extremes_of (series.points);
    return series.name + ": min " + format_run_figure (seen.min) + series.unit +
    ", max " + format_run_figure (seen.max) + series.unit + ", peak at " +
    format_run_seconds (seen.peak_x);
}

/// A label for the line's end, which `spread_labels` keeps readable.
struct EndLabel {
    std::string text;
    std::string style;
    double y = 0.0;
};

std::string line_markup (const Frame& frame,
const ChartSeries& series,
const std::vector<ChartPoint>& drawn) {
    const std::string style = safe (series.style);
    if (drawn.size () == 1) {
        return "<circle class=\"dot s-" + style + "\" cx=\"" +
        format_chart_coordinate (frame.x_of (drawn.front ().x)) + "\" cy=\"" +
        format_chart_coordinate (frame.y_of (drawn.front ().y)) + "\" r=\"2.5\"/>";
    }
    std::string points;
    for (const ChartPoint& point : drawn) {
        points += (points.empty () ? "" : " ") +
        format_chart_coordinate (frame.x_of (point.x)) + "," +
        format_chart_coordinate (frame.y_of (point.y));
    }
    return "<polyline class=\"line s-" + style + "\" points=\"" + points + "\"/>";
}

/// The series drawn, with a `<title>` the browser shows on hover; its end label is added to @p labels.
std::string series_markup (const Frame& frame,
const ChartSeries& series,
std::vector<EndLabel>& labels) {
    if (series.points.empty ()) {
        return {};
    }
    const std::vector<ChartPoint> drawn = chart_envelope (series.points);
    labels.push_back ({ series.name, series.style, frame.y_of (drawn.back ().y) });
    return "<g class=\"series\"><title>" + safe (describe_series (series)) +
    "</title>" + line_markup (frame, series, drawn) + "</g>";
}

/// Pushes labels apart until each is @ref LABEL_GAP below the one above, then back
/// up into [@p lowest, @p highest] so the last is not pushed off the plot.
void spread_labels (std::vector<EndLabel>& labels, double lowest, double highest) {
    std::ranges::sort (labels, {}, &EndLabel::y);
    double floor = lowest;
    for (EndLabel& label : labels) {
        label.y = std::max (label.y, floor);
        floor   = label.y + LABEL_GAP;
    }
    double ceiling = highest;
    for (EndLabel& label : std::views::reverse (labels)) {
        label.y = std::min (label.y, ceiling);
        ceiling = label.y - LABEL_GAP;
    }
}

std::string labels_markup (std::vector<EndLabel>& labels, const Frame& frame) {
    spread_labels (labels, frame.top_px, frame.top_px + PLOT_HEIGHT);
    std::string out;
    for (const EndLabel& label : labels) {
        out += "<text class=\"direct " + safe (label.style) + "\" x=\"" +
        format_chart_coordinate (LEFT + PLOT_WIDTH + 8) + "\" y=\"" +
        format_chart_coordinate (label.y) +
        "\" dominant-baseline=\"central\">" + safe (label.text) + "</text>";
    }
    return out;
}

// --- panels ------------------------------------------------------------------------------------------------

double peak_of (const ChartPanel& panel) {
    double peak = 0.0;
    for (const ChartSeries& series : panel.series) {
        for (const ChartPoint& point : series.points) {
            peak = std::max (peak, point.y);
        }
    }
    return peak;
}

/// The reference line, labelled at its end like a series. A declared budget is
/// always drawn, so the axis reaches it however far above the data it lies.
std::string reference_markup (const Frame& frame,
const ChartReference& reference,
std::vector<EndLabel>& labels) {
    const double y_px = frame.y_of (reference.value);
    labels.push_back ({ reference.label, "ref", y_px });
    return "<path class=\"ref\" d=\"M" + format_chart_coordinate (LEFT) + " " +
    format_chart_coordinate (y_px) + "H" +
    format_chart_coordinate (LEFT + PLOT_WIDTH) + "\"/>";
}

/// The value the y-axis must reach: the data's peak, or the reference if higher.
double axis_peak (const ChartPanel& panel, double peak) {
    return panel.reference ? std::max (peak, panel.reference->value) : peak;
}

std::string panel_markup (const ChartPanel& panel, double top_px, double x_max) {
    const double peak = peak_of (panel);
    const YAxis axis  = y_axis_for (axis_peak (panel, peak));
    const Frame frame{ top_px, x_max, axis.top };

    std::vector<EndLabel> labels;
    std::string out = "<g class=\"panel\">" + y_axis_markup (frame, axis, panel.title);
    for (const ChartSeries& series : panel.series) {
        out += series_markup (frame, series, labels);
    }
    if (panel.reference) {
        out += reference_markup (frame, *panel.reference, labels);
    }
    return out + labels_markup (labels, frame) + "</g>";
}

// --- the chart --------------------------------------------------------------------------------------------

double x_extent (const Chart& chart) {
    double extent = 0.0;
    for (const ChartPanel& panel : chart.panels) {
        for (const ChartSeries& series : panel.series) {
            for (const ChartPoint& point : series.points) {
                extent = std::max (extent, point.x);
            }
        }
    }
    return extent > 0 ? extent : 1.0;
}

double panel_height () {
    return TITLE_HEIGHT + PLOT_HEIGHT;
}

/// What the chart says in words: one sentence per series, from every sample.
std::string description_of (const Chart& chart) {
    std::string out;
    for (const ChartPanel& panel : chart.panels) {
        for (const ChartSeries& series : panel.series) {
            out += (out.empty () ? "" : ". ") + describe_series (series);
        }
    }
    return out.empty () ? "No samples." : out + ".";
}

} // namespace

std::string render_svg_chart (const Chart& chart) {
    const double x_max  = x_extent (chart);
    const double count  = static_cast<double> (chart.panels.size ());
    const double height = TOP + (count * panel_height ()) +
    (std::max (count - 1, 0.0) * PANEL_GAP) + X_AXIS_BAND;
    const std::string id = safe (chart.id) + "-desc";

    std::string out = "<svg class=\"chart\" viewBox=\"0 0 " +
    format_chart_coordinate (WIDTH) + " " + format_chart_coordinate (height) +
    "\" role=\"img\" aria-label=\"" + safe (chart.label) +
    "\" aria-describedby=\"" + id + "\"><title>" + safe (chart.label) +
    "</title><desc id=\"" + id + "\">" + safe (description_of (chart)) + "</desc>";
    double plot_top = TOP + TITLE_HEIGHT;
    for (const ChartPanel& panel : chart.panels) {
        out += panel_markup (panel, plot_top, x_max);
        plot_top += panel_height () + PANEL_GAP;
    }
    // The shared x-axis sits under the last panel's plot.
    const double last_plot_top = plot_top - panel_height () - PANEL_GAP;
    return out + x_axis_markup (Frame{ last_plot_top, x_max, 1.0 }, chart.x_title) + "</svg>";
}

} // namespace vayu::core
