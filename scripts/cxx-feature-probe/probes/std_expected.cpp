// std::expected - the error-or-value type two engine APIs already spell as
// std::optional (phase 2.1 of #901: parse_mock_start, apply_json_field).
#include <expected>
#include <string>

std::expected<int, std::string> parse (bool ok) {
    if (!ok) {
        return std::unexpected ("refused");
    }
    return 7;
}

int main () { return parse (true).value_or (0) == 7 ? 0 : 1; }
