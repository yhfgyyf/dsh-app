# DSH 内置运行时测试案例

此示例离线生成学生成绩表、报告、演示文稿和 PDF，并重新读取文件校验结果。无需系统 Python、Node.js、Office 或 API key。

在 DSH 新建一个工作区，发送：

> 请调用 load_workspace_dependencies，使用返回的 python 运行 officeExample，传入 --output 指向当前工作区下一个新的空文件夹“内置库测试”，并用 --node 传入返回的 node 路径。不要安装或下载依赖。运行后读取“测试报告.json”，逐项说明是否通过，并给出生成的 XLSX、DOCX、PPTX、PDF、PNG 文件链接。PPT 中的文字和表格应可编辑，图片是独立对象。

若工具没有直接出现在目录中，可先使用 search_tools 搜索 `load_workspace_dependencies`。

也可以手动运行（将路径替换为工具返回的绝对路径）：

```sh
"<python>" -I -B "<officeExample>" --output "<新的空文件夹>" --node "<node>"
```

Windows PowerShell 在命令前加 `&`：

```powershell
& "<python>" -I -B "<officeExample>" --output "<新的空文件夹>" --node "<node>"
```

成功时退出码为 0，测试报告中 `passed` 为 `true`。生成的内容包括：

- `成绩表.xlsx`：XlsxWriter 生成，openpyxl 检查公式和缓存总分 270、278、243。
- `成绩表-已编辑.xlsx`：openpyxl 添加说明工作表，验证再次保存与读取。
- `成绩报告.docx`：可编辑文字、成绩表格和图片。
- `成绩演示.pptx`：两页演示文稿，包含可编辑文字、表格及独立图片，并非整页截图。
- `成绩摘要.pdf`：ReportLab 生成，pypdf 检查页数并提取文字；使用英文正文避免依赖额外字体。
- `示例图.png`、`成绩数据.json`、`测试报告.json`。

示例会拒绝非空输出目录。脚本失败时请保留错误消息；不要把仅创建成功的文件当作全部测试通过。此案例验证库与运行时，不替代在实际 App 中查看文件、编辑内容的人工检查。

需要额外 Python 库时，请在工作区用内置解释器创建虚拟环境，不修改安装目录中的随包库。可使用 `"<python>" -m venv --system-site-packages .venv` 复用这些库，再通过虚拟环境里的 Python 执行 `-m pip install ...`。
