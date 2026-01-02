#include "vayu/core/run_manager.hpp"
#include "vayu/utils/json.hpp"
#include <iostream>
#include <chrono>
#include <algorithm>

namespace vayu::core
{

    namespace
    {
        inline int64_t now_ms()
        {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                .count();
        }
    }

    RunContext::RunContext(const std::string &id, nlohmann::json cfg)
        : run_id(id), config(std::move(cfg)), start_time_ms(0) {}

    RunContext::~RunContext()
    {
        should_stop = true;
        if (worker_thread.joinable())
        {
            worker_thread.join();
        }
        if (metrics_thread.joinable())
        {
            metrics_thread.join();
        }
    }

    void RunManager::register_run(const std::string &run_id, std::shared_ptr<RunContext> context)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        active_runs_[run_id] = context;
    }

    std::shared_ptr<RunContext> RunManager::get_run(const std::string &run_id)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = active_runs_.find(run_id);
        if (it != active_runs_.end())
        {
            return it->second;
        }
        return nullptr;
    }

    void RunManager::unregister_run(const std::string &run_id)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        active_runs_.erase(run_id);
    }

    size_t RunManager::active_count() const
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return active_runs_.size();
    }

    std::vector<std::shared_ptr<RunContext>> RunManager::get_all_active_runs() const
    {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<std::shared_ptr<RunContext>> runs;
        for (const auto &[id, context] : active_runs_)
        {
            runs.push_back(context);
        }
        return runs;
    }

    void RunManager::start_run(const std::string &run_id, const nlohmann::json &config, vayu::db::Database &db, bool verbose)
    {
        auto context = std::make_shared<RunContext>(run_id, config);
        register_run(run_id, context);

        // Spawn background thread for execution
        context->worker_thread = std::thread([context, &db, verbose, this]()
                                             { execute_load_test(context, &db, verbose, *this); });
        context->worker_thread.detach();

        // Spawn metrics collection thread
        context->metrics_thread = std::thread([context, &db]()
                                              { collect_metrics(context, &db); });
        context->metrics_thread.detach();
    }

    void execute_load_test(std::shared_ptr<RunContext> context, vayu::db::Database *db_ptr, bool verbose, RunManager &manager)
    {
        context->is_running = true;
        context->start_time_ms = now_ms();

        auto &db = *db_ptr;
        const auto &config = context->config;

        try
        {
            // Update status to running
            db.update_run_status(context->run_id, "running");

            // Parse load test configuration
            std::string mode = config.value("mode", "duration"); // "duration" or "iterations"
            int64_t duration_ms = 0;
            size_t iterations = 0;

            if (mode == "duration")
            {
                std::string duration_str = config.value("duration", "60s");
                // Parse duration (simple: just handle "Ns" format)
                duration_ms = std::stoll(duration_str.substr(0, duration_str.length() - 1)) * 1000;
            }
            else
            {
                iterations = static_cast<size_t>(config.value("iterations", 1000));
            }

            size_t concurrency = static_cast<size_t>(config.value("concurrency", 100));
            double target_rps = config.value("rps", 0.0); // 0 = unlimited
            int timeout_ms = config.value("timeout", 30000);

            // Configure EventLoop
            vayu::http::EventLoopConfig loop_config;
            loop_config.num_workers = 0; // Auto-detect
            loop_config.max_concurrent = std::max(concurrency, size_t(100));
            loop_config.target_rps = target_rps;
            loop_config.burst_size = target_rps > 0 ? target_rps * 2.0 : 0.0;
            loop_config.verbose = verbose;

            // Create EventLoop
            context->event_loop = std::make_unique<vayu::http::EventLoop>(loop_config);
            context->event_loop->start();

            // Parse request
            auto request_json = config["request"];
            auto request_result = vayu::json::deserialize_request(request_json);
            if (request_result.is_error())
            {
                db.update_run_status(context->run_id, "failed");
                context->is_running = false;
                return;
            }

            auto request = request_result.value();
            request.timeout_ms = timeout_ms;

            if (verbose)
            {
                std::cout << "Starting load test: " << context->run_id << "\n";
                std::cout << "  Mode: " << mode << "\n";
                if (mode == "duration")
                {
                    std::cout << "  Duration: " << duration_ms << " ms\n";
                }
                else
                {
                    std::cout << "  Iterations: " << iterations << "\n";
                }
                std::cout << "  Concurrency: " << concurrency << "\n";
                std::cout << "  Target RPS: " << (target_rps > 0 ? std::to_string(target_rps) : "unlimited") << "\n";
            }

            // Submit requests
            auto test_start = std::chrono::steady_clock::now();
            size_t submitted = 0;

            if (mode == "duration")
            {
                // Duration-based: submit continuously until duration expires
                while (!context->should_stop)
                {
                    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                                       std::chrono::steady_clock::now() - test_start)
                                       .count();

                    if (elapsed >= duration_ms)
                    {
                        break;
                    }

                    // Submit batch of requests
                    for (size_t i = 0; i < concurrency && !context->should_stop; ++i)
                    {
                        context->event_loop->submit(request, [context, &db](size_t req_id, vayu::Result<vayu::Response> result)
                                                    {
                        context->total_requests++;
                        
                        if (result.is_ok())
                        {
                            double latency = result.value().timing.total_ms;
                            context->total_latency_ms += latency;
                            
                            // Store latency for percentiles
                            {
                                std::lock_guard<std::mutex> lock(context->latencies_mutex);
                                context->latencies.push_back(latency);
                            }
                            
                            // Store result in DB (sampled - every 100th request to avoid DB overload)
                            if (context->total_requests % 100 == 0)
                            {
                                try
                                {
                                    vayu::db::Result db_result;
                                    db_result.run_id = context->run_id;
                                    db_result.timestamp = now_ms();
                                    db_result.status_code = result.value().status_code;
                                    db_result.latency_ms = latency;
                                    db.add_result(db_result);
                                }
                                catch (const std::exception &e)
                                {
                                    // Continue on DB error
                                }
                            }
                        }
                        else
                        {
                            context->total_errors++;
                        } });
                        submitted++;
                    }

                    // Small delay to allow processing
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                }
            }
            else
            {
                // Iteration-based: submit exact number of requests
                for (size_t i = 0; i < iterations && !context->should_stop; ++i)
                {
                    context->event_loop->submit(request, [context, &db](size_t req_id, vayu::Result<vayu::Response> result)
                                                {
                    context->total_requests++;
                    
                    if (result.is_ok())
                    {
                        double latency = result.value().timing.total_ms;
                        context->total_latency_ms += latency;
                        
                        {
                            std::lock_guard<std::mutex> lock(context->latencies_mutex);
                            context->latencies.push_back(latency);
                        }
                        
                        if (context->total_requests % 100 == 0)
                        {
                            try
                            {
                                vayu::db::Result db_result;
                                db_result.run_id = context->run_id;
                                db_result.timestamp = now_ms();
                                db_result.status_code = result.value().status_code;
                                db_result.latency_ms = latency;
                                db.add_result(db_result);
                            }
                            catch (const std::exception &e)
                            {
                            }
                        }
                    }
                    else
                    {
                        context->total_errors++;
                    } });
                    submitted++;

                    // Rate limiting check
                    if (target_rps > 0 && submitted % 100 == 0)
                    {
                        std::this_thread::sleep_for(std::chrono::milliseconds(1));
                    }
                }
            }

            if (verbose)
            {
                std::cout << "Submitted " << submitted << " requests, waiting for completion...\n";
            }

            // Wait for all requests to complete
            context->event_loop->stop(true); // Wait for pending

            // Calculate final metrics
            auto test_end = std::chrono::steady_clock::now();
            double total_duration_s = std::chrono::duration<double>(test_end - test_start).count();

            size_t completed = context->total_requests.load();
            size_t errors = context->total_errors.load();
            double avg_latency = completed > 0 ? context->total_latency_ms.load() / completed : 0.0;
            double actual_rps = total_duration_s > 0 ? completed / total_duration_s : 0.0;
            double error_rate = completed > 0 ? (errors * 100.0 / completed) : 0.0;

            // Calculate percentiles
            std::vector<double> sorted_latencies;
            {
                std::lock_guard<std::mutex> lock(context->latencies_mutex);
                sorted_latencies = context->latencies;
            }
            std::sort(sorted_latencies.begin(), sorted_latencies.end());

            double p50 = 0, p95 = 0, p99 = 0;
            if (!sorted_latencies.empty())
            {
                p50 = sorted_latencies[sorted_latencies.size() * 50 / 100];
                p95 = sorted_latencies[sorted_latencies.size() * 95 / 100];
                p99 = sorted_latencies[sorted_latencies.size() * 99 / 100];
            }

            // Store final summary metrics
            try
            {
                auto timestamp = now_ms();
                db.add_metric({0, context->run_id, timestamp, "rps", actual_rps, ""});
                db.add_metric({0, context->run_id, timestamp, "latency_avg", avg_latency, ""});
                db.add_metric({0, context->run_id, timestamp, "latency_p50", p50, R"({"percentile":"p50"})"});
                db.add_metric({0, context->run_id, timestamp, "latency_p95", p95, R"({"percentile":"p95"})"});
                db.add_metric({0, context->run_id, timestamp, "latency_p99", p99, R"({"percentile":"p99"})"});
                db.add_metric({0, context->run_id, timestamp, "error_rate", error_rate, ""});
                db.add_metric({0, context->run_id, timestamp, "total_requests", static_cast<double>(completed), ""});
                db.add_metric({0, context->run_id, timestamp, "test_complete", 1.0, ""});
            }
            catch (const std::exception &e)
            {
                std::cerr << "Failed to store final metrics: " << e.what() << "\n";
            }

            // Update run status
            std::string final_status = context->should_stop ? "stopped" : "completed";
            db.update_run_status(context->run_id, final_status);

            if (verbose)
            {
                std::cout << "Load test " << context->run_id << " " << final_status << "\n";
                std::cout << "  Total requests: " << completed << "\n";
                std::cout << "  Errors: " << errors << " (" << error_rate << "%)\n";
                std::cout << "  Duration: " << total_duration_s << " s\n";
                std::cout << "  Actual RPS: " << actual_rps << "\n";
                std::cout << "  Avg latency: " << avg_latency << " ms\n";
                std::cout << "  P50/P95/P99: " << p50 << "/" << p95 << "/" << p99 << " ms\n";
            }
        }
        catch (const std::exception &e)
        {
            std::cerr << "Load test error: " << e.what() << "\n";
            db.update_run_status(context->run_id, "failed");
        }

        context->is_running = false;
        manager.unregister_run(context->run_id);
    }

    void collect_metrics(std::shared_ptr<RunContext> context, vayu::db::Database *db_ptr)
    {
        auto &db = *db_ptr;
        auto last_update = std::chrono::steady_clock::now();
        size_t last_total = 0;

        while (context->is_running && !context->should_stop)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));

            auto now = std::chrono::steady_clock::now();
            auto elapsed = std::chrono::duration<double>(now - last_update).count();

            if (elapsed >= 1.0) // Update every second
            {
                size_t current_total = context->total_requests.load();
                size_t current_errors = context->total_errors.load();
                size_t delta = current_total - last_total;

                double current_rps = elapsed > 0 ? delta / elapsed : 0.0;
                double error_rate = current_total > 0 ? (current_errors * 100.0 / current_total) : 0.0;

                // Store metrics
                try
                {
                    auto timestamp = now_ms();
                    db.add_metric({0, context->run_id, timestamp, "rps", current_rps, ""});
                    db.add_metric({0, context->run_id, timestamp, "error_rate", error_rate, ""});
                    db.add_metric({0, context->run_id, timestamp, "connections_active",
                                   static_cast<double>(context->event_loop->active_count()), ""});
                }
                catch (const std::exception &e)
                {
                    // Continue on error
                }

                last_update = now;
                last_total = current_total;
            }
        }
    }

} // namespace vayu::core
