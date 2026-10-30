#include "runtime_probe/parser.h"
#include "runtime_probe/platform.h"
#include <cassert>
#include <cstdint>
#include <iostream>

namespace esplus::node::require_builtin {
bool readable = true;
bool IsPlatformReadableRange(const void*, size_t) { return readable; }
}

int main() {
  using namespace esplus::node::require_builtin;
  const uint32_t original[] = {0x02ffc063, 0x29c02076, 0x02c04076,
      0x28c02076, 0x28c80084, 0x02c04063, 0x4c000020};
  uint32_t code[7];
  size_t checks = 0;
  for (size_t offset : {8, 512, 2040}) {
    std::copy(std::begin(original), std::end(original), code);
    code[4] = 0x28c00084 | (offset << 10);
    auto result = ParseLinuxLoong64BuiltinModuleRequireGetterOffset(code);
    assert(result.ok() && result.value().offset == offset); ++checks;
  }
  for (size_t index = 0; index < 7; ++index) {
    std::copy(std::begin(original), std::end(original), code);
    code[index] ^= 1;
    assert(!ParseLinuxLoong64BuiltinModuleRequireGetterOffset(code).ok()); ++checks;
  }
  for (size_t offset : {0, 3, 4095}) {
    std::copy(std::begin(original), std::end(original), code);
    code[4] = 0x28c00084 | (offset << 10);
    assert(!ParseLinuxLoong64BuiltinModuleRequireGetterOffset(code).ok()); ++checks;
  }
  readable = false;
  assert(!ParseLinuxLoong64BuiltinModuleRequireGetterOffset(nullptr).ok()); ++checks;
  std::cout << "PASS " << checks << " getter decoder checks\n";
}
