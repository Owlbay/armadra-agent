/**
 * 消息目录：acp（键名规范见 docs/i18n.md）。[ACP-C0 从 print.acp 迁入，docs/acp-plan.md D15]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * 发给 ACP 客户端的 name / description / error message 是给人看的，走这里；`_meta`、id、value 等机器字段不翻译。
 * 子对象各归一个批次：core（现有服务端文案）、auth（A）、session（B）、tools（C）、config / client（D）。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  /** ACP 服务端（`ama --mode acp`）的现有文案。 */
  core: {
    missingParam: (key: string) => `missing ${key}`,
    promptNotArray: "prompt must be an array of content blocks",
    unparsable: (reason: string) => `ACP: unparsable input (${reason})`,
    missingProtocolVersion: "missing protocolVersion",
    fixedCwd: (cwd: string, got: string) =>
      `the session directory of ama --mode acp is fixed to the start directory ${cwd} (got ${got})`,
    sessionNotFound: (id: string, error: string) => `session ${id} not found: ${error}`,
    busy: "the current session is running; send session/cancel first",
    modelFailed: "model request failed",
    unknownMode: (mode: string) => `unknown mode: ${mode}`,
    allowOnce: "Allow",
    allowAlways: "Allow for this session",
    rejectOnce: "Deny",
    truncated: (length: number) => `…(truncated, ${plural(length, "character")} in total)`,
    unknownConfigOption: (id: string) => `unknown config option: ${id}`,
  },
  /** [ACP-A] 认证门与终端认证方法。 */
  auth: {},
  /** [ACP-B] 多会话与会话元数据。 */
  session: {},
  /** [ACP-C] 工具调用映射。 */
  tools: {},
  /** [ACP-D] 配置项与命令表。 */
  config: {},
  /** [ACP-D] ama 作 ACP 客户端时的文案。 */
  client: {},
};

export const zh = {
  core: {
    missingParam: (key) => `缺少 ${key}`,
    promptNotArray: "prompt 应为内容块数组",
    unparsable: (reason) => `ACP：无法解析的输入（${reason}）`,
    missingProtocolVersion: "缺少 protocolVersion",
    fixedCwd: (cwd, got) => `ama --mode acp 的会话目录固定为启动目录 ${cwd}（收到 ${got}）`,
    sessionNotFound: (id, error) => `找不到会话 ${id}：${error}`,
    busy: "当前会话正在运行，先 session/cancel",
    modelFailed: "模型请求失败",
    unknownMode: (mode) => `未知模式：${mode}`,
    allowOnce: "允许",
    allowAlways: "本会话允许",
    rejectOnce: "拒绝",
    truncated: (length) => `…（已截断，共 ${length} 字符）`,
    unknownConfigOption: (id) => `未知配置项：${id}`,
  },
  auth: {},
  session: {},
  tools: {},
  config: {},
  client: {},
} satisfies Messages<typeof en>;
