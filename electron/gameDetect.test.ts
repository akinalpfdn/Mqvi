import { describe, it, expect } from "vitest";
import {
  classify, SuffixIndex, GpuAverages, admitKey, GPU_FLOOR_PERCENT, GPU_WINDOW_SAMPLES,
  type ProbeCandidate,
} from "./gameDetect";

// Real values, as game-probe.exe reported them on 2026-07-17.
const DIABLO_STEAM = "D:\\SteamLibrary\\steamapps\\common\\Diablo IV\\Diablo IV.exe";
const DIABLO_BNET = "D:\\games\\Diablo IV\\Diablo IV.exe";
const INDIE = "D:\\portable\\indie\\game.exe";

function candidate(over: Partial<ProbeCandidate> = {}): ProbeCandidate {
  return {
    pid: 1, gpu3d: 0, videoDecode: 0, videoEncode: 0,
    hwnd: 461704, area: 2073600, title: "Diablo IV", exePath: DIABLO_STEAM,
    ...over,
  };
}

function deps(over: Partial<Parameters<typeof classify>[1]> = {}) {
  return {
    installed: [{ name: "Diablo® IV", dir: "d:\\steamlibrary\\steamapps\\common\\diablo iv" }],
    list: new SuffixIndex([{ exe: "diablo iv/diablo iv.exe", name: "Diablo IV" }]),
    averageGpu: () => 0,
    admitted: new Set<string>(),
    ...over,
  };
}

describe("classify", () => {
  it("should name a game from its steam library without consulting the gpu", () => {
    // 0.5% is what Diablo IV actually read while backgrounded - below the desktop's noise peak.
    const got = classify([candidate({ gpu3d: 0.5 })], deps());
    expect(got).toMatchObject({ name: "Diablo® IV", via: "library" });
  });

  it("should fall back to the games list when no library covers the install", () => {
    const got = classify([candidate({ exePath: DIABLO_BNET })], deps());
    expect(got).toMatchObject({ name: "Diablo IV", via: "list" });
  });

  it("should hand the caller a desktopCapturer-shaped source id", () => {
    expect(classify([candidate()], deps())?.sourceId).toBe("window:461704:0");
  });

  it("should reject a denylisted app even when it saturates the gpu", () => {
    const obs = candidate({
      exePath: "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe",
      title: "OBS 30.0.0", gpu3d: 40,
    });
    expect(classify([obs], deps({ averageGpu: () => 40 }))).toBeNull();
  });

  it("should reject wallpaper engine even though it sits in a real steam library", () => {
    const we = candidate({
      exePath: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe",
      title: "Wallpaper Engine", gpu3d: 2,
    });
    const withLib = deps({
      installed: [{ name: "Wallpaper Engine", dir: "c:\\program files (x86)\\steam\\steamapps\\common\\wallpaper_engine" }],
      averageGpu: () => 2,
    });
    expect(classify([we], withLib)).toBeNull();
  });

  it("should pick the real game over a denylisted app that outranks it on gpu", () => {
    const we = candidate({
      pid: 2, gpu3d: 50,
      exePath: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe",
      title: "Wallpaper Engine",
    });
    expect(classify([we, candidate()], deps())).toMatchObject({ name: "Diablo® IV" });
  });

  it("should pick the library's game over an unlisted app that outranks it on gpu", () => {
    // The layers are the outer loop. Ranked candidate-first, this app answers via layer 4 before the
    // real game behind it is ever looked at — and it is not on the denylist, so nothing else stops
    // it. 6% is what Diablo IV reads once backgrounded, which is its state while this row is up.
    const hog = candidate({
      pid: 2, gpu3d: 40, exePath: "C:\\Program Files\\Krita\\bin\\krita.exe", title: "Krita",
    });
    const got = classify(
      [hog, candidate({ gpu3d: 6 })],
      deps({ averageGpu: (pid) => (pid === 2 ? 40 : 6) })
    );
    expect(got).toMatchObject({ name: "Diablo® IV", via: "library" });
  });

  it("should pick the list's game over an unlisted app that outranks it on gpu", () => {
    const hog = candidate({
      pid: 2, gpu3d: 40, exePath: "C:\\Program Files\\Krita\\bin\\krita.exe", title: "Krita",
    });
    const got = classify(
      [hog, candidate({ gpu3d: 6, exePath: DIABLO_BNET })],
      deps({ installed: [], averageGpu: (pid) => (pid === 2 ? 40 : 6) })
    );
    expect(got).toMatchObject({ name: "Diablo IV", via: "list" });
  });

  it("should still take the gpu candidate when no layer above it matches", () => {
    const hog = candidate({
      pid: 2, gpu3d: 40, exePath: "C:\\Program Files\\Krita\\bin\\krita.exe", title: "Krita",
    });
    const got = classify([hog], deps({ installed: [], list: null, averageGpu: () => 40 }));
    expect(got).toMatchObject({ name: "Krita", via: "gpu" });
  });

  it("should reject the desktop's own fullscreen Program Manager window", () => {
    const pm = candidate({
      exePath: "C:\\Windows\\explorer.exe", title: "Program Manager", hwnd: 65894,
    });
    expect(classify([pm], deps())).toBeNull();
  });

  it("should reject a process whose path we cannot read", () => {
    // OBS run as administrator while mqvi is not: the path read crosses a privilege boundary and
    // comes back empty, so the denylist has nothing to match and only the GPU is left. Offering it
    // would put "OBS 30.0.0" in the row, named from its window title.
    const elevated = candidate({ exePath: "", title: "OBS 30.0.0", gpu3d: 40 });
    expect(classify([elevated], deps({ averageGpu: () => 40 }))).toBeNull();
  });

  it("should still offer an identifiable game when an unreadable process outranks it", () => {
    const elevated = candidate({ pid: 2, exePath: "", title: "OBS 30.0.0", gpu3d: 40 });
    const got = classify(
      [elevated, candidate({ gpu3d: 6 })],
      deps({ averageGpu: (pid) => (pid === 2 ? 40 : 6) })
    );
    expect(got).toMatchObject({ name: "Diablo® IV", via: "library" });
  });

  it("should reject a candidate with no visible window", () => {
    // Services, miners and ML jobs report under engtype_3D on NVIDIA - this is what drops them.
    const headless = candidate({ exePath: "C:\\ml\\train.exe", hwnd: 0, area: 0, gpu3d: 90 });
    expect(classify([headless], deps({ averageGpu: () => 90 }))).toBeNull();
  });

  it("should admit an unlisted game once its average clears the floor", () => {
    const indie = candidate({
      pid: 222, exePath: "D:\\portable\\indie\\game.exe", title: "Some Indie Game",
    });
    const got = classify([indie], deps({ averageGpu: () => GPU_FLOOR_PERCENT + 1 }));
    expect(got).toMatchObject({ name: "Some Indie Game", via: "gpu" });
  });

  it("should keep an admitted game when it backgrounds and its gpu collapses", () => {
    // The whole point: pressing the button means alt-tabbing away, which is when this happens.
    const indie = candidate({
      pid: 222, exePath: INDIE, title: "Some Indie Game", gpu3d: 0.5,
    });
    const got = classify(
      [indie],
      deps({ averageGpu: () => 0.5, admitted: new Set([admitKey(indie)]) })
    );
    expect(got).toMatchObject({ name: "Some Indie Game" });
  });

  it("should not let a recycled pid inherit an admission", () => {
    // Windows reuses pids. Keyed on the pid alone, a fresh process would walk straight past the
    // floor into the row on the strength of a dead game's admission.
    const impostor = candidate({
      pid: 222, exePath: "C:\\something\\else.exe", title: "Something Else", gpu3d: 0.5,
    });
    const admitted = new Set([admitKey({ pid: 222, exePath: INDIE })]);
    expect(classify([impostor], deps({ averageGpu: () => 0.5, admitted }))).toBeNull();
  });

  it("should not admit an unlisted process that never cleared the floor", () => {
    const idle = candidate({
      pid: 222, exePath: "D:\\portable\\indie\\game.exe", title: "Some Indie Game", gpu3d: 0.5,
    });
    expect(classify([idle], deps({ averageGpu: () => 0.5 }))).toBeNull();
  });

  it("should record which layer named the game", () => {
    expect(classify([candidate()], deps())?.via).toBe("library");
    expect(classify([candidate({ exePath: DIABLO_BNET })], deps())?.via).toBe("list");
  });

  it("should carry the launcher's cached icon when the library has one", () => {
    // Diablo IV.exe embeds no icon — Windows answers with its generic one — so the art Steam
    // cached is the only thing that looks like the game.
    const icon = "C:\\Steam\\appcache\\librarycache\\2344520\\15d3e861875701ec9b01f9d9b606c7c8379e6115.jpg";
    const withIcon = deps({
      installed: [{ name: "Diablo® IV", dir: "d:\\steamlibrary\\steamapps\\common\\diablo iv", iconFile: icon }],
    });
    expect(classify([candidate()], withIcon)?.iconFile).toBe(icon);
  });

  it("should leave iconFile unset when the game came from the list or the gpu", () => {
    expect(classify([candidate({ exePath: DIABLO_BNET })], deps())?.iconFile).toBeUndefined();
  });
});

describe("GpuAverages", () => {
  // Diablo IV's real series, sampled 2026-07-17 while playing.
  const DIABLO = [11, 15, 6, 10, 21, 6, 5, 5, 1, 24, 38, 1, 9, 45, 20, 27, 14, 19];
  // Chrome Remote Desktop over the same window - the loudest thing on an idle desktop.
  const NOISE = [1, 2, 1, 1, 2, 1, 1, 1, 0, 0, 1, 1, 2, 1, 1, 1, 1, 1];

  function feed(avg: GpuAverages, pid: number, series: number[]) {
    for (const v of series) {
      avg.push([{ pid, gpu3d: v, videoDecode: 0, videoEncode: 0, hwnd: 1, area: 1, title: "t", exePath: "x" }]);
    }
  }

  it("should separate a real game from desktop noise on the average", () => {
    const game = new GpuAverages();
    feed(game, 1, DIABLO);
    const noise = new GpuAverages();
    feed(noise, 2, NOISE);

    expect(game.average(1)).toBeGreaterThan(GPU_FLOOR_PERCENT);
    expect(noise.average(2)).toBeLessThan(GPU_FLOOR_PERCENT);
  });

  it("should hold the game above the floor at the instants it dips below the noise peak", () => {
    // The game touches 1% while noise peaks at 2%: an instantaneous compare picks the wrong one.
    const avg = new GpuAverages();
    feed(avg, 1, DIABLO);
    expect(Math.min(...DIABLO)).toBeLessThan(Math.max(...NOISE));
    expect(avg.average(1)).toBeGreaterThan(GPU_FLOOR_PERCENT);
  });

  it("should only keep the most recent window of samples", () => {
    const avg = new GpuAverages();
    feed(avg, 1, new Array(GPU_WINDOW_SAMPLES).fill(100));
    feed(avg, 1, new Array(GPU_WINDOW_SAMPLES).fill(0));
    expect(avg.average(1)).toBe(0);
  });

  it("should decay a pid that stops being reported", () => {
    const avg = new GpuAverages();
    feed(avg, 1, new Array(GPU_WINDOW_SAMPLES).fill(50));
    for (let i = 0; i < GPU_WINDOW_SAMPLES; i++) avg.push([]); // pid absent from later lines
    expect(avg.average(1)).toBe(0);
  });

  it("should forget a pid on request so a long session cannot leak", () => {
    const avg = new GpuAverages();
    feed(avg, 1, [50]);
    avg.forget(1);
    expect(avg.trackedPids).not.toContain(1);
    expect(avg.average(1)).toBe(0);
  });
});

describe("SuffixIndex", () => {
  it("should match a qualified suffix against a full path", () => {
    const ix = new SuffixIndex([{ exe: "win64/ac2-win64-shipping.exe", name: "Assetto Corsa Competizione" }]);
    expect(ix.match("D:\\SteamLibrary\\steamapps\\common\\Assetto Corsa Competizione\\win64\\ac2-win64-shipping.exe"))
      .toBe("Assetto Corsa Competizione");
  });

  it("should not match a suffix that breaks mid-segment", () => {
    // "notgame.exe" must not satisfy an entry for "game.exe".
    const ix = new SuffixIndex([{ exe: "game.exe", name: "Game" }]);
    expect(ix.match("C:\\x\\notgame.exe")).toBeNull();
  });

  it("should prefer the longest matching suffix", () => {
    const ix = new SuffixIndex([
      { exe: "diablo iv.exe", name: "Wrong" },
      { exe: "diablo iv/diablo iv.exe", name: "Diablo IV" },
    ]);
    expect(ix.match(DIABLO_BNET)).toBe("Diablo IV");
  });

  it("should be case and separator insensitive", () => {
    const ix = new SuffixIndex([{ exe: "Diablo IV/Diablo IV.exe", name: "Diablo IV" }]);
    expect(ix.match("d:\\games\\diablo iv\\diablo iv.exe")).toBe("Diablo IV");
  });

  it("should return null for an unknown executable", () => {
    expect(new SuffixIndex([{ exe: "a/b.exe", name: "B" }]).match("C:\\x\\c.exe")).toBeNull();
  });
});
