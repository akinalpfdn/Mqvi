/**
 * Microphone health: decides when a mic that should be sending is dead, why, and how that ended.
 *
 * A dead mic is invisible everywhere but here. The SFU sees a published track, the voice state says
 * unmuted, and the person simply cannot be heard. The causes all live on the client — the capture
 * track ends, the OS mutes it (screen lock, sleep), the SDK mutes it after a failed restart, the
 * processor's audio context is suspended — so the client reports them.
 *
 * Built for a log someone reads: a healthy session reports nothing. A fault has to persist for
 * OPEN_AFTER_MS before an episode opens, which skips device switches, restarts and the SDK's own
 * five-second pause window; an episode then produces exactly two reports — when it opens and when
 * it ends — each with the cause and the events that led to it.
 *
 * Pure and time-injected; the LiveKit wiring is in hooks/useMicHealthReport.
 */

export type MicFault =
  | "no_publication"
  | "track_ended"
  | "sdk_muted"
  | "upstream_paused"
  | "os_muted"
  | "track_disabled"
  | "audio_context_suspended"
  | "processed_track_ended";

/** "live": voice activity, unmuted. "ptt": push to talk, between presses. "off": muted by the user or the server. */
export type MicIntent = "live" | "ptt" | "off";

export type MicTrailEvent =
  | "reconnecting" | "signal_reconnecting" | "reconnected" | "disconnected"
  | "track_ended" | "track_restarted" | "sdk_muted" | "sdk_unmuted"
  | "os_muted" | "os_unmuted" | "upstream_paused" | "upstream_resumed"
  | "mic_published" | "mic_unpublished" | "device_error"
  | "device_change" | "ctx_suspended" | "ctx_running" | "ctx_interrupted" | "ctx_closed"
  | "page_hidden" | "page_visible" | "screen_locked" | "screen_unlocked"
  | "system_suspend" | "system_resume"
  | "user_muted" | "user_unmuted" | "ptt_down" | "ptt_up";

/** What the mic looks like right now. Read from LiveKit by the hook; plain data here. */
export type MicSnapshot = {
  /** The room is connected. While it reconnects the mic is in limbo by design and not judged. */
  connected: boolean;
  intent: MicIntent;
  hasPublication: boolean;
  /** The raw capture track's readyState is "ended". */
  trackEnded: boolean;
  /** The OS muted the raw capture track (MediaStreamTrack.muted). */
  osMuted: boolean;
  /** LiveKit's track is muted. */
  sdkMuted: boolean;
  /** LiveKit stopped sending upstream (it does after the OS mutes capture for 5 s). */
  upstreamPaused: boolean;
  /** The raw capture track is disabled. */
  trackDisabled: boolean;
  /** The processor's audio context state, or null when no processor is attached. */
  contextState: string | null;
  /** The processor's output track ended. */
  processedTrackEnded: boolean;
};

/**
 * The cause that keeps the mic from sending, or null when it is sending (or is not supposed to).
 * Ordered from the most to the least specific, so the reported cause is the deepest one.
 *
 * Push to talk is judged on capture faults only: between presses the track is muted on purpose,
 * and before the first press nothing is published.
 */
export function micFault(s: MicSnapshot): MicFault | null {
  if (!s.connected || s.intent === "off") return null;
  if (s.intent === "live") {
    if (!s.hasPublication) return "no_publication";
    if (s.trackEnded) return "track_ended";
    if (s.sdkMuted) return "sdk_muted";
    if (s.upstreamPaused) return "upstream_paused";
    if (s.osMuted) return "os_muted";
    if (s.trackDisabled) return "track_disabled";
  } else {
    if (!s.hasPublication) return null;
    if (s.trackEnded) return "track_ended";
    if (s.upstreamPaused) return "upstream_paused";
    if (s.osMuted) return "os_muted";
  }
  if (s.contextState !== null && s.contextState !== "running") return "audio_context_suspended";
  if (s.processedTrackEnded) return "processed_track_ended";
  return null;
}

export type MicReport = {
  event: "dead" | "recovered" | "left_voice";
  fault: MicFault;
  faults: MicFault[];
  intent: Exclude<MicIntent, "off">;
  durationMs: number;
  /** ms from the last completed reconnect to the start of the fault; -1 if none this session. */
  sinceReconnectMs: number;
  trail: { e: MicTrailEvent; ago_ms: number }[];
  detail?: string;
};

export const MIC_OPEN_AFTER_MS = 8_000;
export const MIC_MAX_EPISODES = 5;
const TRAIL_MAX = 24;
const TRAIL_WINDOW_MS = 10 * 60_000;
/** Events only worth keeping while something is already wrong; otherwise they would crowd the trail. */
const ONLY_DURING_FAULT: ReadonlySet<MicTrailEvent> = new Set(["ptt_down", "ptt_up"]);

type OpenEpisode = {
  fault: MicFault;
  faults: MicFault[];
  intent: Exclude<MicIntent, "off">;
  since: number;
  sinceReconnectMs: number;
};

export class MicHealthTracker {
  private streakSince: number | null = null;
  private streakFaults: MicFault[] = [];
  private open: OpenEpisode | null = null;
  private episodes = 0;
  private trail: { e: MicTrailEvent; at: number }[] = [];
  private lastReconnectedAt: number | null = null;
  private lastDeviceError: { message: string; at: number } | null = null;

  /** Records an event for the trail. */
  note(e: MicTrailEvent, now: number): void {
    if (ONLY_DURING_FAULT.has(e) && this.streakSince === null && this.open === null) return;
    if (e === "reconnected") this.lastReconnectedAt = now;
    this.trail.push({ e, at: now });
    this.trim(now);
  }

  /** A media device error from the SDK: kept as the report's detail. */
  noteDeviceError(message: string, now: number): void {
    this.lastDeviceError = { message, at: now };
    this.note("device_error", now);
  }

  /**
   * Judges the current snapshot. Returns a report to send when an episode opens or recovers, else
   * null. An open episode is not closed by the user muting or by a reconnect — only by the mic
   * working again while it is supposed to, or by leaving voice.
   */
  evaluate(s: MicSnapshot, now: number): MicReport | null {
    const fault = micFault(s);

    if (this.open) {
      if (fault !== null) {
        if (!this.open.faults.includes(fault)) this.open.faults.push(fault);
        return null;
      }
      if (!s.connected || s.intent === "off") return null;
      const report = this.report("recovered", this.open, now);
      this.open = null;
      this.resetStreak();
      return report;
    }

    if (fault === null) {
      this.resetStreak();
      return null;
    }
    if (this.streakSince === null) {
      this.streakSince = now;
      this.streakFaults = [];
    }
    if (!this.streakFaults.includes(fault)) this.streakFaults.push(fault);

    if (now - this.streakSince < MIC_OPEN_AFTER_MS || this.episodes >= MIC_MAX_EPISODES) return null;

    this.episodes++;
    this.open = {
      fault,
      faults: [...this.streakFaults],
      intent: s.intent === "ptt" ? "ptt" : "live",
      since: this.streakSince,
      sinceReconnectMs: this.lastReconnectedAt === null ? -1 : Math.max(0, this.streakSince - this.lastReconnectedAt),
    };
    return this.report("dead", this.open, now);
  }

  /** The user left voice. Closes an open episode as still dead. */
  leave(now: number): MicReport | null {
    if (!this.open) return null;
    const report = this.report("left_voice", this.open, now);
    this.open = null;
    this.resetStreak();
    return report;
  }

  private report(event: MicReport["event"], ep: OpenEpisode, now: number): MicReport {
    this.trim(now);
    const report: MicReport = {
      event,
      fault: ep.fault,
      faults: [...ep.faults],
      intent: ep.intent,
      durationMs: now - ep.since,
      sinceReconnectMs: ep.sinceReconnectMs,
      trail: this.trail.map((t) => ({ e: t.e, ago_ms: now - t.at })),
    };
    if (this.lastDeviceError && now - this.lastDeviceError.at <= TRAIL_WINDOW_MS) {
      report.detail = this.lastDeviceError.message;
    }
    return report;
  }

  private resetStreak(): void {
    this.streakSince = null;
    this.streakFaults = [];
  }

  private trim(now: number): void {
    this.trail = this.trail.filter((t) => now - t.at <= TRAIL_WINDOW_MS).slice(-TRAIL_MAX);
  }
}
