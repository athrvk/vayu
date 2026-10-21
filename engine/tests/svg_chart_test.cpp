/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/svg_chart_test.cpp
 * @brief The inline-SVG line charts of the HTML run report (#2135): thinning
 *        that keeps a spike, axes that start at zero and name their unit,
 *        descriptions from every sample, and markup that loads nothing.
 *
 * Mutation checks: drop the tie nudge from `format_chart_coordinate` and the
 * neighbour case reds, print the value unsnapped and the spelling case reds
 * too (both on any platform); thin by taking every Nth sample and the spike case reds;
 * start an axis at the data's minimum and the zero-axis case reds; drop the
 * `safe` wrapper from a label and the escaping case reds; skip the reference
 * line when it lies far above the data and the far-budget case reds.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include "../src/core/svg_chart.hpp"
#include "chart_decode.hpp"

namespace {

using vayu::core::Chart;
using vayu::core::chart_envelope;
using vayu::core::ChartPanel;
using vayu::core::ChartPoint;
using vayu::core::ChartReference;
using vayu::core::ChartSeries;
using vayu::core::format_chart_coordinate;
using vayu::core::MAX_CHART_POINTS;
using vayu::core::render_svg_chart;
using vayu::tests::drawn_values;
using vayu::tests::panels_in;
using vayu::tests::y_labels_bottom_up;

/// One sample a second, valued by @p value of its index.
template <typename Value>
std::vector<ChartPoint> per_second (std::size_t count, Value value) {
    std::vector<ChartPoint> points;
    points.reserve (count);
    for (std::size_t at = 0; at < count; ++at) {
        points.push_back ({ static_cast<double> (at) + 1.0, value (at) });
    }
    return points;
}

ChartSeries series_of (std::string name,
std::string style,
std::vector<ChartPoint> points,
std::string unit = "") {
    return { std::move (name), std::move (style), std::move (unit), std::move (points) };
}

Chart one_panel (std::string title, std::vector<ChartSeries> series) {
    return { "c", "A chart", "Seconds from start",
        { { std::move (title), std::move (series), std::nullopt } } };
}

// --- coordinates ----------------------------------------------------------------------------

struct Tie {
    double value;
    std::string_view rounded;
};

/// Decimal ties that landed one digit apart on macOS arm64 and Linux x86_64 (#2135).
constexpr std::array<Tie, 10> TIES = { {
{ 106.85, "106.9" },
{ 107.55, "107.6" },
{ 152.15, "152.2" },
{ 313.55, "313.6" },
{ 555.65, "555.7" },
{ -106.85, "-106.9" },
{ -107.55, "-107.6" },
{ -152.15, "-152.2" },
{ -313.55, "-313.6" },
{ -555.65, "-555.7" },
} };

/// @p tie as arithmetic with a different error than its literal: halved from its
/// double, whole plus fraction, a product of tenths, and the single rounding of a
/// fused multiply-add against the two roundings of a separate one.
std::vector<double> spellings_of (double tie) {
    const double whole    = std::trunc (tie);
    const double tenths   = tie * 10.0;
    volatile double split = 0.1 * (tenths - (whole * 10.0));
    return { tie, (tie * 2.0) / 2.0, whole + (tie - whole), tenths * 0.1,
        std::fma (0.1, tenths - (whole * 10.0), whole), whole + split,
        std::fma (tenths, 0.1, 0.0), std::fma (tie, 1.0, 0.0) };
}

TEST (ChartCoordinateTest, ATieRoundsAwayFromZeroHoweverItWasComputed) {
    for (const Tie& tie : TIES) {
        for (const double spelling : spellings_of (tie.value)) {
            EXPECT_EQ (format_chart_coordinate (spelling), tie.rounded) << tie.value;
        }
    }
}

TEST (ChartCoordinateTest, ATieRoundsTheSameWhicheverNeighbourTheArithmeticLandedOn) {
    for (const Tie& tie : TIES) {
        double below = tie.value;
        double above = tie.value;
        for (int ulps = 0; ulps < 8; ++ulps) {
            below = std::nextafter (below, 0.0);
            above = std::nextafter (above, tie.value * 2.0);
            EXPECT_EQ (format_chart_coordinate (below), tie.rounded)
            << tie.value << " - " << ulps;
            EXPECT_EQ (format_chart_coordinate (above), tie.rounded)
            << tie.value << " + " << ulps;
        }
    }
}

TEST (ChartCoordinateTest, AValueOffATieStillRoundsToTheNearestTenth) {
    EXPECT_EQ (format_chart_coordinate (106.84), "106.8");
    EXPECT_EQ (format_chart_coordinate (106.86), "106.9");
    EXPECT_EQ (format_chart_coordinate (-106.84), "-106.8");
    EXPECT_EQ (format_chart_coordinate (-106.86), "-106.9");
    EXPECT_EQ (format_chart_coordinate (0.0), "0.0");
    EXPECT_EQ (format_chart_coordinate (720.0), "720.0");
}

// --- thinning ----------------------------------------------------------------------------

TEST (ChartEnvelopeTest, ASeriesWithinTheLimitIsDrawnWhole) {
    const auto points = per_second (
    MAX_CHART_POINTS, [] (std::size_t at) { return static_cast<double> (at); });
    const auto drawn = chart_envelope (points);
    ASSERT_EQ (drawn.size (), points.size ());
    EXPECT_EQ (drawn.front ().y, points.front ().y);
    EXPECT_EQ (drawn.back ().y, points.back ().y);
}

TEST (ChartEnvelopeTest, NeverDrawsMoreThanTheLimitHoweverLongTheRun) {
    for (const std::size_t count : { std::size_t{ 481 }, std::size_t{ 999 },
         std::size_t{ 7200 }, std::size_t{ 20000 }, std::size_t{ 100001 } }) {
        const auto points = per_second (count,
        [] (std::size_t at) { return std::sin (static_cast<double> (at)); });
        EXPECT_LE (chart_envelope (points).size (), MAX_CHART_POINTS) << count;
    }
}

TEST (ChartEnvelopeTest, AOneSampleSpikeSurvivesThinning) {
    constexpr std::size_t SPIKE_AT = 5000;
    const auto points              = per_second (
    20000, [] (std::size_t at) { return at == SPIKE_AT ? 5000.0 : 240.0; });
    const auto drawn = chart_envelope (points);
    const auto top   = std::ranges::max_element (drawn, {}, &ChartPoint::y);
    ASSERT_NE (top, drawn.end ());
    EXPECT_EQ (top->y, 5000.0);
    // The spike keeps its own time, not its bucket's.
    EXPECT_EQ (top->x, static_cast<double> (SPIKE_AT) + 1.0);
}

TEST (ChartEnvelopeTest, AOneSampleDipSurvivesToo) {
    const auto points =
    per_second (20000, [] (std::size_t at) { return at == 777 ? 0.0 : 400.0; });
    const auto drawn = chart_envelope (points);
    EXPECT_EQ (std::ranges::min_element (drawn, {}, &ChartPoint::y)->y, 0.0);
}

TEST (ChartEnvelopeTest, KeepsTimeOrder) {
    const auto points = per_second (5000,
    [] (std::size_t at) { return static_cast<double> ((at * 7919) % 101); });
    const auto drawn  = chart_envelope (points);
    EXPECT_TRUE (std::ranges::is_sorted (drawn, {}, &ChartPoint::x));
}

// --- axes ------------------------------------------------------------------------------------

TEST (SvgChartTest, EveryYAxisStartsAtZeroWhateverTheDataDoes) {
    // A series that never goes near zero still has its axis start there.
    const auto far_from_zero = per_second (30, [] (std::size_t) { return 950.0; });
    const Chart chart     = { "c", "Two panels", "Seconds from start",
            { { "Throughput (req/s)",
              { series_of ("Throughput", "rps", far_from_zero, " req/s") }, std::nullopt },
            { "Virtual users", { series_of ("Virtual users", "vus", far_from_zero) },
            std::nullopt } } };
    const std::string svg = render_svg_chart (chart);
    const auto panels     = panels_in (svg);
    ASSERT_EQ (panels.size (), 2U);
    for (const std::string_view panel : panels) {
        const auto labels = y_labels_bottom_up (panel);
        ASSERT_FALSE (labels.empty ());
        EXPECT_EQ (labels.front (), "0") << panel;
    }
    EXPECT_NE (svg.find (">Throughput (req/s)</text>"), std::string::npos);
    EXPECT_NE (svg.find (">Virtual users</text>"), std::string::npos);
    EXPECT_NE (svg.find (">Seconds from start</text>"), std::string::npos);
}

TEST (SvgChartTest, TicksAreRoundNumbersThatCoverThePeak) {
    struct Case {
        double peak;
        std::vector<std::string> labels;
    };
    for (const Case& test : { Case{ 520, { "0", "200", "400", "600" } },
         Case{ 500, { "0", "100", "200", "300", "400", "500" } },
         Case{ 0.8, { "0", "0.2", "0.4", "0.6", "0.8" } },
         Case{ 1300, { "0", "500", "1,000", "1,500" } } }) {
        const auto svg = render_svg_chart (one_panel (
        "t", { series_of ("s", "rps", { { 1, 0.1 }, { 2, test.peak } }) }));
        EXPECT_EQ (y_labels_bottom_up (svg), test.labels) << test.peak;
    }
}

TEST (SvgChartTest, ASeriesOfNothingButZerosStillHasAnAxis) {
    const auto svg = render_svg_chart (
    one_panel ("t", { series_of ("s", "rps", { { 1, 0 }, { 2, 0 } }) }));
    EXPECT_EQ (y_labels_bottom_up (svg), (std::vector<std::string>{ "0", "0.5", "1" }));
}

TEST (SvgChartTest, TheLineIsDrawnAtTheValuesItWasGiven) {
    const auto svg = render_svg_chart (
    one_panel ("t", { series_of ("s", "rps", { { 1, 10 }, { 2, 2 }, { 3, 6 } }) }));
    const auto values = drawn_values (svg, "rps");
    ASSERT_EQ (values.size (), 3U);
    EXPECT_NEAR (values[0], 10.0, 0.3);
    EXPECT_NEAR (values[1], 2.0, 0.3);
    EXPECT_NEAR (values[2], 6.0, 0.3);
}

TEST (SvgChartTest, ASingleSampleIsADotBecauseALineOfOnePointIsInvisible) {
    const auto svg =
    render_svg_chart (one_panel ("t", { series_of ("s", "rps", { { 1, 3 } }) }));
    EXPECT_NE (svg.find ("<circle class=\"dot s-rps\""), std::string::npos) << svg;
    EXPECT_EQ (svg.find ("<polyline"), std::string::npos);
}

// --- words -------------------------------------------------------------------------------------------

TEST (SvgChartTest, TheDescriptionStatesMinMaxAndWhenEachSeriesPeaked) {
    auto points =
    per_second (60, [] (std::size_t at) { return at == 4 ? 5000.0 : 238.0; });
    const auto svg = render_svg_chart (
    one_panel ("Latency (ms)", { series_of ("p99", "p99", points, " ms") }));
    EXPECT_NE (svg.find ("<desc id=\"c-desc\">p99: min 238 ms, max 5,000 ms, "
                         "peak at 5 s.</desc>"),
    std::string::npos)
    << svg;
    EXPECT_NE (svg.find ("role=\"img\" aria-label=\"A chart\" "
                         "aria-describedby=\"c-desc\""),
    std::string::npos);
    EXPECT_NE (svg.find ("<title>A chart</title>"), std::string::npos);
    // Hovering the line says it too.
    EXPECT_NE (svg.find ("<g class=\"series\"><title>p99: min 238 ms, max "
                         "5,000 ms, peak at 5 s</title>"),
    std::string::npos);
}

TEST (SvgChartTest, TheDescriptionReadsEverySampleNotTheThinnedOnes) {
    const auto points =
    per_second (20000, [] (std::size_t at) { return at == 123 ? 9000.0 : 100.0; });
    const auto svg =
    render_svg_chart (one_panel ("t", { series_of ("p99", "p99", points, " ms") }));
    EXPECT_NE (svg.find ("max 9,000 ms, peak at 124 s"), std::string::npos)
    << svg.substr (0, 600);
}

TEST (SvgChartTest, LoadsNothingAndRunsNothing) {
    const auto svg = render_svg_chart (
    one_panel ("t", { series_of ("s", "rps", { { 1, 1 }, { 2, 2 } }) }));
    for (const std::string_view forbidden : { "url(", "://", "<script", "href",
         "xmlns", "<image", "<use", "<foreignObject", " src=" }) {
        EXPECT_EQ (svg.find (forbidden), std::string::npos) << forbidden;
    }
}

TEST (SvgChartTest, NamesAreEscapedWhereverTheyAreWritten) {
    const std::string hostile = "\"><script>alert(1)</script>";
    Chart chart               = one_panel (
    hostile, { series_of (hostile, "rps", { { 1, 1 }, { 2, 2 } }, hostile) });
    chart.label                     = hostile;
    chart.id                        = hostile;
    chart.panels.front ().reference = ChartReference{ hostile, 1.5 };
    const auto svg                  = render_svg_chart (chart);
    EXPECT_EQ (svg.find ("<script"), std::string::npos) << svg;
    EXPECT_NE (svg.find ("&lt;script&gt;"), std::string::npos);
}

// --- direct labels and the reference line ------------------------------------------------------------------

/// The y of every direct label, in document order.
std::vector<double> label_ys (const std::string& svg) {
    std::vector<double> ys;
    constexpr std::string_view OPEN = "<text class=\"direct";
    for (auto at = svg.find (OPEN); at != std::string::npos; at = svg.find (OPEN, at + 1)) {
        const auto tag = svg.substr (at, svg.find ('>', at) - at);
        ys.push_back (std::stod (vayu::tests::attribute_of (tag, "y")));
    }
    return ys;
}

TEST (SvgChartTest, LinesThatEndTogetherKeepTheirLabelsApart) {
    const auto same = per_second (10, [] (std::size_t) { return 100.0; });
    const auto svg  = render_svg_chart (one_panel ("t",
     { series_of ("p50", "p50", same), series_of ("p95", "p95", same),
     series_of ("p99", "p99", same) }));
    auto ys         = label_ys (svg);
    ASSERT_EQ (ys.size (), 3U);
    std::ranges::sort (ys);
    EXPECT_GE (ys[1] - ys[0], 12.0);
    EXPECT_GE (ys[2] - ys[1], 12.0);
}

TEST (SvgChartTest, ABudgetInsideTheScaleIsALabelledLineAndStretchesTheAxisToIt) {
    Chart chart = one_panel ("Latency (ms)",
    { series_of ("p95", "p95", per_second (10, [] (std::size_t) { return 170.0; }), " ms") });
    chart.panels.front ().reference = ChartReference{ "p95 budget 300 ms", 300.0 };
    const auto svg = render_svg_chart (chart);
    EXPECT_NE (svg.find ("<path class=\"ref\""), std::string::npos) << svg;
    EXPECT_NE (svg.find (">p95 budget 300 ms</text>"), std::string::npos);
    EXPECT_EQ (y_labels_bottom_up (svg).back (), "300");
}

TEST (SvgChartTest, ABudgetFarAboveTheDataIsStillDrawnAndTheAxisReachesIt) {
    Chart chart = one_panel ("Latency (ms)",
    { series_of ("p95", "p95", per_second (10, [] (std::size_t) { return 100.0; }), " ms") });
    chart.panels.front ().reference = ChartReference{ "p95 budget 500 ms", 500.0 };
    const auto svg = render_svg_chart (chart);
    EXPECT_NE (svg.find ("<path class=\"ref\""), std::string::npos) << svg;
    EXPECT_NE (svg.find (">p95 budget 500 ms</text>"), std::string::npos) << svg;
    EXPECT_EQ (svg.find ("above this scale"), std::string::npos);
    const auto labels = y_labels_bottom_up (svg);
    EXPECT_EQ (labels.front (), "0");
    EXPECT_EQ (labels.back (), "500");
    // The series is still there, drawn at its own value on the stretched axis.
    const auto values = drawn_values (svg, "p95");
    ASSERT_EQ (values.size (), 10U);
    EXPECT_NEAR (values.front (), 100.0, 0.5);
}

} // namespace
