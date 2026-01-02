/**
 * @file tests/db_test.cpp
 * @brief Tests for Database class
 */

#include <gtest/gtest.h>
#include "vayu/db/database.hpp"
#include <filesystem>

namespace vayu::db
{
    namespace
    {
        const std::string TEST_DB_PATH = "test_vayu.db";

        class DatabaseTest : public ::testing::Test
        {
        protected:
            void SetUp() override
            {
                // Ensure clean state
                if (std::filesystem::exists(TEST_DB_PATH))
                {
                    std::filesystem::remove(TEST_DB_PATH);
                }
                if (std::filesystem::exists(TEST_DB_PATH + "-wal"))
                {
                    std::filesystem::remove(TEST_DB_PATH + "-wal");
                }
                if (std::filesystem::exists(TEST_DB_PATH + "-shm"))
                {
                    std::filesystem::remove(TEST_DB_PATH + "-shm");
                }
            }

            void TearDown() override
            {
                // Cleanup
                if (std::filesystem::exists(TEST_DB_PATH))
                {
                    std::filesystem::remove(TEST_DB_PATH);
                }
                if (std::filesystem::exists(TEST_DB_PATH + "-wal"))
                {
                    std::filesystem::remove(TEST_DB_PATH + "-wal");
                }
                if (std::filesystem::exists(TEST_DB_PATH + "-shm"))
                {
                    std::filesystem::remove(TEST_DB_PATH + "-shm");
                }
            }
        };

        TEST_F(DatabaseTest, CreatesDatabaseFile)
        {
            {
                Database db(TEST_DB_PATH);
                db.init();
            }
            EXPECT_TRUE(std::filesystem::exists(TEST_DB_PATH));
        }

        TEST_F(DatabaseTest, CreatesAndRetrievesRun)
        {
            Database db(TEST_DB_PATH);
            db.init();

            vayu::db::Run run;
            run.id = "run_1";
            run.type = "load";
            run.status = "pending";
            run.start_time = 1000;
            run.config_snapshot = "{}";

            db.create_run(run);

            auto retrieved = db.get_run("run_1");
            ASSERT_TRUE(retrieved.has_value());
            EXPECT_EQ(retrieved->id, "run_1");
            EXPECT_EQ(retrieved->type, "load");
            EXPECT_EQ(retrieved->status, "pending");
        }

        TEST_F(DatabaseTest, UpdatesRunStatus)
        {
            Database db(TEST_DB_PATH);
            db.init();

            vayu::db::Run run;
            run.id = "run_1";
            run.type = "load";
            run.status = "pending";
            run.start_time = 1000;
            run.config_snapshot = "{}";

            db.create_run(run);
            db.update_run_status("run_1", "completed");

            auto retrieved = db.get_run("run_1");
            ASSERT_TRUE(retrieved.has_value());
            EXPECT_EQ(retrieved->status, "completed");
        }

        TEST_F(DatabaseTest, AddsAndRetrievesMetrics)
        {
            Database db(TEST_DB_PATH);
            db.init();

            vayu::db::Run run;
            run.id = "run_1";
            run.type = "load";
            run.status = "running";
            run.start_time = 1000;
            run.config_snapshot = "{}";
            db.create_run(run);

            vayu::db::Metric m1;
            m1.run_id = "run_1";
            m1.timestamp = 1001;
            m1.name = "requests_total";
            m1.value = 10.0;

            vayu::db::Metric m2;
            m2.run_id = "run_1";
            m2.timestamp = 1002;
            m2.name = "requests_total";
            m2.value = 20.0;

            db.add_metric(m1);
            db.add_metric(m2);

            auto metrics = db.get_metrics("run_1");
            ASSERT_EQ(metrics.size(), 2);
            EXPECT_EQ(metrics[0].value, 10.0);
            EXPECT_EQ(metrics[1].value, 20.0);
        }

        TEST_F(DatabaseTest, RetrievesAllRuns)
        {
            Database db(TEST_DB_PATH);
            db.init();

            vayu::db::Run r1;
            r1.id = "run_1";
            r1.type = "load";
            r1.status = "completed";
            r1.start_time = 1000;
            r1.config_snapshot = "{}";

            vayu::db::Run r2;
            r2.id = "run_2";
            r2.type = "design";
            r2.status = "failed";
            r2.start_time = 2000;
            r2.config_snapshot = "{}";

            db.create_run(r1);
            db.create_run(r2);

            auto runs = db.get_all_runs();
            ASSERT_EQ(runs.size(), 2);
            // Order might depend on insertion or ID, but we just check existence
            bool found1 = false;
            bool found2 = false;
            for (const auto &r : runs)
            {
                if (r.id == "run_1")
                    found1 = true;
                if (r.id == "run_2")
                    found2 = true;
            }
            EXPECT_TRUE(found1);
            EXPECT_TRUE(found2);
        }

    } // namespace
} // namespace vayu::db
