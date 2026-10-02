/**
 * 消息目录的类型（docs/wave6-plan.md §5.1；docs/i18n.md）。[W6-C0]
 *
 * 每个领域文件导出 `en`（形状源）与 `zh`（`satisfies Messages<typeof en>`）：缺键、多键、函数参数个数 /
 * 类型不符都在 `tsc --noEmit` 期报错——这就是覆盖率检查，不需要运行期脚本。
 */

/** 消息叶子：整句字符串，或返回整句的插值函数（参数类型由 en 决定）。 */
export type MessageLeaf = string | ((...args: any[]) => string);

/**
 * 由 en 的形状推出另一种语言必须满足的形状：字符串叶子 → `string`，函数叶子 → 同参数签名返回 `string`，
 * 对象 → 递归。
 */
export type Messages<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : T[K] extends string
      ? string
      : Messages<T[K]>;
};
