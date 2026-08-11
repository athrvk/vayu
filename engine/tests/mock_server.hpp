#pragma once

/**
 * @file mock_server.hpp
 * @brief In-process HTTP mock used by tests that need a deterministic endpoint.
 *
 * Tests must not depend on external endpoints (e.g. httpbin.org): real network
 * latency is incompatible with the tight timing windows these tests assert on,
 * and a runner without outbound network access fails them spuriously.
 */

#include <httplib.h>

#include <atomic>
#include <chrono>
#include <string>
#include <thread>

namespace vayu::tests {

class SlowMockServer {
    public:
    SlowMockServer () {
        // Generous server-side thread pool: the closed-loop tests hold tens of
        // concurrent /slow requests, and the worker drains active transfers on
        // stop(). A thread-starved mock would serialize them and make teardown
        // take tens of seconds (a harness artifact, not engine behavior).
        svr.new_task_queue = [] { return new httplib::ThreadPool (128); };

        svr.Get ("/slow", [] (const httplib::Request&, httplib::Response& res) {
            std::this_thread::sleep_for (std::chrono::milliseconds (500));
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/fast", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("{}", "application/json");
        });
        // A Prometheus-style exposition endpoint, for the server-vitals
        // monitor. The counter climbs by one per scrape so a test can assert
        // the loop actually ran; `cpu` is exported as a labelled family, which
        // is what the parser's sum-per-name rule is about.
        svr.Get ("/vitals", [this] (const httplib::Request&, httplib::Response& res) {
            const int n = ++scrapes;
            res.set_content ("# HELP vayu_test_cpu Test CPU seconds\n"
                             "# TYPE vayu_test_cpu counter\n"
                             "vayu_test_cpu{cpu=\"0\"} 1.5\n"
                             "vayu_test_cpu{cpu=\"1\"} 2.5\n"
                             "vayu_test_rss_bytes " + std::to_string (n * 1000) + "\n"
                             "vayu_test_unused 7\n",
            "text/plain");
        });
        // The same numbers as a flat JSON object, for `format: "json"`.
        svr.Get ("/vitals.json", [this] (const httplib::Request&, httplib::Response& res) {
            const int n = ++scrapes;
            res.set_content ("{\"vayu_test_cpu\":4.0,\"vayu_test_rss_bytes\":" +
            std::to_string (n * 1000) + ",\"vayu_test_unused\":7}",
            "application/json");
        });

        // The same exposition, rendered slowly - the heavyweight `/metrics` a
        // loaded target serves, which is exactly when a run wants vitals. The
        // delay sits between three quarters of `VITALS_SLOW_INTERVAL_MS` and
        // the interval itself, so the derived scrape budget times it out and a
        // configured one does not.
        svr.Get ("/vitals-slow", [this] (const httplib::Request&, httplib::Response& res) {
            std::this_thread::sleep_for (std::chrono::milliseconds (VITALS_SLOW_DELAY_MS));
            const int n = ++scrapes;
            res.set_content ("vayu_test_cpu 4\n"
                             "vayu_test_rss_bytes " + std::to_string (n * 1000) + "\n",
            "text/plain");
        });

        // An upstream that never answers on its own - what a stop must not wait
        // for. The handler only returns once the fixture is torn down (or after
        // a hard cap, so a leaked handler cannot wedge the test binary).
        svr.Get ("/hang", [this] (const httplib::Request&, httplib::Response& res) {
            auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (30);
            while (!released.load (std::memory_order_relaxed) &&
            std::chrono::steady_clock::now () < deadline) {
                std::this_thread::sleep_for (std::chrono::milliseconds (10));
            }
            res.set_content ("{}", "application/json");
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });

        // Block until the listener thread has entered accept(); otherwise a
        // test that tears the fixture down before issuing any request can race
        // svr.stop() against listen_after_bind() startup. On Windows the stop
        // signal can be missed in that race, leaving thread.join() to block
        // forever. wait_until_ready() makes the start synchronous.
        svr.wait_until_ready ();
    }

    ~SlowMockServer () {
        // Release /hang first: httplib's stop() does not interrupt a handler
        // that is already running, so teardown would otherwise wait out the cap.
        released.store (true, std::memory_order_relaxed);
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }

    std::string slow_url () const {
        return "http://127.0.0.1:" + std::to_string (port) + "/slow";
    }

    std::string fast_url () const {
        return "http://127.0.0.1:" + std::to_string (port) + "/fast";
    }

    std::string hang_url () const {
        return "http://127.0.0.1:" + std::to_string (port) + "/hang";
    }

    std::string vitals_url () const {
        return "http://127.0.0.1:" + std::to_string (port) + "/vitals";
    }

    std::string vitals_json_url () const {
        return "http://127.0.0.1:" + std::to_string (port) + "/vitals.json";
    }

    std::string vitals_slow_url () const {
        return "http://127.0.0.1:" + std::to_string (port) + "/vitals-slow";
    }

    /// The cadence `/vitals-slow` is meant to be scraped at, and the delay it
    /// answers on. Three quarters of the interval is 1500ms, so the derived
    /// budget times the endpoint out with 200ms to spare, and a configured
    /// budget of anything up to the interval clears it with 300ms to spare -
    /// margins wide enough that a loaded CI host does not flip either verdict.
    static constexpr int VITALS_SLOW_INTERVAL_MS = 2000;
    static constexpr int VITALS_SLOW_DELAY_MS    = 1700;

    /// How many times either vitals endpoint has been scraped.
    int scrape_count () const {
        return scrapes.load ();
    }

    httplib::Server svr;
    std::thread thread;
    int port = 0;
    std::atomic<bool> released{ false };
    std::atomic<int> scrapes{ 0 };
};

} // namespace vayu::tests
