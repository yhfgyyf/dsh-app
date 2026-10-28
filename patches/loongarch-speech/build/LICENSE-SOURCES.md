# Sources of shipped speech notices

Full notices are shipped in `runtime/licenses`, with exact bytes pinned in
`../payload-manifest.json`. Dependency archives are selected and hash-checked by
the pinned sherpa/ORT CMake sources. No model or binary is stored here.

| Component | Primary notice source |
| --- | --- |
| sherpa-onnx 1.13.8 | [LICENSE](https://github.com/k2-fsa/sherpa-onnx/blob/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf/LICENSE), Apache-2.0 |
| ONNX Runtime 1.28.2 and dependencies | [LICENSE](https://github.com/microsoft/onnxruntime/blob/33ca9628233dc8f002435e868d4c2e9f82766ca1/LICENSE) and [ThirdPartyNotices.txt](https://github.com/microsoft/onnxruntime/blob/33ca9628233dc8f002435e868d4c2e9f82766ca1/ThirdPartyNotices.txt) |
| SenseVoiceSmall weights | [FunASR MODEL_LICENSE v1.1](https://github.com/modelscope/FunASR/blob/12e417f4fa4490296ea2d81c5352ea2de8e4cac2/MODEL_LICENSE); [pinned model card](https://huggingface.co/FunAudioLLM/SenseVoiceSmall/blob/3847d57b6bdf2dd8875cb1508d2af43d80a16bf7/README.md). Custom model license, not the code's MIT license. |
| Converted SenseVoice ONNX | [Pinned conversion repository](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07), retaining upstream model terms |
| Silero VAD | [Upstream LICENSE](https://github.com/snakers4/silero-vad/blob/master/LICENSE), MIT; copied notice bytes are hash-pinned. [Pinned model](https://huggingface.co/csukuangfj/vad/tree/fba88cd2e921609e7675c3aaf51e0b9b295da4bc) |
| Emscripten 4.0.23 | Checked compiler archive's `emsdk/upstream/emscripten/LICENSE`; archive URL/hash in `source-lock.json` |
| libc++, libc++abi, compiler-rt, libunwind, musl | Same archive's `system/lib/{libcxx,libcxxabi,compiler-rt,libunwind}/LICENSE.TXT` and `system/lib/libc/musl/COPYRIGHT` |
| kaldi-native-fbank 1.22.3 | [LICENSE](https://github.com/csukuangfj/kaldi-native-fbank/blob/v1.22.3/LICENSE) |
| kaldi-decoder 0.3.0 | [LICENSE](https://github.com/k2-fsa/kaldi-decoder/blob/v0.3.0/LICENSE) |
| kaldifst 1.8.0 | [LICENSE](https://github.com/k2-fsa/kaldifst/blob/v1.8.0/LICENSE) |
| OpenFst 1.8.5-2026-07-09 | [COPYING](https://github.com/csukuangfj/openfst/blob/v1.8.5-2026-07-09/COPYING) |
| simple-sentencepiece 0.7 | [LICENSE](https://github.com/pkufool/simple-sentencepiece/blob/v0.7/LICENSE) |
| nlohmann/json 3.12.0 | [LICENSE.MIT](https://github.com/nlohmann/json/blob/v3.12.0/LICENSE.MIT) |
| KissFFT febd4cae | [COPYING](https://github.com/mborgerding/kissfft/blob/febd4caeed32e33ad8b2e0bb5ea77542c40f18ec/COPYING) and full [BSD-3-Clause](https://github.com/mborgerding/kissfft/blob/febd4caeed32e33ad8b2e0bb5ea77542c40f18ec/LICENSES/BSD-3-Clause) |
| Eigen 5.0.1 | [COPYING.README](https://gitlab.com/libeigen/eigen/-/blob/5.0.1/COPYING.README) and all accompanying `COPYING.*` notices |
| hclust-cpp 2026-02-25 | [LICENSE](https://github.com/csukuangfj/hclust-cpp/blob/2026-02-25/LICENSE) |
