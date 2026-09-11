# Document preview fixtures

These small, synthetic files are committed so macOS and Windows GUI tests need no Python dependencies. `manifest.json` lists stable hashes and expected text, sheet values, slide counts and media properties.

Regenerate with Python that has `python-docx`, `python-pptx` and `openpyxl`:

```sh
python3 tests/fixtures/document-preview/generate.py
```

The generator verifies every document after writing, fixes Office ZIP timestamps and core dates, and includes cached formula values in the XLSX. Use `--output <temporary-directory>` to verify regeneration without changing the committed fixtures.

- `sample.docx`: Chinese paragraphs, one table and one embedded PNG; text marker `DOCX_PREVIEW_OK`.
- `sample.pptx`: two slides with Chinese text, shapes and one image per slide; markers `PPTX_SLIDE_1_OK` and `PPTX_SLIDE_2_OK`.
- `sample.xlsx`: sheets `销售数据` and `汇总`; cached formula results 50, 24 and 74; marker `XLSX_SECOND_SHEET_OK`.
- `sample.wav`: a 0.25-second, mono 440 Hz tone at 8 kHz.
- `utf8.txt`, `utf8-bom.txt`, `utf16le.txt`, `utf16be.txt`, `gbk.txt`: identical Chinese text and the marker `TXT_PREVIEW_OK`, encoded as named. Both UTF-16 files include a BOM.
- `sample.png`: the small chart embedded in the DOCX and PPTX.

`sample.mp4` is a separate committed, silent H.264 fixture (64×48, 0.5 seconds), generated with FFmpeg rather than the Python script:

```sh
ffmpeg -f lavfi -i color=c=0x245DC1:s=64x48:r=8:d=0.5 -an -c:v libx264 -profile:v baseline -pix_fmt yuv420p -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact sample.mp4
```

The Electron acceptance test also derives real XLS and ODS files from the XLSX using the installed SheetJS package, so neither Python nor FFmpeg is needed in CI.
