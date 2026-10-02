/**
 * 第六波配置键的形状（docs/wave6-plan.md §7、§3.1、§4.4、§5.2）。[W6-C0] 契约文件：C0 只定形状、校验
 * （schema-w6.ts）、说明与缺省（key-docs.ts）、JSON Schema；行为由各批次实现，未实现前这些键被接受但不起作用。
 */

/** `ui.language`：auto 按 `LC_ALL` / `LC_MESSAGES` / `LANG` 判断，判断不出用 en（docs/i18n.md）。 */
export type LanguageSetting = "auto" | "zh" | "en";
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["auto", "zh", "en"];

/** 第六波在 `ui` 段新增的键。 */
export interface UiConfigW6 {
  /** 界面语言，缺省 auto；`AMA_LANG` / `--lang` 覆盖；项目级可设。 */
  language?: LanguageSetting;
}
