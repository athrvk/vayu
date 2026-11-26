#pragma once

/**
 * @file run_manager_test_helper.hpp
 * @brief The load-run and live-frame helpers shared by `run_manager_load_clock_test.cpp` and
 *        `run_manager_live_frames_test.cpp`.
 */

#include "optional_assert.hpp"
#include "vayu/core/run_manager.hpp"
#include <gtest/gtest.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/platform/platform.hpp"
#include "wait_until.hpp"

namespace vayu::tests::run_manager {

/// The JSON of one SSE-framed live tick: its single `data:` line.
inline nlohmann::json live_frame_json (std::string_view frame) {
    constexpr std::string_view data_field = "data: ";
    const auto data_at                    = frame.find (data_field);
    if (data_at == std::string_view::npos) {
        ADD_FAILURE () << "not an SSE data frame: " << frame;
        return nlohmann::json::object ();
    }
    const auto json_at = data_at + data_field.size ();
    return nlohmann::json::parse (
    frame.substr (json_at, frame.find ('\n', json_at) - json_at));
}

/// A load run row for @p config, dated now: an epoch-dated run is pruned, row
/// and all, the moment it finishes.
inline void create_load_run (vayu::db::Database& db,
const std::string& run_id,
const nlohmann::json& config) {
    vayu::db::Run run;
    run.id              = run_id;
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Pending;
    run.config_snapshot = config.dump ();
    run.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                     .count ();
    db.create_run (run);
}

/// @p run_id's row once it reaches a terminal status, or its last read after
/// 20 s.
inline std::optional<vayu::db::Run>
wait_for_terminal_run (vayu::db::Database& db, const std::string& run_id) {
    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (20);
    std::optional<vayu::db::Run> stored;
    while (std::chrono::steady_clock::now () < deadline) {
        stored = db.get_run (run_id);
        if (stored && stored->status != vayu::RunStatus::Pending &&
        stored->status != vayu::RunStatus::Running) {
            break;
        }
        std::this_thread::sleep_for (std::chrono::milliseconds (20));
    }
    return stored;
}

/// @p run_id's stored 1 Hz rows, by timestamp.
inline std::map<int64_t, nlohmann::json>
stored_rows (vayu::db::Database& db, const std::string& run_id) {
    std::map<int64_t, nlohmann::json> rows;
    for (const auto& tick : db.get_metric_ticks_paginated (run_id, 1000, 0)) {
        rows.emplace (tick.timestamp, nlohmann::json::parse (tick.payload));
    }
    return rows;
}

/// Every live frame @p context still holds, parsed.
inline std::vector<nlohmann::json> live_frames (const vayu::core::RunContext& context) {
    std::vector<nlohmann::json> frames;
    for (const auto& payload : context.ticks_since (0).payloads) {
        frames.push_back (live_frame_json (payload));
    }
    return frames;
}

/// The frame stamped @p timestamp, which for a stored row is the gate frame of
/// its tick; null when no frame carries it.
inline const nlohmann::json*
frame_at (const std::vector<nlohmann::json>& frames, int64_t timestamp) {
    const auto found = std::ranges::find_if (frames, [&] (const nlohmann::json& f) {
        return f.at ("timestamp").get<int64_t> () == timestamp;
    });
    return found == frames.end () ? nullptr : &*found;
}

/// Each stored row against the gate frame of its tick: the frame exists and
/// carries the row's `elapsed_seconds`, one reading of the load clock.
inline void expect_rows_on_the_live_clock (const std::map<int64_t, nlohmann::json>& rows,
const std::vector<nlohmann::json>& frames) {
    for (const auto& [timestamp, row] : rows) {
        const auto* frame = frame_at (frames, timestamp);
        if (frame == nullptr) {
            ADD_FAILURE () << "a stored row with no live frame: " << row.dump ();
            continue;
        }
        EXPECT_DOUBLE_EQ (row.at ("elapsed_seconds").get<double> (),
        frame->at ("elapsedSeconds").get<double> ())
        << "row " << row.dump () << " against frame " << frame->dump ();
    }
}

struct SecondPercentileKey {
    const char* live;
    const char* stored;
};

inline constexpr auto SECOND_PERCENTILE_KEYS =
std::to_array<SecondPercentileKey> ({ { "secondP50Ms", "latency_p50_ms" },
{ "secondP95Ms", "latency_p95_ms" }, { "secondP99Ms", "latency_p99_ms" } });

/// What a run's gate frames said about the seconds they stored.
struct GateSeconds {
    size_t gate_frames = 0;
    /// `secondSamples` over every frame, the final partial second included.
    size_t samples = 0;
    /// Row timestamps of the stored seconds with no completion, and with one.
    std::vector<int64_t> empty;
    std::vector<int64_t> settled;
};

/// Hold each gate frame against the row it stored: the same three percentiles
/// when its second had a completion, and none of the three keys (and null on
/// the frame) when it had none (#2386).
inline GateSeconds match_gate_frames_to_rows (const std::vector<nlohmann::json>& frames,
const std::map<int64_t, nlohmann::json>& rows) {
    GateSeconds seen;
    for (size_t i = 0; i < frames.size (); ++i) {
        const auto& frame = frames[i];
        if (!frame.contains ("secondSamples")) {
            EXPECT_FALSE (frame.contains ("secondP99Ms")) << frame.dump ();
            continue;
        }
        const auto samples = frame.at ("secondSamples").get<size_t> ();
        seen.samples += samples;
        // The final frame closes the partial second and stores no row.
        if (i + 1 == frames.size ()) {
            continue;
        }
        ++seen.gate_frames;
        const auto row = rows.find (frame.at ("timestamp").get<int64_t> ());
        if (row == rows.end ()) {
            ADD_FAILURE () << "a gate frame with no stored row: " << frame.dump ();
            continue;
        }
        (samples == 0 ? seen.empty : seen.settled).push_back (row->first);
        for (const auto& key : SECOND_PERCENTILE_KEYS) {
            if (samples == 0) {
                EXPECT_TRUE (frame.at (key.live).is_null ()) << frame.dump ();
                EXPECT_FALSE (row->second.contains (key.stored))
                << "an empty second stored a latency: " << row->second.dump ();
                continue;
            }
            if (!row->second.contains (key.stored)) {
                ADD_FAILURE () << key.stored << " missing at " << row->first
                               << " for " << samples << " samples";
                continue;
            }
            EXPECT_DOUBLE_EQ (row->second.at (key.stored).get<double> (),
            frame.at (key.live).get<double> ())
            << key.stored << " at " << row->first;
        }
    }
    return seen;
}

} // namespace vayu::tests::run_manager
