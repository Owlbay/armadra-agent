// 把一组 JSON 值生成「id → 紧凑 JSON 字符串」的 TS 模块（catalog-data.ts 与 models-dev-data.ts 共用）。
// bundle 是单文件，运行时不能读 JSON 文件，所以数据以字符串常量内联；键按传入顺序输出。

/**
 * @param {{ header: readonly string[]; exportName: string; entries: Iterable<[string, unknown]> }} options
 * @returns {string}
 */
export function inlineJsonModule({ header, exportName, entries }) {
  const lines = ["/**", ...header.map((line) => (line === "" ? " *" : ` * ${line}`)), " */", ""];
  lines.push(`export const ${exportName}: Readonly<Record<string, string>> = {`);
  for (const [id, value] of entries) {
    const key = /^[a-z_]+$/.test(id) ? id : JSON.stringify(id);
    lines.push(`  ${key}:`, `    ${JSON.stringify(JSON.stringify(value))},`);
  }
  lines.push("};", "");
  return lines.join("\n");
}
