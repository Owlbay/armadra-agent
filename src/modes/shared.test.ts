import { describe, expect, it } from "vitest";
import { onStdoutClosed } from "./shared.js";

describe("onStdoutClosed", () => {
  it("进程内只装一个 stdout error 监听器：多次运行不累积", () => {
    const offFirst = onStdoutClosed(() => undefined);
    const count = process.stdout.listenerCount("error");
    const offs = Array.from({ length: 12 }, () => onStdoutClosed(() => undefined));
    expect(process.stdout.listenerCount("error")).toBe(count);
    for (const off of [offFirst, ...offs]) off();
    expect(process.stdout.listenerCount("error")).toBe(count);
  });
});
