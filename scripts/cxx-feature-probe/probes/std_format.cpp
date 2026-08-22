// std::format - C++20, not C++23. Probed anyway because #901 names the five
// ostringstream sites it would replace, and "already available" is a claim the
// probe should keep honest on every platform rather than assert once.
#include <format>
#include <string>

int main () {
    const std::string rendered = std::format ("{}:{}", "port", 9876);
    return rendered == "port:9876" ? 0 : 1;
}
