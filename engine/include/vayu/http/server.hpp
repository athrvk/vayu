#pragma once

#include "vayu/db/database.hpp"
#include "vayu/core/run_manager.hpp"
#include <httplib.h>
#include <thread>
#include <atomic>
#include <memory>

namespace vayu::http
{

    class Server
    {
    public:
        Server(vayu::db::Database &db, vayu::core::RunManager &run_manager, int port, bool verbose = false);
        ~Server();

        void start();
        void stop();
        bool is_running() const;

    private:
        void setup_routes();

        vayu::db::Database &db_;
        vayu::core::RunManager &run_manager_;
        int port_;
        bool verbose_;
        httplib::Server server_;
        std::thread server_thread_;
        std::atomic<bool> is_running_{false};
    };

} // namespace vayu::http
