import { describe, expect, it } from "vitest";
import { plainTheme } from "../theme.js";
import { Loader } from "./loader.js";

describe("Loader.setAnimation", () => {
  it("switches between animated and static frames without resetting the elapsed time", () => {
    let now = 0;
    let renders = 0;
    const theme = plainTheme();
    const loader = new Loader(() => renders++, { theme, message: "Working", now: () => now });
    loader.start();
    now = 5_000;
    loader.tick();
    expect(loader.frame).toBe(theme.glyphs.spinner[1]);
    const before = renders;
    loader.setAnimation(false);
    expect(renders).toBe(before + 1);
    expect(loader.frame).toBe(theme.glyphs.spinnerStatic);
    expect(loader.render(40)[0]).toContain("5s");
    loader.setAnimation(false);
    expect(renders).toBe(before + 1);
    loader.setAnimation(true);
    expect(loader.frame).toBe(theme.glyphs.spinner[1]);
    loader.stop();
    loader.setAnimation(false);
    expect(loader.running).toBe(false);
  });
});
