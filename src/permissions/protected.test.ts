import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { insideProject, secretPathReason, writeProtectionReason } from "./protected.js";

const root = resolve("/work/proj");
const home = homedir();
const p = (rel: string): string => join(root, rel);

describe("机密路径", () => {
  it.each([
    p(".env"),
    p(".env.local"),
    p("apps/web/.env.production"),
    p("config/prod.env"),
    join(home, ".ssh/id_ed25519"),
    join(home, ".ssh/config"),
    p("deploy/id_rsa"),
    p("certs/server.pem"),
    p("certs/tls.key"),
    p("android/release.jks"),
    join(home, ".aws/credentials"),
    join(home, ".gnupg/pubring.kbx"),
    join(home, ".kube/config"),
    join(home, ".docker/config.json"),
    join(home, ".config/gcloud/credentials.db"),
    join(home, ".netrc"),
    join(home, ".git-credentials"),
    join(home, ".config/ama/auth.json"),
  ])("%s 是机密", (path) => {
    expect(secretPathReason(path)).toBeDefined();
  });

  it.each([
    p(".env.example"),
    p(".env.sample"),
    p(".env.template"),
    p("src/env.ts"),
    p("src/environment.ts"),
    p("docs/keys.md"),
    p("id_rsa.pub"),
    p("src/auth.json"),
    join(home, ".kube/cache/x"),
    p("README.md"),
  ])("%s 不是机密", (path) => {
    expect(secretPathReason(path)).toBeUndefined();
  });
});

describe("受保护写入", () => {
  it("项目内普通文件可写", () => {
    expect(writeProtectionReason(p("src/a.ts"), root)).toBeUndefined();
    expect(writeProtectionReason(p("build/out.js"), root)).toBeUndefined();
    expect(writeProtectionReason(p(".github/workflows/ci.yml"), root)).toBeUndefined();
    expect(writeProtectionReason(p(".amarc"), root)).toBeUndefined();
  });

  it(".git 内部、项目 .ama、机密、项目外受保护", () => {
    expect(writeProtectionReason(p(".git/config"), root)).toMatch(/\.git/);
    expect(writeProtectionReason(p("sub/.git/hooks/pre-commit"), root)).toMatch(/\.git/);
    expect(writeProtectionReason(p(".ama/hooks.json"), root)).toMatch(/\.ama/);
    expect(writeProtectionReason(p(".ama"), root)).toMatch(/\.ama/);
    expect(writeProtectionReason(p(".env"), root)).toMatch(/secret/);
    expect(writeProtectionReason(resolve("/work/other/a.ts"), root)).toMatch(/outside/);
    expect(writeProtectionReason(resolve("/tmp/x.txt"), root)).toMatch(/outside/);
    expect(writeProtectionReason(resolve("/work/proj-evil/a"), root)).toMatch(/outside/);
  });

  it("/dev/null 等输出设备不算写项目外", () => {
    for (const dev of ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]) {
      expect(writeProtectionReason(dev, root)).toBeUndefined();
    }
  });

  it("insideProject 含项目根本身，不含同前缀的兄弟目录", () => {
    expect(insideProject(root, root)).toBe(true);
    expect(insideProject(p("a/b"), root)).toBe(true);
    expect(insideProject(resolve("/work/proj2"), root)).toBe(false);
  });
});
