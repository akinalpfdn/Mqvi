/**
 * gameDetect.ts — decides which running process is a game worth offering to share.
 *
 * game-probe.exe is the sensor: it reports who is driving the GPU's 3D engine and what window they
 * own. The policy lives here, in layers, because no single signal answers it:
 *
 *   1. denylist      — GPU-heavy desktop apps that are not games (OBS, Blender, browsers, us)
 *   2. local library — Steam/Epic/GOG describe their installs on disk: exact, current, and named
 *   3. games list    — path-suffix map for what no library we parse covers (Battle.net, standalone)
 *   4. gpu floor     — the unlisted tail: new, indie, portable, emulated
 *
 * Layers 2 and 3 identify a game and never consult the GPU. That matters more than it sounds:
 * measured on Diablo IV, a real game swings 1%-45% and drops to 0.5% — below the desktop's own noise
 * peak — and collapses entirely once it goes to the background, which is exactly its state while the
 * user is looking at mqvi to press the button.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, readdir } from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

/** One line from game-probe.exe's JSON. */
export interface ProbeCandidate {
  pid: number;
  gpu3d: number;
  videoDecode: number;
  videoEncode: number;
  hwnd: number;
  area: number;
  title: string;
  exePath: string;
}

export interface DetectedGame {
  name: string;
  pid: number;
  hwnd: number;
  /** desktopCapturer-shaped id, so the existing share path takes it unchanged. */
  sourceId: string;
  /** Which layer named it — for logs and for tests that must prove a layer fired. */
  via: "library" | "list" | "gpu";
  /** The launcher's own icon for this game, when it cached one. Main-process only: it is resolved
   *  to a data URL before anything reaches the renderer. */
  iconFile?: string;
}

/**
 * GPU-heavy desktop apps, checked before every layer — including the libraries.
 *
 * Being in a Steam library does not make something a game: Steam sells Wallpaper Engine (which runs
 * all day and would otherwise be offered whenever nothing else was), Blender, Aseprite and SteamVR.
 * Since layers 2/3 deliberately ignore the GPU, nothing else would stop them.
 *
 * Discord's own non-games list was checked and is no use here: 5 entries (Chrome, Opera GX, Comet,
 * their quest helper, GearUP), because it exists for presence, not for GPU false positives.
 */
const DENYLIST = new Set([
  // compositors / shell
  "dwm.exe", "explorer.exe", "applicationframehost.exe", "shellexperiencehost.exe",
  "searchhost.exe", "startmenuexperiencehost.exe", "textinputhost.exe",
  // browsers
  "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "brave.exe", "vivaldi.exe", "comet.exe",
  // capture / streaming / remote
  "obs64.exe", "obs32.exe", "streamlabs obs.exe", "xsplit.core.exe",
  "remoting_desktop.exe", "remoting_host.exe", "anydesk.exe", "teamviewer.exe",
  "parsecd.exe", "sunshine.exe", "moonlight.exe", "nvidia share.exe", "nvidia overlay.exe",
  // creative / 3D / video — the real false positives
  "blender.exe", "unrealeditor.exe", "ue4editor.exe", "unity.exe", "unityhub.exe",
  "resolve.exe", "adobe premiere pro.exe", "afterfx.exe", "photoshop.exe", "illustrator.exe",
  "lightroom.exe", "maya.exe", "3dsmax.exe", "houdini.exe", "cinema 4d.exe", "sldworks.exe",
  "acad.exe", "substance painter.exe", "davinci resolve.exe",
  // conferencing
  "zoom.exe", "ms-teams.exe", "teams.exe", "discord.exe", "slack.exe", "webex.exe",
  // dev / editors
  "code.exe", "devenv.exe", "rider64.exe", "idea64.exe", "clion64.exe",
  // benchmarks are games-shaped but nobody streams them by accident
  "3dmark.exe", "furmark.exe",
  // sold on Steam, so a library hit is not enough to call them games
  "wallpaper32.exe", "wallpaper64.exe", "vrmonitor.exe", "vrserver.exe", "aseprite.exe",
  // ourselves — mqvi renders through the GPU, and the helper burns the video engine
  "mqvi.exe", "electron.exe", "mqvi-game-capture.exe", "game-probe.exe", "audio-capture.exe",
]);

/** Average 3D use, over a window, for the unlisted tail. Measured: a real game averages ~15% while
 *  the desktop's noisiest process peaks at 1.7%. 3% is ~2x that ceiling — generous on purpose,
 *  because a wrong suggestion costs a glance and a missed game costs the feature. */
export const GPU_FLOOR_PERCENT = 3;

/** Samples kept per pid. An instantaneous reading is worthless — see the module comment. */
export const GPU_WINDOW_SAMPLES = 7;

interface InstalledGame {
  name: string;
  /** Lower-cased install directory. Any exe under it belongs to this game. */
  dir: string;
  /**
   * The game's own icon on disk, when the launcher cached one.
   *
   * Worth the trouble because an executable's icon often is not the game's: Diablo IV.exe carries
   * none, so Windows hands back its generic application icon — measured identical, byte for byte,
   * for both the Steam and Battle.net copies.
   */
  iconFile?: string;
}

function normalise(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

/** A registry value, without a native module — CI has no Visual Studio, so N-API addons are out. */
async function regQuery(key: string, value: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", key, "/v", value]);
    const m = stdout.match(/REG_[A-Z_]+\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null; // key absent = that launcher isn't installed
  }
}

/**
 * Steam's cached icon for an app: `appcache/librarycache/<appid>/<sha1>.jpg`.
 *
 * The sha1 comes from Steam's own app info, which lives in a binary VDF we do not parse — but the
 * hash-named jpg is the only one at the top of that folder (the rest are capsules, heroes and logos,
 * flat in older entries and in subfolders in newer ones), so the name pattern is enough to find it.
 */
async function steamIcon(steamPath: string, appid: string): Promise<string | undefined> {
  const dir = path.join(steamPath, "appcache", "librarycache", appid);
  try {
    const files = await readdir(dir);
    const icon = files.find((f) => /^[0-9a-f]{40}\.jpg$/i.test(f));
    return icon ? path.join(dir, icon) : undefined;
  } catch {
    return undefined; // no art cached for this app
  }
}

/**
 * Steam, discovered the way Steam itself does it: the registry names the install, and
 * libraryfolders.vdf names every library. Guessing drive letters misses the D: library that most
 * people with two disks actually keep their games on.
 */
async function readSteam(): Promise<InstalledGame[]> {
  const steamPath = await regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath");
  if (!steamPath) return [];

  const libraries: string[] = [];
  try {
    const vdf = await readFile(path.join(steamPath, "steamapps", "libraryfolders.vdf"), "utf8");
    for (const m of vdf.matchAll(/"path"\s+"(.+?)"/g)) {
      libraries.push(m[1].replace(/\\\\/g, "\\"));
    }
  } catch {
    libraries.push(steamPath); // no vdf: single-library install
  }

  const games: InstalledGame[] = [];
  for (const lib of libraries) {
    const apps = path.join(lib, "steamapps");
    let entries: string[];
    try {
      entries = await readdir(apps);
    } catch {
      continue; // library on a disconnected drive
    }

    for (const file of entries) {
      if (!file.startsWith("appmanifest_") || !file.endsWith(".acf")) continue;
      try {
        const acf = await readFile(path.join(apps, file), "utf8");
        // Anchored to AppState's own indent: nested sections carry their own keys.
        const name = acf.match(/^\t"name"\s+"(.+?)"$/m)?.[1];
        const installdir = acf.match(/^\t"installdir"\s+"(.+?)"$/m)?.[1];
        const appid = acf.match(/^\t"appid"\s+"(\d+)"$/m)?.[1];
        if (!name || !installdir) continue;
        games.push({
          name,
          dir: normalise(path.join(apps, "common", installdir)),
          iconFile: appid ? await steamIcon(steamPath, appid) : undefined,
        });
      } catch {
        // A manifest mid-write during an update — skip it, next poll picks it up.
      }
    }
  }
  return games;
}

/** Epic writes one JSON manifest per install, and names the launch exe outright. */
async function readEpic(): Promise<InstalledGame[]> {
  const dir = path.join(
    process.env["PROGRAMDATA"] ?? "C:\\ProgramData",
    "Epic",
    "EpicGamesLauncher",
    "Data",
    "Manifests"
  );

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const games: InstalledGame[] = [];
  for (const file of entries) {
    if (!file.endsWith(".item")) continue;
    try {
      const raw = await readFile(path.join(dir, file), "utf8");
      const m = JSON.parse(raw) as { DisplayName?: string; InstallLocation?: string };
      if (m.DisplayName && m.InstallLocation) {
        games.push({ name: m.DisplayName, dir: normalise(m.InstallLocation) });
      }
    } catch {
      // Malformed manifest — not our problem to repair.
    }
  }
  return games;
}

/** GOG keeps a registry key per game, with both the path and a display name. */
async function readGog(): Promise<InstalledGame[]> {
  const root = "HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("reg.exe", ["query", root, "/s"]));
  } catch {
    return [];
  }

  const games: InstalledGame[] = [];
  // Each game's block carries both values; pair them per block rather than by position.
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const name = block.match(/gameName\s+REG_SZ\s+(.+)/)?.[1]?.trim();
    const dir = block.match(/\n\s+path\s+REG_SZ\s+(.+)/)?.[1]?.trim();
    if (name && dir) games.push({ name, dir: normalise(dir) });
  }
  return games;
}

/**
 * Every game the launchers on this machine admit to. Cheap enough to redo when a voice session
 * starts; a game installed mid-session is the next session's problem.
 */
export async function readInstalledGames(): Promise<InstalledGame[]> {
  const [steam, epic, gog] = await Promise.all([readSteam(), readEpic(), readGog()]);
  return [...steam, ...epic, ...gog];
}

/**
 * Layer 2. A launcher never matches its own games: steam.exe lives in the Steam root, never under
 * steamapps\common, and Battle.net sits in Program Files while its games do not.
 */
function matchLibrary(exePath: string, installed: InstalledGame[]): InstalledGame | null {
  const p = normalise(exePath);
  let best: InstalledGame | null = null;
  for (const g of installed) {
    if (!p.startsWith(g.dir + "\\")) continue;
    // Longest install dir wins: a library root can nest inside another.
    if (!best || g.dir.length > best.dir.length) best = g;
  }
  return best;
}

/**
 * Layer 3. Entries are path suffixes, not bare exe names — Discord qualifies an ambiguous
 * "ac2-win64-shipping.exe" as "win64/ac2-win64-shipping.exe". Indexed by basename so 23k entries
 * cost one lookup, not a scan.
 */
export class SuffixIndex {
  private byBasename = new Map<string, Array<{ suffix: string; name: string }>>();

  constructor(entries: Array<{ exe: string; name: string }>) {
    for (const e of entries) {
      const suffix = e.exe.replace(/\\/g, "/").toLowerCase();
      const base = suffix.slice(suffix.lastIndexOf("/") + 1);
      if (!base) continue;
      const bucket = this.byBasename.get(base);
      if (bucket) bucket.push({ suffix, name: e.name });
      else this.byBasename.set(base, [{ suffix, name: e.name }]);
    }
  }

  get size(): number {
    return this.byBasename.size;
  }

  match(exePath: string): string | null {
    const p = exePath.replace(/\\/g, "/").toLowerCase();
    const base = p.slice(p.lastIndexOf("/") + 1);
    const bucket = this.byBasename.get(base);
    if (!bucket) return null;

    // Longest matching suffix wins — "diablo iv/diablo iv.exe" beats a bare "diablo iv.exe".
    let best: { suffix: string; name: string } | null = null;
    for (const c of bucket) {
      if (!p.endsWith(c.suffix)) continue;
      // Must break on a path boundary, or "notgame/game.exe" would match "game.exe".
      const at = p.length - c.suffix.length;
      if (at > 0 && p[at - 1] !== "/") continue;
      if (!best || c.suffix.length > best.suffix.length) best = c;
    }
    return best?.name ?? null;
  }
}

/**
 * Committed at native/games-list.json and shipped via extraResources, so it is normally there.
 * Absent is still a supported state rather than a failure — a source build that skipped it, or a
 * pruned install — and costs only layer 3: a Battle.net game is then found by the GPU and named from
 * its window title instead.
 */
export async function loadGamesList(file: string): Promise<SuffixIndex | null> {
  try {
    const raw = await readFile(file, "utf8");
    const rows = JSON.parse(raw) as Array<{ exe: string; name: string }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return new SuffixIndex(rows);
  } catch {
    return null;
  }
}

/**
 * Identifies an admitted process. Not the pid alone: Windows recycles pids, so over a long voice
 * session a fresh process could inherit a dead game's admission and skip the floor entirely.
 */
export function admitKey(c: Pick<ProbeCandidate, "pid" | "exePath">): string {
  return `${c.pid}|${c.exePath.toLowerCase()}`;
}

export interface ClassifyDeps {
  installed: InstalledGame[];
  list: SuffixIndex | null;
  /** Rolling average of 3D use per pid, kept by the caller across samples. */
  averageGpu: (pid: number) => number;
  /** Processes already admitted as games, by admitKey. GPU is an entry condition, never a
   *  retention one — a game reads ~0.5% the moment it is backgrounded. */
  admitted: Set<string>;
}

/**
 * The layers, in order. Returns the game to offer, or null.
 *
 * Only one candidate is ever offered: the strongest. Two games at once is a real state (a launcher's
 * demo, a second monitor) but the row has room for one, and the picker still exists for the rest.
 */
export function classify(candidates: ProbeCandidate[], deps: ClassifyDeps): DetectedGame | null {
  const eligible = candidates
    .filter((c) => {
      // No window, nothing to capture — this is also what drops services, miners and ML jobs, which
      // report under engtype_3D on NVIDIA because these GPUs expose no separate Compute engine.
      if (!c.hwnd || c.area <= 0) return false;
      // No path, no identity. Every layer below rests on knowing what this process is — the denylist
      // most of all — so a process we cannot name is not one we may call a game. This is the
      // elevated case: run OBS as administrator while mqvi is not, and its path is unreadable;
      // admitting it on GPU load alone would put "OBS 30.0.0" in the row.
      if (!c.exePath) return false;
      // Before any layer, including the libraries: Steam sells Wallpaper Engine and Blender.
      return !DENYLIST.has(path.basename(c.exePath).toLowerCase());
    })
    .sort((a, b) => b.gpu3d - a.gpu3d);

  // The layers are the outer loop, not the inner one. Ranking candidates first and asking each one
  // "library? list? gpu?" would let any unlisted app burning 40% 3D answer via layer 4 before a real
  // game sitting at 6% behind it is ever examined — and 6% is exactly what a game reads once it is
  // backgrounded, which is its state while the user is looking at this row.
  const sourceId = (c: ProbeCandidate) => `window:${c.hwnd}:0`;

  for (const c of eligible) {
    const g = matchLibrary(c.exePath, deps.installed);
    if (!g) continue;
    deps.admitted.add(admitKey(c));
    return {
      name: g.name,
      pid: c.pid,
      hwnd: c.hwnd,
      sourceId: sourceId(c),
      via: "library",
      iconFile: g.iconFile,
    };
  }

  for (const c of eligible) {
    const name = deps.list?.match(c.exePath);
    if (!name) continue;
    deps.admitted.add(admitKey(c));
    return { name, pid: c.pid, hwnd: c.hwnd, sourceId: sourceId(c), via: "list" };
  }

  // Layer 4: no list knows it. New, indie, portable, emulated.
  for (const c of eligible) {
    if (!c.title) continue; // nothing to call it
    if (!deps.admitted.has(admitKey(c)) && deps.averageGpu(c.pid) < GPU_FLOOR_PERCENT) continue;
    deps.admitted.add(admitKey(c));
    return { name: c.title, pid: c.pid, hwnd: c.hwnd, sourceId: sourceId(c), via: "gpu" };
  }

  return null;
}

/**
 * Rolling average of 3D use per pid.
 *
 * A single reading cannot be trusted: measured over 30s of Diablo IV, the game swung between 0.5%
 * and 44.7% while the desktop's noisiest process peaked at 1.7% — so at some instants the desktop
 * outranks the game. Averages separate them cleanly (14.9% vs 0.9%).
 */
export class GpuAverages {
  private samples = new Map<number, number[]>();

  /** One probe line. Pids absent from it get a zero, so a quiet process decays out of its window. */
  push(candidates: ProbeCandidate[]): void {
    const seen = new Set<number>();
    for (const c of candidates) {
      seen.add(c.pid);
      this.record(c.pid, c.gpu3d);
    }
    for (const pid of this.samples.keys()) {
      if (!seen.has(pid)) this.record(pid, 0);
    }
  }

  private record(pid: number, value: number): void {
    const window = this.samples.get(pid) ?? [];
    window.push(value);
    if (window.length > GPU_WINDOW_SAMPLES) window.shift();
    this.samples.set(pid, window);
  }

  average(pid: number): number {
    const window = this.samples.get(pid);
    if (!window || window.length === 0) return 0;
    return window.reduce((a, b) => a + b, 0) / window.length;
  }

  /** Called when a pid is gone, so a long session's map cannot grow without bound. */
  forget(pid: number): void {
    this.samples.delete(pid);
  }

  /** Drop everything. Averages must not survive a session: pids get recycled, and a new process
   *  inheriting a dead one's full window would clear the floor without ever earning it. */
  clear(): void {
    this.samples.clear();
  }

  get trackedPids(): number[] {
    return [...this.samples.keys()];
  }
}
