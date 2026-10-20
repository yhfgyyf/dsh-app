# Univer cross-platform compatibility package

One `dsh-univer-office@0.3.5-universal.1` archive supports the current DSH
0.2.1-rc.2 runtime on macOS, Windows, Linux x64 and Kylin LoongArch64.
It retains the exact 0.2.0-rc.1 peer support of the previous desktop package.

The plugin automatically chooses its backend from the actual platform and CPU.
Standard platforms keep libsql, native formulas and Office conversion. LoongArch
uses the previously verified Node SQLite adapter and JavaScript formula engine.
Native modules are optional installation dependencies, so their absence does not
prevent installation on LoongArch. No new production dependency is introduced.

On LoongArch, .univer creation, editing, formulas, merge and reopening are
supported. The pinned upstream Office converter has no LoongArch native module;
Office import/export fails clearly before writing output. Screenshots and PDF
require an explicitly configured compatible browser, rather than downloading an
x86 browser. These limitations are selected only on LoongArch.

The builder starts from the exact reviewed desktop.1 archive, verifies every
baseline and preserves unrelated payload bytes. It never changes user profiles.
Install this same archive through the App plugin manager on each platform, then
fully exit DSH and relaunch. Existing configuration and .univer files are kept.
