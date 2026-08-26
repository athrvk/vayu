/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/metrics_collector.cpp
 * @brief Implementation of high-performance in-memory metrics collector
 */

#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/reservoir.hpp"
#include "vayu/core/sample_capture.hpp"
#include "vayu/http/status.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <chrono>
#include <random>
#include <utility>

namespace vayu::core {

namespace {
inline int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/**
 * Randomness for the reservoir decisions. Thread-local so the recorder path
 * takes no lock to draw one: the sample only needs each candidate's fate to be
 * independent, not the stream of draws to be reproducible.
 */
uint64_t next_random () {
    thread_local std::mt19937_64 engine{ std::random_device{}() };
    return engine ();
}

/**
 * Apply a reservoir slot to a bounded store. Requires the store's mutex.
 *
 * The slot is claimed outside the lock (that is what keeps the copy off the
 * critical section), so by the time the insert happens another thread may have
 * appended ahead of it - hence the size checks here rather than trusting the
 * slot's own append flag. Anything that lands on an occupied index displaces
 * the incumbent, which the caller counts as a drop.
 *
 * @return true if the insert cost a record - an incumbent displaced, or this
 *         candidate dropped because the store was full with no slot to take.
 */
template <typename T>
bool insert_at_slot (std::vector<T>& store, size_t capacity, const ReservoirSlot& slot, T&& value) {
    // `std::forward`, not `std::move`: `T&&` beside a `std::vector<T>&` is a
    // forwarding reference, and spelling the transfer as an unconditional move
    // is what would silently gut an lvalue the day the parameter stops being
    // deduced from the store's element type.
    if (store.size () < capacity) {
        store.push_back (std::forward<T> (value));
        return false;
    }
    if (slot.index < store.size ()) {
        store[slot.index] = std::forward<T> (value);
        return true;
    }
    // Capacity is full and the slot points past the end: nothing to replace
    // without growing past the bound, so the candidate is dropped.
    return true;
}
} // namespace

MetricsCollector::MetricsCollector (const std::string& run_id, MetricsCollectorConfig config)
: run_id_ (run_id), config_ (config) {
    // Both sample rates are sampling *periods* - "keep 1 in N" - used as the
    // right-hand side of a `%` in the hot record path and as a divisor in the
    // reserve below. A 0 there is integer division by zero: a SIGFPE that takes
    // the whole daemon down, from a field a caller can simply set to 0.
    // POST /runs now rejects that (validate_run_config), and this clamp makes
    // the collector safe for any caller, not just that one route.
    config_.success_sample_rate = std::max (config_.success_sample_rate, size_t (1));
    config_.response_sample_rate = std::max (config_.response_sample_rate, size_t (1));

    // Initialize HdrHistogram for lock-free latency recording
    // 3 significant figures = ~0.1% precision, max 1 hour in microseconds
    int result = hdr_init (1, // Minimum value (1 microsecond)
    constants::metrics_collector::HISTOGRAM_MAX_LATENCY_US, // Maximum value (1 hour in microseconds)
    constants::metrics_collector::HISTOGRAM_SIGNIFICANT_FIGURES, // Significant figures
    &latency_histogram_);
    if (result != 0 || latency_histogram_ == nullptr) {
        throw std::runtime_error ("Failed to initialize HdrHistogram");
    }

    // Windowed (rolling) percentile source. Same value range / precision as the
    // cumulative histogram, but sampled-and-reset per tick so live percentiles
    // reflect the recent window instead of the all-time distribution.
    int interval_result = hdr_interval_recorder_init_all (&interval_recorder_,
    1, // Minimum value (1 microsecond)
    constants::metrics_collector::HISTOGRAM_MAX_LATENCY_US,
    constants::metrics_collector::HISTOGRAM_SIGNIFICANT_FIGURES);
    if (interval_result != 0) {
        hdr_close (latency_histogram_);
        latency_histogram_ = nullptr;
        throw std::runtime_error ("Failed to initialize hdr_interval_recorder");
    }
    interval_recorder_ready_ = true;

    // Per-phase bank. Allocated only when enabled, so "off" is a null pointer
    // rather than a flag consulted per completion, and phase_percentiles() has
    // nothing to report from. A partial failure closes what it built and
    // leaves the bank null: the run is still fully measurable without phase
    // percentiles, which is not true of the two histograms above.
    if (config_.phase_histograms) {
        for (auto*& histogram : phase_histograms_) {
            if (hdr_init (1, constants::metrics_collector::HISTOGRAM_MAX_LATENCY_US,
                constants::metrics_collector::HISTOGRAM_SIGNIFICANT_FIGURES, &histogram) != 0 ||
            histogram == nullptr) {
                // The bank is null-initialised and filled in order, so closing
                // every non-null slot closes exactly the ones already built.
                for (auto* built : phase_histograms_) {
                    hdr_close (built);
                }
                phase_histograms_.fill (nullptr);
                vayu::utils::log_warning ("Run " + run_id_ +
                ": failed to initialize per-phase histograms; the report will "
                "carry averages only");
                break;
            }
        }
    }

    // Event-count histogram for a streaming run. Allocated on the same
    // "off is a null pointer" rule as the bank above; a failure to allocate
    // costs the distribution and nothing else, since the totals behind
    // events/sec are plain counters.
    if (config_.stream_metrics) {
        if (hdr_init (1, constants::metrics_collector::HISTOGRAM_MAX_EVENTS,
            constants::metrics_collector::HISTOGRAM_SIGNIFICANT_FIGURES,
            &stream_events_histogram_) != 0) {
            stream_events_histogram_ = nullptr;
            vayu::utils::log_warning ("Run " + run_id_ +
            ": failed to initialize the stream event histogram; the report "
            "will "
            "carry event totals only");
        }
    }

    // Pre-allocate vectors to avoid reallocation during test
    size_t expected = config_.expected_requests;

    // Both reserves below are capped. They derive from `expected_requests`,
    // which is duration x RPS and has no ceiling of its own, so a long run at a
    // high rate asks for an allocation that simply cannot be served - and it
    // throws from here, inside RunContext's constructor, which the route calls
    // *after* it has written the run row. The caller sees an opaque 500 and the
    // row sits `pending` forever. Capping only costs a reallocation on a run
    // that big; the vectors still grow to whatever the run actually produces.
    const size_t max_reserve = constants::metrics_collector::MAX_RESERVE_RECORDS;

    // Reserve errors vector (assume ~5% error rate max)
    size_t error_reserve = config_.max_errors > 0 ?
    config_.max_errors :
    std::max (expected / 20U, size_t (10000));
    errors_.reserve (std::min (error_reserve, max_reserve));

    // Reserve success results if storing traces
    if (config_.store_success_traces) {
        size_t success_reserve = config_.max_success_results > 0 ?
        config_.max_success_results :
        expected / config_.success_sample_rate;
        success_results_.reserve (std::min (success_reserve, max_reserve));
    }

    // Slow-request records are captured whether or not timing breakdowns are
    // stored - that is the whole point of a threshold - so this reserve is not
    // conditional on store_success_traces. Unlimited (0) reserves nothing and
    // lets the vector grow, as elsewhere.
    if (config_.max_slow_results > 0) {
        slow_results_.reserve (std::min (config_.max_slow_results, max_reserve));
    }

    // Exemplars are bounded by EXEMPLARS_PER_STATUS x distinct status codes,
    // which is single digits on any real target, so the reserve is the store's
    // own ceiling rather than anything derived from the request count.
    if (config_.capture_response_bodies && config_.max_exemplar_results > 0) {
        exemplar_results_.reserve (std::min (config_.max_exemplar_results, max_reserve));
    }

    // Reserve response samples for script validation
    response_samples_.reserve (config_.max_response_samples);
}

MetricsCollector::~MetricsCollector () {
    if (latency_histogram_ != nullptr) {
        hdr_close (latency_histogram_);
        latency_histogram_ = nullptr;
    }
    if (interval_recorder_ready_) {
        hdr_interval_recorder_destroy (&interval_recorder_);
        interval_recorder_ready_ = false;
    }
    for (auto*& histogram : phase_histograms_) {
        if (histogram != nullptr) {
            hdr_close (histogram);
            histogram = nullptr;
        }
    }
    if (stream_events_histogram_ != nullptr) {
        hdr_close (stream_events_histogram_);
        stream_events_histogram_ = nullptr;
    }
}

void MetricsCollector::atomic_add_double (std::atomic<double>& target, double value) {
    double current = target.load (std::memory_order_relaxed);
    while (!target.compare_exchange_weak (current, current + value,
    std::memory_order_relaxed, std::memory_order_relaxed)) {
        // Loop until successful
    }
}

bool MetricsCollector::claim_status_exemplar (int status_code) {
    if (!config_.capture_response_bodies) {
        return false;
    }
    // Out-of-range codes share the last slot rather than taking a lock: a
    // misbehaving proxy answering 999 still gets exemplars, they are just not
    // per-code. Keeping this branch lock-free is the point - it runs on every
    // completion, retained or not.
    const int slot = (status_code >= 0 && status_code < STATUS_CODE_SLOTS - 1) ?
    status_code :
    STATUS_CODE_SLOTS - 1;
    const size_t claimed =
    exemplar_claims_.at (static_cast<size_t> (slot)).fetch_add (1, std::memory_order_relaxed);
    return claimed < constants::metrics_collector::EXEMPLARS_PER_STATUS;
}

CapturedExchange MetricsCollector::capture_exchange (const Response& response) {
    CapturedExchange captured;
    captured.headers    = response.headers;
    captured.body_bytes = static_cast<int64_t> (response.body.size ());
    if (response.stream_events) {
        captured.stream_events = static_cast<int64_t> (*response.stream_events);
    }

    // Headers compares case-insensitively, so one lookup covers every spelling
    // an origin might send.
    const auto content_type = response.headers.find ("content-type");
    if (content_type != response.headers.end ()) {
        captured.content_type = content_type->second;
    }

    if (response.body.empty ()) {
        return captured;
    }

    const size_t want = std::min (response.body.size (), config_.max_sample_body_bytes);
    if (want == 0) {
        // max_sample_body_bytes of 0 keeps headers and metadata and no body.
        captured.body_dropped = true;
        sample_bodies_dropped_.fetch_add (1, std::memory_order_relaxed);
        return captured;
    }

    // Charge the run budget before copying. fetch_add-then-refund rather than a
    // CAS loop: the overshoot is bounded by one body per concurrent writer, and
    // the budget is a memory guard, not an accounting figure.
    const size_t before = captured_bytes_.fetch_add (want, std::memory_order_relaxed);
    if (before + want > config_.max_sample_bytes) {
        captured_bytes_.fetch_sub (want, std::memory_order_relaxed);
        captured.body_dropped = true;
        sample_bodies_dropped_.fetch_add (1, std::memory_order_relaxed);
        return captured;
    }

    captured.body      = response.body.substr (0, want);
    captured.truncated = want < response.body.size ();
    return captured;
}

void MetricsCollector::record_success (int status_code,
double latency_ms,
double queue_wait_ms,
const std::string& trace_data,
SuccessTraceReason trace_reason,
const Response* capture_source,
const Timing* phases) {
    // Update atomic counters (lock-free)
    total_requests_.fetch_add (1, std::memory_order_relaxed);
    atomic_add_double (total_latency_sum_, latency_ms);
    atomic_add_double (total_queue_wait_sum_, queue_wait_ms);

    // Track the per-code count (lock-free for in-range codes).
    record_status_code (status_code);

    // Record latency in both histograms. Every event-loop worker thread calls
    // this on its own thread, so the atomic recorder API is required - the
    // plain hdr_record_value / hdr_interval_recorder_record_value pair is a
    // non-atomic `counts[i] += 1; total_count += 1`, which loses increments and
    // tears min/max under concurrent writers.
    // Convert milliseconds to microseconds for histogram precision
    int64_t latency_us = static_cast<int64_t> (latency_ms * 1000.0);
    if (latency_us < 1)
        latency_us = 1; // Minimum 1 microsecond
    hdr_record_value_atomic (latency_histogram_, latency_us);
    // Also feed the rolling-window recorder for the live per-tick percentiles.
    hdr_interval_recorder_record_value_atomic (&interval_recorder_, latency_us);

    // Per-phase bank, fed before the retention gate below and independently of
    // it: a phase distribution drawn from the completions that happened to be
    // sampled is the biased answer this bank exists to replace.
    //
    // A phase that did not happen still records its 0. That is not the same
    // claim as "TLS was free" - a run over plain HTTP records five million
    // zeroes into the TLS histogram and its p99 is 0, which is the truthful
    // reading of "this run did no handshakes". The distinction the report has
    // to keep is present-vs-absent *section*, which phase_percentiles() owns.
    if (phases != nullptr && phase_histograms_[0] != nullptr) {
        const std::array<double, TIMING_PHASE_COUNT> values = { phases->dns_ms,
            phases->connect_ms, phases->tls_ms, phases->first_byte_ms, phases->download_ms };
        for (size_t i = 0; i < TIMING_PHASE_COUNT; ++i) {
            // Clamped at 0 rather than at 1 like the latency histogram above:
            // a 0ms phase is the common case (a reused connection does no DNS
            // and no handshake), so flooring it to 1us would inflate every
            // percentile of the phases that legitimately did not run.
            hdr_record_value_atomic (phase_histograms_.at (i),
            static_cast<int64_t> (std::max (0.0, values.at (i)) * 1000.0));
        }
    }

    // Store the trace the caller built, in whichever budget asked for it. The
    // sampling decision happened before the trace was serialised (see
    // should_sample_success), so nothing is built here to be discarded.
    if (trace_data.empty () || trace_reason == SuccessTraceReason::None) {
        return;
    }

    ResultRecord record (now_ms (), status_code, latency_ms);
    record.trace_data = trace_data;

    // Exemplars take the straight path: a fixed number per status code, kept
    // until the store is full and then refused. No reservoir, because being
    // retained is the only thing an exemplar is for.
    //
    // A refusal here leaves its captured bytes charged to the run budget with
    // no record to show for them. Left unrefunded deliberately: the budget is a
    // memory ceiling rather than an accounting figure, over-counting it only
    // makes capture stop sooner, and the alternative is holding the store's
    // mutex across a body-sized copy. The gate above already bounds this to
    // EXEMPLARS_PER_STATUS per status code, so it needs a target answering with
    // more distinct codes than `max_exemplar_results` to happen at all.
    if (trace_reason == SuccessTraceReason::Exemplar) {
        if (capture_source != nullptr) {
            record.capture = capture_exchange (*capture_source);
        }
        std::lock_guard<std::mutex> lock (success_mutex_);
        if (config_.max_exemplar_results > 0 &&
        exemplar_results_.size () >= config_.max_exemplar_results) {
            exemplar_dropped_.fetch_add (1, std::memory_order_relaxed);
            return;
        }
        exemplar_results_.push_back (std::move (record));
        return;
    }

    const bool slow = trace_reason == SuccessTraceReason::Slow;
    const size_t capacity = slow ? config_.max_slow_results : config_.max_success_results;
    auto& store        = slow ? slow_results_ : success_results_;
    auto& seen_counter = slow ? slow_seen_ : success_seen_;
    auto& dropped      = slow ? slow_dropped_ : success_dropped_;

    // Whether to capture is the caller's call, not this store's: handle_result
    // knows whether the completion was an outlier or a claimed exemplar, and a
    // record can land in the sampled budget while still deserving a body.
    // Deciding it from `trace_reason` here would make the two inseparable, and
    // the store a record lands in is not what makes its body worth keeping.
    const Response* capture = capture_source;

    if (capacity == 0) { // unlimited
        if (capture != nullptr) {
            record.capture = capture_exchange (*capture);
        }
        std::lock_guard<std::mutex> lock (success_mutex_);
        store.push_back (std::move (record));
        return;
    }

    const size_t seen = seen_counter.fetch_add (1, std::memory_order_relaxed);
    const ReservoirSlot slot = reservoir_slot (seen, capacity, next_random ());
    if (!slot.accepted) {
        dropped.fetch_add (1, std::memory_order_relaxed);
        return;
    }

    // The slot is claimed, so this record is being kept: copying the body now
    // is the point of deferring it past the reservoir refusal above.
    if (capture != nullptr) {
        record.capture = capture_exchange (*capture);
    }

    bool displaced = false;
    {
        std::lock_guard<std::mutex> lock (success_mutex_);
        displaced = insert_at_slot (store, capacity, slot, std::move (record));
    }
    if (displaced) {
        dropped.fetch_add (1, std::memory_order_relaxed);
    }
}

bool MetricsCollector::should_sample_success () {
    // The counter advances for every completion, sampled or not - it is what
    // gives the period its meaning. Only the answer depends on the toggle.
    const size_t counter = success_sample_counter_.fetch_add (1, std::memory_order_relaxed);
    return config_.store_success_traces && counter % config_.success_sample_rate == 0;
}

void MetricsCollector::record_response_sample (const Response& response) {
    // Only sample based on configured rate
    size_t counter = response_sample_counter_.fetch_add (1, std::memory_order_relaxed);
    if (counter % config_.response_sample_rate != 0) {
        return;
    }

    const size_t capacity = config_.max_response_samples;
    if (capacity == 0) { // configured to retain nothing
        response_dropped_.fetch_add (1, std::memory_order_relaxed);
        return;
    }

    // Claim a slot before copying anything. Past capacity most candidates are
    // refused, and a refusal costs neither the body-sized copy below nor the
    // mutex - which the old hard stop took on every sampled completion for the
    // rest of the run, purely to find the buffer full.
    const size_t seen = response_seen_.fetch_add (1, std::memory_order_relaxed);
    const ReservoirSlot slot = reservoir_slot (seen, capacity, next_random ());
    if (!slot.accepted) {
        response_dropped_.fetch_add (1, std::memory_order_relaxed);
        return;
    }

    ResponseSample sample (response, now_ms ());

    bool displaced = false;
    {
        std::lock_guard<std::mutex> lock (response_samples_mutex_);
        displaced =
        insert_at_slot (response_samples_, capacity, slot, std::move (sample));
    }
    if (displaced) {
        response_dropped_.fetch_add (1, std::memory_order_relaxed);
    }
}

const std::vector<ResponseSample> MetricsCollector::NO_SAMPLES;

void MetricsCollector::configure_step_samples (const std::vector<bool>& sampled) {
    step_samples_.clear ();
    if (sampled.empty ()) {
        return;
    }

    const size_t read_steps =
    static_cast<size_t> (std::count (sampled.begin (), sampled.end (), true));

    // The whole run budget across the steps a deferred pass will actually read,
    // floored at one so a plan with more of them than slots still samples every
    // one. See the header for why the floor is the deliberate over-run and not
    // an oversight.
    const size_t per_step = read_steps == 0 ?
    0 :
    std::max<size_t> (1, config_.max_response_samples / read_steps);

    step_samples_.reserve (sampled.size ());
    for (bool is_read : sampled) {
        auto store      = std::make_unique<StepSampleStore> ();
        store->capacity = is_read ? per_step : 0;
        store->samples.reserve (store->capacity);
        step_samples_.push_back (std::move (store));
    }
}

void MetricsCollector::record_step_response_sample (const Response& response,
size_t step_index,
size_t iteration,
std::optional<size_t> data_row_index) {
    if (step_index >= step_samples_.size ()) {
        return;
    }
    StepSampleStore& store = *step_samples_[step_index];
    // A step no deferred pass will read. Refused before the rate counter, so an
    // unsampled step costs one load and one compare per completion.
    if (store.capacity == 0) {
        return;
    }

    // Per step rather than per run: the run-wide counter would hand a plan's
    // steps a rotating share of the 1-in-N period instead of each step keeping
    // its own.
    const size_t counter = store.rate_counter.fetch_add (1, std::memory_order_relaxed);
    if (counter % config_.response_sample_rate != 0) {
        return;
    }

    // Claim before copying, exactly as the run-level store does - a refusal
    // must not cost a body-sized copy.
    const size_t seen = store.seen.fetch_add (1, std::memory_order_relaxed);
    const ReservoirSlot slot = reservoir_slot (seen, store.capacity, next_random ());
    if (!slot.accepted) {
        response_dropped_.fetch_add (1, std::memory_order_relaxed);
        return;
    }

    ResponseSample sample (response, now_ms ());
    sample.iteration      = iteration;
    sample.data_row_index = data_row_index;

    bool displaced = false;
    {
        std::lock_guard<std::mutex> lock (store.mutex);
        displaced =
        insert_at_slot (store.samples, store.capacity, slot, std::move (sample));
    }
    if (displaced) {
        response_dropped_.fetch_add (1, std::memory_order_relaxed);
    }
}

const std::vector<ResponseSample>& MetricsCollector::step_response_samples (
size_t step_index) const {
    if (step_index >= step_samples_.size ()) {
        return NO_SAMPLES;
    }
    return step_samples_[step_index]->samples;
}

void MetricsCollector::record_error (ErrorCode code,
const std::string& message,
const std::string& trace_data,
const Response* capture_source) {
    // Update atomic counters (lock-free)
    total_requests_.fetch_add (1, std::memory_order_relaxed);
    const size_t error_index = total_errors_.fetch_add (1, std::memory_order_relaxed);

    // Transport errors (timeout, connection, DNS, …) carry no HTTP status, so
    // bucket them under code 0. This keeps the status-code distribution summing
    // to total_requests - the dashboard breakdown reconciles with the headline
    // count, and the report's failed/errorRate tallies (recomputed from the
    // distribution) account for them instead of silently dropping to zero.
    record_status_code (0);

    // Store the error record while the store has room. Past the cap the record
    // is dropped but counted - total_errors_ and the status-code distribution
    // above stay exact, so only the per-error detail is lost. Without the cap a
    // fully-failing target grows this vector for the life of the run and then
    // flushes it as one enormous transaction.
    // Copy the exchange before taking the store's mutex, so a body-sized copy
    // never lengthens a critical section every failing completion queues on.
    // `error_index` is this call's position in the error sequence, and the
    // store admits the first `max_errors` of exactly that sequence, so this
    // predicate and the one under the lock agree without a second counter.
    std::optional<CapturedExchange> captured;
    if (capture_source != nullptr &&
    (config_.max_errors == 0 || error_index < config_.max_errors)) {
        captured = capture_exchange (*capture_source);
    }

    bool first_drop = false;
    {
        std::lock_guard<std::mutex> lock (errors_mutex_);
        if (config_.max_errors == 0 || errors_.size () < config_.max_errors) {
            ResultRecord record (now_ms (), code, message);
            record.trace_data = trace_data;
            record.capture    = std::move (captured);
            errors_.push_back (std::move (record));
        } else {
            first_drop = errors_dropped_.fetch_add (1, std::memory_order_relaxed) == 0;
        }
    }

    // Log once, outside the lock, so a capped run leaves a trace instead of
    // silently truncating its error list.
    if (first_drop) {
        vayu::utils::log_warning ("Run " + run_id_ + ": error store full at " +
        std::to_string (config_.max_errors) +
        " records; further errors are counted but not stored");
    }
}

void MetricsCollector::record_drop_batch (size_t count) {
    dropped_requests_.fetch_add (count, std::memory_order_relaxed);
}

MetricsCollector::Percentiles MetricsCollector::calculate_percentiles () {
    Percentiles result;

    if (latency_histogram_ == nullptr || latency_histogram_->total_count == 0) {
        return result;
    }

    // Convert from microseconds back to milliseconds
    auto us_to_ms = [] (int64_t us) -> double {
        return static_cast<double> (us) / 1000.0;
    };

    result.count = static_cast<size_t> (latency_histogram_->total_count);
    result.min   = us_to_ms (hdr_min (latency_histogram_));
    result.max   = us_to_ms (hdr_max (latency_histogram_));
    result.p50  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 50.0));
    result.p75  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 75.0));
    result.p90  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 90.0));
    result.p95  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 95.0));
    result.p99  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 99.0));
    result.p999 = us_to_ms (hdr_value_at_percentile (latency_histogram_, 99.9));

    return result;
}

std::optional<std::array<MetricsCollector::Percentiles, TIMING_PHASE_COUNT>>
MetricsCollector::phase_percentiles () const {
    // The five are allocated and fed together, so the first answers for all of
    // them: a null bank is the toggle off, an empty one is a run where nothing
    // successful completed. Both are "no distribution to report", which is
    // what the absent section says.
    if (phase_histograms_[0] == nullptr || phase_histograms_[0]->total_count == 0) {
        return std::nullopt;
    }

    auto us_to_ms = [] (int64_t us) -> double {
        return static_cast<double> (us) / 1000.0;
    };

    std::array<Percentiles, TIMING_PHASE_COUNT> result;
    for (size_t i = 0; i < TIMING_PHASE_COUNT; ++i) {
        auto* histogram    = phase_histograms_.at (i);
        Percentiles& phase = result.at (i);
        phase.count        = static_cast<size_t> (histogram->total_count);
        phase.min          = us_to_ms (hdr_min (histogram));
        phase.max          = us_to_ms (hdr_max (histogram));
        phase.p50  = us_to_ms (hdr_value_at_percentile (histogram, 50.0));
        phase.p75  = us_to_ms (hdr_value_at_percentile (histogram, 75.0));
        phase.p90  = us_to_ms (hdr_value_at_percentile (histogram, 90.0));
        phase.p95  = us_to_ms (hdr_value_at_percentile (histogram, 95.0));
        phase.p99  = us_to_ms (hdr_value_at_percentile (histogram, 99.0));
        phase.p999 = us_to_ms (hdr_value_at_percentile (histogram, 99.9));
    }
    return result;
}

void MetricsCollector::record_stream_completion (size_t events, bool capped) {
    if (!config_.stream_metrics) {
        // Off means the report has no `stream` section at all, not a section of
        // zeros - so the counters behind it must not tick either. Checked here
        // rather than at the call site because this is the one place that knows
        // what the toggle governs.
        return;
    }
    stream_completions_.fetch_add (1, std::memory_order_relaxed);
    stream_events_total_.fetch_add (events, std::memory_order_relaxed);
    if (capped) {
        stream_capped_.fetch_add (1, std::memory_order_relaxed);
    }
    if (stream_events_histogram_ != nullptr) {
        // A stream that delivered nothing records its 0 - `hdr` cannot hold one
        // below its floor of 1, so it is clamped, and the completion is still
        // counted above. That is why `completions` is a counter rather than
        // read off the histogram: the two would disagree by exactly the number
        // of empty streams, which is the population a report most needs to
        // show.
        hdr_record_value_atomic (stream_events_histogram_,
        static_cast<int64_t> (std::max<size_t> (1, events)));
    }
}

std::optional<MetricsCollector::StreamTotals> MetricsCollector::stream_totals () const {
    const size_t completions = stream_completions_.load (std::memory_order_relaxed);
    if (completions == 0) {
        // Either `stream_metrics` was off, or no stream completed. Both are
        // "nothing to report", which is what the absent section says.
        return std::nullopt;
    }

    StreamTotals totals;
    totals.completions  = completions;
    totals.total_events = stream_events_total_.load (std::memory_order_relaxed);
    totals.capped       = stream_capped_.load (std::memory_order_relaxed);

    if (stream_events_histogram_ != nullptr && stream_events_histogram_->total_count > 0) {
        auto* h             = stream_events_histogram_;
        totals.events.count = static_cast<size_t> (h->total_count);
        totals.events.min   = static_cast<double> (hdr_min (h));
        totals.events.max   = static_cast<double> (hdr_max (h));
        totals.events.p50 = static_cast<double> (hdr_value_at_percentile (h, 50.0));
        totals.events.p75 = static_cast<double> (hdr_value_at_percentile (h, 75.0));
        totals.events.p90 = static_cast<double> (hdr_value_at_percentile (h, 90.0));
        totals.events.p95 = static_cast<double> (hdr_value_at_percentile (h, 95.0));
        totals.events.p99 = static_cast<double> (hdr_value_at_percentile (h, 99.0));
        totals.events.p999 = static_cast<double> (hdr_value_at_percentile (h, 99.9));
    }
    return totals;
}

MetricsCollector::Percentiles MetricsCollector::sample_window_percentiles () {
    Percentiles result;

    if (!interval_recorder_ready_) {
        return result;
    }

    // Sample-and-recycle: hand back the histogram that has been accumulating since
    // the previous call and swap in a fresh (reset) one for the next window. Safe
    // to call concurrently with the recording writers via the phaser; must be
    // driven by a single reader thread only (the metrics producer). The returned
    // pointer is owned by the recorder and valid until the next sample.
    struct hdr_histogram* interval = hdr_interval_recorder_sample (&interval_recorder_);
    if (interval == nullptr || interval->total_count == 0) {
        return result; // empty window → zeros
    }

    auto us_to_ms = [] (int64_t us) -> double {
        return static_cast<double> (us) / 1000.0;
    };

    result.count = static_cast<size_t> (interval->total_count);
    result.min   = us_to_ms (hdr_min (interval));
    result.max   = us_to_ms (hdr_max (interval));
    result.p50   = us_to_ms (hdr_value_at_percentile (interval, 50.0));
    result.p75   = us_to_ms (hdr_value_at_percentile (interval, 75.0));
    result.p90   = us_to_ms (hdr_value_at_percentile (interval, 90.0));
    result.p95   = us_to_ms (hdr_value_at_percentile (interval, 95.0));
    result.p99   = us_to_ms (hdr_value_at_percentile (interval, 99.0));
    result.p999  = us_to_ms (hdr_value_at_percentile (interval, 99.9));

    return result;
}

void MetricsCollector::record_status_code (int status_code) {
    if (status_code >= 0 && status_code < STATUS_CODE_SLOTS) {
        // Hot path: single relaxed atomic increment, no lock.
        status_code_counts_.at (static_cast<size_t> (status_code)).fetch_add (1, std::memory_order_relaxed);
        return;
    }
    // Out-of-range (non-standard) code: dead path for real HTTP traffic.
    std::lock_guard<std::mutex> lock (status_overflow_mutex_);
    status_overflow_[status_code]++;
}

std::map<int, size_t> MetricsCollector::status_code_distribution () const {
    std::map<int, size_t> result;
    for (int code = 0; code < STATUS_CODE_SLOTS; ++code) {
        size_t count =
        status_code_counts_.at (static_cast<size_t> (code)).load (std::memory_order_relaxed);
        if (count > 0) {
            result[code] = count;
        }
    }
    {
        std::lock_guard<std::mutex> lock (status_overflow_mutex_);
        for (const auto& [code, count] : status_overflow_) {
            result[code] += count;
        }
    }
    return result;
}

size_t MetricsCollector::flush_to_database (db::Database& db) {
    std::vector<db::Result> batch;
    std::vector<db::PendingResultBody> bodies;

    // Turn a record's captured exchange into a row for `result_bodies`. This is
    // where the expensive half of capture lives - JSON, binary detection and
    // hashing - deliberately after load generation has stopped rather than
    // inline in the completion drain (see CapturedExchange).
    auto collect_capture = [&] (const ResultRecord& record) {
        if (!record.capture.has_value ()) {
            return;
        }
        const CapturedExchange& exchange = *record.capture;

        db::PendingResultBody pending;
        pending.result_index = batch.size () - 1;
        pending.headers =
        nlohmann::json (exchange.headers).dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
        pending.body_bytes    = exchange.body_bytes;
        pending.truncated     = exchange.truncated;
        pending.content_type  = exchange.content_type;
        pending.stream_events = exchange.stream_events;

        if (!exchange.body_dropped && !exchange.body.empty ()) {
            // A binary body is stored as its size and content type, never as
            // text: `error_handler_t::replace` would keep dump() from throwing
            // and hand the reader a mojibake that looks like a real response.
            pending.binary = looks_binary (exchange.body, exchange.content_type);
            if (!pending.binary) {
                pending.body      = exchange.body;
                pending.body_hash = body_digest (pending.body);
            }
        }
        bodies.push_back (std::move (pending));
    };

    // Collect all error records
    {
        std::lock_guard<std::mutex> lock (errors_mutex_);
        batch.reserve (errors_.size () + success_results_.size ());

        for (const auto& error : errors_) {
            db::Result db_result;
            db_result.run_id      = run_id_;
            db_result.timestamp   = error.timestamp;
            db_result.status_code = 0;
            db_result.status_text = vayu::http::status_text (0);
            db_result.latency_ms  = 0.0;
            db_result.error       = error.error_message;
            db_result.trace_data  = error.trace_data;
            batch.push_back (std::move (db_result));
            collect_capture (error);
        }
    }

    // Collect sampled success records, the slow-request outliers and the
    // per-status exemplars. Three budgets in memory, one table on disk: a
    // stored row is a stored row, and the report tells them apart by the
    // trace's `isSlow` marker.
    {
        std::lock_guard<std::mutex> lock (success_mutex_);
        for (const auto* store : { &success_results_, &slow_results_, &exemplar_results_ }) {
            for (const auto& success : *store) {
                db::Result db_result;
                db_result.run_id      = run_id_;
                db_result.timestamp   = success.timestamp;
                db_result.status_code = success.status_code;
                // ResultRecord doesn't carry the wire reason phrase; derive
                // from code via the shared helper. The single-request design
                // path (execution.cpp) preserves the wire phrase directly.
                db_result.status_text = vayu::http::status_text (success.status_code);
                db_result.latency_ms = success.latency_ms;
                db_result.trace_data = success.trace_data;
                batch.push_back (std::move (db_result));
                collect_capture (success);
            }
        }
    }

    // Batch insert with transaction (prevents WAL growth and OOM). Results and
    // their captured bodies land together, so a failure leaves neither.
    if (!batch.empty ()) {
        db.add_results_batch (batch, bodies);
    }
    response_bodies_captured_.store (bodies.size (), std::memory_order_relaxed);

    return batch.size ();
}

int64_t MetricsCollector::latency_count () const {
    if (latency_histogram_ == nullptr) {
        return 0;
    }
    return latency_histogram_->total_count;
}

size_t MetricsCollector::memory_usage_bytes () const {
    size_t bytes = sizeof (MetricsCollector);

    // HdrHistogram memory (fixed size ~20-40KB)
    if (latency_histogram_ != nullptr) {
        bytes += hdr_get_memory_size (latency_histogram_);
    }

    // A record's captured exchange, when it has one. Counted here rather than
    // assumed small: bodies are what make a retained record expensive, and the
    // whole-run budget is only a ceiling, not a measurement.
    auto capture_bytes = [] (const ResultRecord& record) -> size_t {
        if (!record.capture.has_value ()) {
            return 0;
        }
        size_t record_bytes =
        record.capture->body.capacity () + record.capture->content_type.capacity ();
        for (const auto& [name, value] : record.capture->headers) {
            record_bytes += name.capacity () + value.capacity ();
        }
        return record_bytes;
    };

    // Errors vector
    {
        std::lock_guard<std::mutex> lock (errors_mutex_);
        bytes += errors_.capacity () * sizeof (ResultRecord);
        for (const auto& e : errors_) {
            bytes += e.error_message.capacity () + e.trace_data.capacity () +
            capture_bytes (e);
        }
    }

    // Success, slow-request and exemplar result vectors
    {
        std::lock_guard<std::mutex> lock (success_mutex_);
        for (const auto* store : { &success_results_, &slow_results_, &exemplar_results_ }) {
            bytes += store->capacity () * sizeof (ResultRecord);
            for (const auto& s : *store) {
                bytes += s.trace_data.capacity () + capture_bytes (s);
            }
        }
    }

    return bytes;
}

nlohmann::json MetricsCollector::get_current_stats (size_t current_active,
double elapsed_seconds,
size_t requests_sent,
size_t requests_expected,
const std::map<int, size_t>* status_snapshot,
const Percentiles* window_percentiles) const {
    // Lock-free reads from atomic counters
    size_t total    = total_requests ();
    size_t errors   = total_errors ();
    size_t success  = total > errors ? total - errors : 0;
    double avg_lat  = average_latency ();
    double err_rate = error_rate ();

    // Calculate rate metrics (Open Model)
    // Send Rate: How fast Vayu is dispatching requests to the server
    double send_rate =
    elapsed_seconds > 0 ? static_cast<double> (requests_sent) / elapsed_seconds : 0.0;

    // Throughput: How fast the server is responding (completed requests)
    double throughput =
    elapsed_seconds > 0 ? static_cast<double> (total) / elapsed_seconds : 0.0;

    nlohmann::json stats;
    stats["totalRequests"]     = total;
    stats["totalErrors"]       = errors;
    stats["totalSuccess"]      = success;
    stats["errorRate"]         = err_rate;
    stats["avgLatencyMs"]      = avg_lat;
    stats["sendRate"]          = send_rate;
    stats["throughput"]        = throughput;
    stats["activeConnections"] = current_active;
    stats["elapsedSeconds"]    = elapsed_seconds;

    // Run progress - feeds the dashboard ETA stat for closed-ended modes
    // (iterations). requests_expected is 0 for open-ended modes (constant_rps).
    stats["requestsSent"]     = requests_sent;
    stats["requestsExpected"] = requests_expected;

    // Snapshot the status-code distribution once: reuse the caller's snapshot
    // when provided (the metrics tick takes one snapshot and feeds it to both
    // the SSE builder and the persisted-rows builder), otherwise compute it.
    // Both the class breakdown and the full map below derive from this single
    // copy - no second scan.
    std::map<int, size_t> local_dist;
    const std::map<int, size_t>& dist = status_snapshot != nullptr ?
    *status_snapshot :
    (local_dist = status_code_distribution ());

    // Status code class breakdown. The dedicated class atomics were removed to
    // keep the hot path a single increment; classes are derived here. Code 0
    // (transport errors) and out-of-range codes belong to no class bucket.
    size_t s2xx = 0, s3xx = 0, s4xx = 0, s5xx = 0;
    for (const auto& [code, count] : dist) {
        if (code >= 200 && code < 300)
            s2xx += count;
        else if (code >= 300 && code < 400)
            s3xx += count;
        else if (code >= 400 && code < 500)
            s4xx += count;
        else if (code >= 500 && code < 600)
            s5xx += count;
    }
    stats["status2xx"] = s2xx;
    stats["status3xx"] = s3xx;
    stats["status4xx"] = s4xx;
    stats["status5xx"] = s5xx;
    stats["droppedRequests"] = dropped_requests_.load (std::memory_order_relaxed);
    stats["avgQueueWaitMs"] = average_queue_wait ();

    // Per-tick latency percentiles. When the caller supplies windowed (rolling)
    // percentiles - the live producer samples the interval recorder each tick -
    // emit those so the "percentiles over time" chart tracks the recent window
    // instead of flattening. When absent (callers/tests that don't drive the
    // interval recorder), fall back to the cumulative-from-start histogram.
    if (window_percentiles != nullptr) {
        stats["latencyP50Ms"] = window_percentiles->p50;
        stats["latencyP95Ms"] = window_percentiles->p95;
        stats["latencyP99Ms"] = window_percentiles->p99;
    } else if (latency_histogram_ != nullptr && latency_histogram_->total_count > 0) {
        stats["latencyP50Ms"] =
        static_cast<double> (hdr_value_at_percentile (latency_histogram_, 50.0)) / 1000.0;
        stats["latencyP95Ms"] =
        static_cast<double> (hdr_value_at_percentile (latency_histogram_, 95.0)) / 1000.0;
        stats["latencyP99Ms"] =
        static_cast<double> (hdr_value_at_percentile (latency_histogram_, 99.0)) / 1000.0;
    } else {
        stats["latencyP50Ms"] = 0.0;
        stats["latencyP95Ms"] = 0.0;
        stats["latencyP99Ms"] = 0.0;
    }

    // Wire byte counts (cumulative) - client diffs consecutive ticks for MB/s.
    stats["bytesSent"]     = total_bytes_sent ();
    stats["bytesReceived"] = total_bytes_received ();

    // Full status-code map (same shape the stored time-series carries), so the
    // app maps one shape for both live and history. Derived from the same
    // single snapshot as the class breakdown above.
    nlohmann::json codes = nlohmann::json::object ();
    for (const auto& [code, count] : dist) {
        codes[std::to_string (code)] = count;
    }
    stats["statusCodes"] = codes;

    return stats;
}

} // namespace vayu::core
