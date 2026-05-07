import { describe, test, expect } from "bun:test";
import { createWatchdog } from "../src/pipeline/watchdog.ts";

describe("createWatchdog", () => {
  test("fires onTimeout after inactivityMs elapses", async () => {
    let fired = false;
    const wd = createWatchdog({
      inactivityMs: 50,
      onTimeout: () => {
        fired = true;
      },
    });

    await Bun.sleep(120);
    expect(fired).toBe(true);
    wd.cancel();
  });

  test("touch resets the timer so onTimeout doesn't fire", async () => {
    let fired = false;
    const wd = createWatchdog({
      inactivityMs: 100,
      onTimeout: () => {
        fired = true;
      },
    });

    // Touch every 40ms for 200ms total — well under the 100ms inactivity
    // window each interval, so the timer should never fire.
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(40);
      wd.touch();
    }

    expect(fired).toBe(false);
    wd.cancel();
  });

  test("cancel prevents firing even after inactivityMs elapses", async () => {
    let fired = false;
    const wd = createWatchdog({
      inactivityMs: 50,
      onTimeout: () => {
        fired = true;
      },
    });

    wd.cancel();
    await Bun.sleep(120);
    expect(fired).toBe(false);
  });

  test("touch after cancel is a no-op (does not re-arm)", async () => {
    let fired = false;
    const wd = createWatchdog({
      inactivityMs: 50,
      onTimeout: () => {
        fired = true;
      },
    });

    wd.cancel();
    wd.touch();
    await Bun.sleep(120);
    expect(fired).toBe(false);
  });

  test("disabled when inactivityMs is 0 (no-op controller)", async () => {
    let fired = false;
    const wd = createWatchdog({
      inactivityMs: 0,
      onTimeout: () => {
        fired = true;
      },
    });

    await Bun.sleep(50);
    expect(fired).toBe(false);
    wd.touch();
    wd.cancel();
    expect(fired).toBe(false);
  });

  test("disabled when inactivityMs is negative", async () => {
    let fired = false;
    const wd = createWatchdog({
      inactivityMs: -100,
      onTimeout: () => {
        fired = true;
      },
    });

    await Bun.sleep(50);
    expect(fired).toBe(false);
    wd.cancel();
  });

  test("disabled when inactivityMs is NaN", async () => {
    let fired = false;
    const wd = createWatchdog({
      inactivityMs: Number.NaN,
      onTimeout: () => {
        fired = true;
      },
    });

    await Bun.sleep(50);
    expect(fired).toBe(false);
    wd.cancel();
  });

  test("only fires once even with no further touches", async () => {
    let count = 0;
    const wd = createWatchdog({
      inactivityMs: 30,
      onTimeout: () => {
        count++;
      },
    });

    await Bun.sleep(150);
    expect(count).toBe(1);
    wd.cancel();
  });
});
