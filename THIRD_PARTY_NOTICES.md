# 第三方声明

ama 自身以 MIT 许可发布（见 `LICENSE`）。以下第三方内容随 ama 分发，按各自许可保留声明。

## models.dev

- 内容：模型元数据快照（`src/ai/providers/models-dev/*.json` 及由它生成、内联进 bundle 的 `src/ai/providers/models-dev-data.ts`），由 `scripts/update-models-dev.mjs` 从 <https://models.dev/api.json> 裁剪而来；`ama models refresh` 写到用户数据目录的覆盖文件同源。
- 来源：<https://github.com/anomalyco/models.dev>（原 `sst/models.dev`）。
- 未分发 models.dev 的 logo 或其它图形资源。
- 许可：MIT

```text
MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
