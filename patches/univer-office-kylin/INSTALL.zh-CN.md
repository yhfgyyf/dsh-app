# 麒麟龙芯测试版：0.3.5-kylin.1

此包针对 DSH Desktop 0.1.28 / DSH 0.2.0-rc.1、麒麟 V10 SP1
loongarch64 旧 ABI、glibc 2.28 和内置 Node 22.16.0。它是本地兼容测试版，
不是 Univer 官方版本，也不代表完整的 Office 功能已适配完成。

## 能力与限制

- 使用 Node 内置 SQLite 保存 `.univer` 文件，不依赖龙芯版 libsql 插件。
- 使用包内既有的 JavaScript 公式引擎；大型表格性能和全部公式的一致性尚未验证。
- 保留 DSH rc.1 兼容、`right` 对齐别名及默认 `telemetry: false`。
- Excel、Word、PowerPoint、CSV、TSV 的导入导出暂不可用。它们均依赖尚无
  龙芯构建的官方转换模块，调用时明确返回 `KYLIN_EXCHANGE_UNAVAILABLE`。
- 截图、PDF 输出及依赖浏览器测量的功能需要通过插件配置 `browserExecutablePath`
  或环境变量 `UNIVER_RENDER_BROWSER` 指定兼容的龙芯 Chrome/Chromium。
  未配置时会明确报错，不自动下载 x86 浏览器。旧浏览器的兼容性需实机验证。
- QEMU 验证不能替代麒麟桌面上的预览、字体和图形驱动验证。

## 安装和回退

先退出 DSH，备份 DSH 的 `core/profiles/desktop` 目录及现有 `.univer` 文件。
打开 DSH「设置 → 插件」，选择本地生成的 `.tgz` 包进行安装，按提示重启。
不要使用“忽略兼容性”来安装官方原包；它仍缺少龙芯原生依赖。

此测试包保持同一个插件名，安装后会替换现有 Univer 插件。回退时退出 DSH，
恢复之前备份的 profile 和测试前的文件。请用文件副本测试，避免让未验证的
旧文件迁移流程处理唯一原件。无需覆盖或重装 DSH Desktop App。

## 手动测试案例

新建一个空工作目录，在 DSH 对话中输入：

> 用 Univer 在当前目录新建 kylin-test.univer，建立一个表格草稿。在 A1:C3
> 写入“项目、数量、单价”，以及“铅笔、3、2”和“本子、2、5”。在 D1 写入
> “金额”，D2、D3 用公式计算数量乘单价，D4 求和。读取并报告三个结果。
> 把 B2 改为 4，再读取结果。不要导出 Office 文件；完成后等待我确认合并。

应先得到 `6、10、16`，修改后得到 `8、10、18`。确认合并草稿，关闭并重启
DSH，再读取该文件核对结果。在预览中检查中文及单元格编辑，再创建文档和
幻灯片检查预览。截图/PDF 需先指定兼容的本机浏览器；Office 导出应明确说明
当前测试版不可用，不应生成损坏文件或影响继续编辑。
