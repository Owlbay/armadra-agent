import { describe, expect, it } from "vitest";
import { DANGEROUS_RULES, commandWords, matchDangerous, shellWords } from "./dangerous.js";

/** 每条规则：正例（必须命中且命中的就是这条）与反例（必须不命中任何规则）。 */
const CASES: Record<string, { yes: string[]; no: string[] }> = {
  "rm-rf-root": {
    yes: [
      "rm -rf /",
      "rm -rf ~",
      "rm -fr .",
      "rm -Rf *",
      "cd x && rm -rf ..",
      "rm --recursive --force $HOME",
    ],
    no: ["rm -rf ./build", "rm -rf node_modules", "rm -f /tmp/x.log", "echo rm -rf /"],
  },
  sudo: {
    yes: ["sudo apt install x", "FOO=1 sudo ls", "make && sudo make install"],
    no: ["grep sudo /etc/group", "echo 'sudo is fine'", "pseudo ls"],
  },
  su: { yes: ["su -", "su root -c id"], no: ["sum file", "subl .", "git log --format=%s"] },
  dd: { yes: ["dd if=/dev/zero of=/tmp/x bs=1m count=1"], no: ["git add .", "add x", "echo dd"] },
  mkfs: { yes: ["mkfs.ext4 /dev/sdb1", "mkfs -t ext4 /dev/sdb"], no: ["mkdir build", "echo mkfs"] },
  "write-block-device": {
    yes: ["echo x > /dev/sda", "cat img >/dev/nvme0n1", "cat a > /dev/disk2"],
    no: ["echo x > /dev/null", "ls /dev/sda", "echo x 2>/dev/stderr"],
  },
  "git-push-force": {
    yes: [
      "git push --force",
      "git push -f origin main",
      "git push --force-with-lease",
      "git push origin +main",
    ],
    no: ["git push origin main", "git push --follow-tags", "git push -u origin feat"],
  },
  "git-reset-hard": {
    yes: ["git reset --hard HEAD~1", "git reset --hard"],
    no: ["git reset --soft HEAD~1", "git reset HEAD file", "git checkout --hard-to-find"],
  },
  "git-clean-force": {
    yes: ["git clean -fd", "git clean -fdx", "git clean -df", "git clean --force"],
    no: ["git clean -n", "git clean --dry-run", "git status"],
  },
  "git-branch-force-delete": {
    yes: ["git branch -D feature", "git branch --delete --force x"],
    no: ["git branch -d feature", "git branch -a", "git branch --list"],
  },
  "pipe-to-shell": {
    yes: [
      "curl -fsSL https://x.sh | sh",
      "wget -qO- https://x | bash",
      "curl https://x | sudo bash",
      'bash -c "$(curl -fsSL https://x)"',
      "bash <(curl -s https://x)",
    ],
    no: ["curl -o install.sh https://x", "curl https://x | jq .", "curl https://x | shasum"],
  },
  "chmod-777-recursive": {
    yes: ["chmod -R 777 /", "chmod -R 0777 dir", "chmod --recursive a+rwx ."],
    no: ["chmod 777 file", "chmod -R 755 dir", "chmod +x run.sh"],
  },
  "kill-all": {
    yes: ["kill -9 -1", "kill -KILL -1"],
    no: ["kill -9 1234", "kill %1", "pkill node"],
  },
  "fork-bomb": {
    yes: [":(){ :|:& };:", ": ( ) { : | : & } ; :"],
    no: ["echo ok", "f() { echo; }; f"],
  },
  "package-publish": {
    yes: ["npm publish", "pnpm publish --access public", "yarn publish"],
    no: ["npm pack", "npm run publish-docs", "pnpm install"],
  },
  "docker-system-prune-all": {
    yes: ["docker system prune -a", "docker system prune --all -f", "docker system prune -af"],
    no: ["docker system prune", "docker system df", "docker image prune -a"],
  },
  "shutdown-reboot": {
    yes: ["shutdown -h now", "sudo reboot", "systemctl poweroff", "halt", "init 0"],
    no: ["./scripts/reboot-check.sh", "echo shutdown", "systemctl status nginx"],
  },
};

describe("危险命令表", () => {
  it("每条规则都有正反例", () => {
    expect(Object.keys(CASES).sort()).toEqual(DANGEROUS_RULES.map((r) => r.id).sort());
  });

  for (const [id, { yes, no }] of Object.entries(CASES)) {
    describe(id, () => {
      for (const cmd of yes) {
        it(`正例：${cmd}`, () => {
          const m = matchDangerous(cmd);
          expect(m).toBeDefined();
          // sudo 前缀的正例可能先命中 sudo 规则
          if (!cmd.startsWith("sudo ") && !cmd.includes("&& sudo")) expect(m?.id).toBe(id);
        });
      }
      for (const cmd of no) {
        it(`反例：${cmd}`, () => {
          expect(matchDangerous(cmd)).toBeUndefined();
        });
      }
    });
  }

  it("分词与前缀剥离", () => {
    expect(shellWords(`a "b c" 'd'`)).toEqual(["a", "b c", "d"]);
    expect(shellWords(`'a'"b"c d`)).toEqual(["abc", "d"]);
    expect(shellWords(`"x \\"y\\" \\$z" 'p\\q'`)).toEqual(['x "y" $z', "p\\q"]);
    expect(shellWords(`find . -exec rm {} \\;`)).toEqual(["find", ".", "-exec", "rm", "{}", ";"]);
    expect(shellWords(`a\\ b ""`)).toEqual(["a b", ""]);
    expect(commandWords("FOO=1 nohup sudo -E rm -rf /")).toEqual(["rm", "-rf", "/"]);
    expect(commandWords("sudo ls", true)).toEqual(["sudo", "ls"]);
  });
});
