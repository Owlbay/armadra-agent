import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isReadonlyBash, readonlyBashReason } from "./readonly-bash.js";

const cwd = resolve("/work/proj");
const ro = (command: string): boolean => isReadonlyBash(command, { cwd });

describe("READONLY_BASH（docs/history/wave5-plan.md §6.2）", () => {
  it.each([
    "ls -la",
    "ls src | wc -l",
    "cat src/a.ts",
    "head -n 20 README.md && tail -5 CHANGELOG.md",
    "grep -rn TODO src",
    "rg -n 'foo bar' src",
    "fd ts src",
    "find . -name '*.ts' -type f",
    "git status -s",
    "git log --oneline -20",
    "git -C sub log -1",
    "git --no-pager diff HEAD~1",
    "git show HEAD:src/a.ts",
    "git branch --list",
    "git branch",
    "git rev-parse HEAD",
    "git blame src/a.ts",
    "git ls-files",
    "tree -L 2",
    "du -sh src",
    "jq .name package.json",
    "stat package.json",
    "file README.md",
    "echo hello",
    "printf '%s\\n' a",
    "pwd",
    "which node",
    "wc -l src/a.ts 2>/dev/null",
    "cd src && ls",
  ])("放行：%s", (command) => {
    expect(readonlyBashReason(command, { cwd })).toBeUndefined();
  });

  it.each([
    ["npm test", "测试运行器不在子集"],
    ["pnpm run build", "构建不在子集"],
    ["cargo test", "测试运行器不在子集"],
    ["make check", "make 不在子集"],
    ["ls > out.txt", "输出重定向"],
    ["echo x >> notes.md", "追加重定向"],
    ["cat a | tee b", "tee 写文件"],
    ["ls $(pwd)", "命令替换"],
    ["ls `pwd`", "命令替换"],
    ["diff <(ls a) <(ls b)", "进程替换"],
    ["sh -c 'ls'", "嵌套 shell"],
    ["bash -c 'cat a'", "嵌套 shell"],
    ["eval ls", "eval"],
    ["find . -name x | xargs cat", "xargs"],
    ["find . -exec cat {} ;", "find -exec"],
    ["find . -delete", "find -delete"],
    ["fd x -x rm", "fd -x"],
    ["rg --pre cat foo", "rg --pre"],
    ["tree -o out.txt", "tree -o"],
    ["file -C -m magic", "file -C"],
    ["jq -i . a.json", "jq 就地"],
    ["git push", "网络"],
    ["git fetch", "网络"],
    ["git checkout -- .", "丢弃改动"],
    ["git commit -m x", "写仓库"],
    ["git branch -D main", "删分支"],
    ["git -c core.pager=evil log", "git -c"],
    ["git diff --ext-diff", "外部 diff 程序"],
    ["git log --output=x", "写文件"],
    ["curl https://example.com", "网络"],
    ["cat .env", "机密路径"],
    ["cat ~/.ssh/id_rsa", "机密路径"],
    ["echo $HOME", "变量展开"],
    ["GIT_EXTERNAL_DIFF=evil git diff", "环境赋值"],
    ["env", "打印环境（可能含密钥）"],
    ["env ls", "包装命令"],
    ["printenv", "打印环境（可能含密钥）"],
    ["nohup ls", "包装命令"],
    ["sudo ls", "提权"],
    ["rm -rf build", "删除"],
    ["node scripts/gen.js", "未知命令"],
    ["sed -i s/a/b/ f", "sed 不在子集"],
    ["", "空命令"],
  ])("不放行：%s（%s）", (command) => {
    expect(ro(command)).toBe(false);
  });
});
