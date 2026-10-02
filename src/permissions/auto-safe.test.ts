import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTO_SAFE_COMMANDS,
  analyzeBashForAuto,
  destructiveReason,
  extractRedirects,
  extraSafeMatches,
  networkReason,
} from "./auto-safe.js";
import { commandWords } from "./dangerous.js";

const root = resolve("/work/proj");
const analyze = (command: string, extraSafe: string[] = []) =>
  analyzeBashForAuto(command, { cwd: root, projectRoot: root, extraSafe });
const safe = (command: string) => analyze(command).safe;
const asks = (command: string) => analyze(command).ask;

describe("安全名单：正例（静态放行）", () => {
  it.each([
    "ls -la",
    "ls src | head -20",
    "cat package.json",
    "head -n 50 src/index.ts",
    "tail -f log.txt",
    "wc -l src/*.ts",
    "grep -rn TODO src",
    "egrep 'a|b' file",
    "rg --files",
    "rg -n 'foo bar' src",
    "pwd",
    "echo hello",
    "echo done > build/out.txt",
    "printf '%s\\n' a b",
    "which node",
    "env",
    "printenv",
    "FOO=1 echo hi",
    "find . -name '*.ts'",
    "find src -type f -newer package.json",
    "sort file.txt",
    "diff a.txt b.txt",
    "git status",
    "git status -s",
    "git -C sub status",
    "git --no-pager log --oneline -5",
    "git diff",
    "git diff HEAD~1 -- src",
    "git log --stat",
    "git show HEAD",
    "git branch",
    "git branch -a",
    "git branch --show-current",
    "git rev-parse HEAD",
    "git blame src/a.ts",
    "git ls-files",
    "npm test",
    "npm t",
    "npm run test",
    "npm run lint",
    "npm run typecheck",
    "npm run build",
    "pnpm test",
    "pnpm run lint",
    "pnpm typecheck",
    "pnpm build",
    "yarn test",
    "yarn lint",
    "node --test",
    "node --test test/a.test.js",
    "tsc --noEmit",
    "tsc -p tsconfig.json --noEmit",
    "vitest run",
    "pnpm vitest run src/a.test.ts",
    "pytest",
    "python -m pytest -q",
    "cargo test",
    "cargo check",
    "cargo build --release",
    "cargo clippy",
    "go test ./...",
    "go build ./...",
    "go vet ./...",
    "make test",
    "make lint",
    "cd sub && npm test",
    "git status && git diff --stat",
    "npm test 2>&1 | tail -20",
    "cat a.txt | grep foo | wc -l",
    "ls; pwd",
  ])("%s", (command) => {
    const result = analyze(command);
    expect(result.ask).toBeUndefined();
    expect(result.safe).toBe(true);
  });
});

describe("安全名单：反例（不放行，交给分类器）", () => {
  it.each([
    ["node scripts/gen.js", "not in the auto safe list"],
    ["python app.py", "not in the auto safe list"],
    ["rm old.txt", "not in the auto safe list"],
    ["sed -i s/a/b/ file", "not in the auto safe list"],
    ["find . -name '*.tmp' -exec cat {} ;", "not in the auto safe list"],
    ["find . -fprint out.txt", "not in the auto safe list"],
    ["rg --pre ./decode foo", "not in the auto safe list"],
    ["sort -o out.txt in.txt", "not in the auto safe list"],
    ["date -s 2020-01-01", "not in the auto safe list"],
    ["git branch -d old", "not in the auto safe list"],
    ["git branch -m new", "not in the auto safe list"],
    ["git branch --set-upstream-to=origin/x", "not in the auto safe list"],
    ["git -c core.pager=less log", "not in the auto safe list"],
    ["git diff --output=patch.diff", "not in the auto safe list"],
    ["git diff --ext-diff", "not in the auto safe list"],
    ["git commit -m wip", "not in the auto safe list"],
    ["git stash", "not in the auto safe list"],
    ["tsc", "not in the auto safe list"],
    ["tsc -p .", "not in the auto safe list"],
    ["npm run deploy", "not in the auto safe list"],
    ["npm run test:e2e", "not in the auto safe list"],
    ["pnpm --filter web test", "not in the auto safe list"],
    ["vitest", "not in the auto safe list"],
    ["cargo run", "not in the auto safe list"],
    ["go run main.go", "not in the auto safe list"],
    ["make deploy", "not in the auto safe list"],
    ["make", "not in the auto safe list"],
    ["echo $(whoami)", "command substitution"],
    ["echo `id`", "command substitution"],
    ["cat <(ls)", "command substitution"],
    ["echo $HOME", "variable expansion"],
    ["cat .*rc", "glob over dotfiles"],
    ["ls | sh", "not in the auto safe list"],
    ["cat x | bash", "not in the auto safe list"],
    ["sh -c 'ls'", "not in the auto safe list"],
    ["eval ls", "not in the auto safe list"],
    ["ls | xargs cat", "not in the auto safe list"],
    ["sudo ls", "not in the auto safe list"],
  ])("%s → %s", (command, reason) => {
    const result = analyze(command);
    expect(result.ask).toBeUndefined();
    expect(result.safe).toBe(false);
    expect(result.reason).toContain(reason);
  });
});

describe("规则层：网络命令询问", () => {
  it.each([
    "curl https://example.com",
    "wget https://example.com/x.tgz",
    "ssh host ls",
    "scp a host:/tmp",
    "rsync -a . host:/srv",
    "nc -l 8080",
    "gh pr list",
    "git push",
    "git push origin main",
    "git -C sub pull",
    "git fetch --all",
    "git clone https://x/y",
    "git submodule update --init",
    "npm install",
    "npm install left-pad",
    "npm i -D vitest",
    "npm ci",
    "pnpm add zod",
    "yarn",
    "yarn add react",
    "bun install",
    "npx create-react-app x",
    "npm publish",
    "pip install requests",
    "python -m pip install requests",
    "uv pip install x",
    "cargo install ripgrep",
    "go get example.com/x",
    "go mod download",
    "brew install jq",
    "apt-get install -y jq",
    "docker pull alpine",
    "ls && curl -s x",
    "sh -c 'curl x'",
    "find . -exec curl x {} ;",
  ])("%s", (command) => {
    expect(asks(command)).toMatch(/network|package/);
  });

  it("networkReason 反例", () => {
    for (const command of [
      "git status",
      "npm test",
      "pnpm run build",
      "go test ./...",
      "docker ps",
      "cargo build",
    ]) {
      expect(networkReason(commandWords(command))).toBeUndefined();
    }
  });
});

describe("规则层：删除与回退询问", () => {
  it.each([
    "rm -rf ./build",
    "rm -r dist",
    "rm -f a.txt",
    "rm --recursive x",
    "find . -name '*.o' -delete",
    "git clean -n",
    "git restore src/a.ts",
    "git checkout -- src/a.ts",
    "git checkout .",
    "git stash drop",
    "git stash clear",
    "shred secret.txt",
    "truncate -s 0 log.txt",
    "ls && rm -rf build",
    "sh -c 'rm -rf build'",
  ])("%s", (command) => {
    expect(asks(command)).toBeDefined();
  });

  it("destructiveReason 反例", () => {
    for (const command of [
      "rm a.txt",
      "git checkout main",
      "git stash",
      "git stash list",
      "find . -name x",
    ]) {
      expect(destructiveReason(commandWords(command))).toBeUndefined();
    }
  });
});

describe("规则层：写入目标与机密参数", () => {
  it.each([
    ["echo x > /tmp/out.txt", /outside/],
    ["echo x >> ~/.bashrc", /outside/],
    ["ls &> /tmp/log", /outside/],
    ["echo x | tee /etc/hosts", /outside/],
    ["cp a.txt /tmp/", /outside/],
    ["mv a.txt ../other/", /outside/],
    ["mkdir /opt/x", /outside/],
    ["touch ../x", /outside/],
    ["cd .. && echo x > y.txt", /outside/],
    ["echo x > .git/config", /\.git/],
    ["echo '{}' > .ama/hooks.json", /\.ama/],
    ["echo KEY=1 >> .env", /secret/],
    ["cat .env", /secret/],
    ["cat apps/web/.env.local", /secret/],
    ["head ~/.ssh/id_rsa", /secret|key|credentials/],
    ["grep token ~/.aws/credentials", /credentials/],
    ["docker run --env-file=.env x", /secret/],
    ["wc -l < .env", /secret/],
    ["cat .env*", /secret/],
    ["cat $HOME/.ssh/id_rsa", /credentials|key/],
    ["echo x > $OUT", /variable/],
  ])("%s", (command, reason) => {
    expect(asks(command)).toMatch(reason);
  });

  it("项目内写入与输出设备不询问", () => {
    for (const command of [
      "echo x > out.txt",
      "echo x > ./build/out.txt",
      "ls > /dev/null 2>&1",
      "npm test >/dev/null",
      "cat .env.example",
      "cd sub && echo x > y.txt",
    ]) {
      expect(asks(command)).toBeUndefined();
    }
  });
});

describe("重定向解析", () => {
  it("取出输出目标、输入来源，去掉描述符复制", () => {
    expect(extractRedirects("echo hi > a.txt 2>&1")).toEqual({
      outputs: ["a.txt"],
      inputs: [],
      rest: "echo hi",
    });
    expect(extractRedirects("cmd >>'b c.txt' <in.txt")).toEqual({
      outputs: ["b c.txt"],
      inputs: ["in.txt"],
      rest: "cmd",
    });
    expect(extractRedirects("cmd &> log >&2 2> err")).toMatchObject({ outputs: ["log", "err"] });
    expect(extractRedirects("echo '> not a redirect'").outputs).toEqual([]);
    expect(extractRedirects("cat <<EOF").inputs).toEqual([]);
  });
});

describe("用户追加的安全命令", () => {
  it("词前缀与通配", () => {
    expect(extraSafeMatches(["just", "test", "-v"], "just test")).toBe(true);
    expect(extraSafeMatches(["just", "deploy"], "just test")).toBe(false);
    expect(extraSafeMatches(["bun", "run", "test:unit"], "bun run test*")).toBe(true);
    expect(extraSafeMatches(["bun", "run", "dev"], "bun run test*")).toBe(false);
  });

  it("追加后静态放行，但规则层照样先判", () => {
    expect(analyze("just test", ["just test"]).safe).toBe(true);
    expect(analyze("just test", []).safe).toBe(false);
    expect(analyze("just test && curl x", ["just test"]).ask).toMatch(/network/);
    expect(analyze("just test > /tmp/x", ["just test"]).ask).toMatch(/outside/);
  });
});

describe("名单本身", () => {
  it("每条都有词前缀；网络与删除命令不在名单里", () => {
    for (const spec of AUTO_SAFE_COMMANDS) {
      expect(spec.words.length).toBeGreaterThan(0);
      expect(networkReason([...spec.words])).toBeUndefined();
      expect(destructiveReason([...spec.words])).toBeUndefined();
    }
  });
});
