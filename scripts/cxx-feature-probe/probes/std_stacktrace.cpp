// std::stacktrace. The header exists on libstdc++ well before the feature is
// usable, so this probe *links* as well as compiles - on libstdc++ 13 that
// needs -lstdc++exp, which the probe deliberately does not pass. A "no" here
// therefore means "not usable as written", which is the answer #901 needs.
#include <stacktrace>

int main () { return std::stacktrace::current ().empty () ? 1 : 0; }
