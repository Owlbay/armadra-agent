/**
 * 全部领域的汇总（docs/wave6-plan.md §5.1、D23）。[W6-C0] 一次登记全部领域，之后无人再改本文件：
 * 各批次只改自己的 `messages/<领域>.ts`。
 *
 * 领域 → 所有者：cli / subcommands（I1）；interactive / approval / plan / rewind / panels / permissions（I2）；
 * report / print / drivers / session / errors（I3）；config（I4）；agents（A）；trace（T1 / T2）；
 * memory（M）；auth（O）；settings（S）；acp（ACP-C0 新增，docs/acp-plan.md D15）。
 */

import type { Messages } from "./types.js";
import * as cli from "./messages/cli.js";
import * as subcommands from "./messages/subcommands.js";
import * as interactive from "./messages/interactive.js";
import * as approval from "./messages/approval.js";
import * as plan from "./messages/plan.js";
import * as rewind from "./messages/rewind.js";
import * as panels from "./messages/panels.js";
import * as permissions from "./messages/permissions.js";
import * as report from "./messages/report.js";
import * as print from "./messages/print.js";
import * as config from "./messages/config.js";
import * as drivers from "./messages/drivers.js";
import * as session from "./messages/session.js";
import * as errors from "./messages/errors.js";
import * as agents from "./messages/agents.js";
import * as trace from "./messages/trace.js";
import * as memory from "./messages/memory.js";
import * as auth from "./messages/auth.js";
import * as settings from "./messages/settings.js";
import * as acp from "./messages/acp.js";

const en = {
  cli: cli.en,
  subcommands: subcommands.en,
  interactive: interactive.en,
  approval: approval.en,
  plan: plan.en,
  rewind: rewind.en,
  panels: panels.en,
  permissions: permissions.en,
  report: report.en,
  print: print.en,
  config: config.en,
  drivers: drivers.en,
  session: session.en,
  errors: errors.en,
  agents: agents.en,
  trace: trace.en,
  memory: memory.en,
  auth: auth.en,
  settings: settings.en,
  acp: acp.en,
};

/** 运行期取用的目录形状：en 的形状、叶子放宽为 string / 同签名函数。 */
export type Catalog = Messages<typeof en>;

const zh = {
  cli: cli.zh,
  subcommands: subcommands.zh,
  interactive: interactive.zh,
  approval: approval.zh,
  plan: plan.zh,
  rewind: rewind.zh,
  panels: panels.zh,
  permissions: permissions.zh,
  report: report.zh,
  print: print.zh,
  config: config.zh,
  drivers: drivers.zh,
  session: session.zh,
  errors: errors.zh,
  agents: agents.zh,
  trace: trace.zh,
  memory: memory.zh,
  auth: auth.zh,
  settings: settings.zh,
  acp: acp.zh,
} satisfies Catalog;

export const CATALOGS: { readonly en: Catalog; readonly zh: Catalog } = { en, zh };

/** 领域名（一级命名空间）。 */
export const MESSAGE_DOMAINS = Object.keys(en) as readonly (keyof Catalog)[];
