/**
 * The bounded reconnect both engines run. The offerer restarts ICE, the answerer asks it to;
 * every attempt refreshes TURN credentials, and the call ends after the cap.
 */

import { fetchIceServersForRecovery } from "../api/calls";

export const MAX_ICE_RESTARTS = 2;
export const ICE_RESTART_ATTEMPT_MS = 7_000;
/** A "disconnected" state is often a blip; give it a window before treating it as failure. */
export const DISCONNECT_GRACE_MS = 5_000;
/** Longer while a negotiation is in flight — the state machine has further to travel. */
export const DISCONNECT_GRACE_NEGOTIATING_MS = 10_000;
/** A call that never connects ends after this; it leaves room for the peer's permission prompt. */
export const FIRST_CONNECT_TIMEOUT_MS = 60_000;

export type RecoveryConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed"
  | "unknown";

export type RecoveryHost = {
  /** The offerer restarts ICE itself; the answerer asks the peer to. */
  isCaller(): boolean;
  /** False once the engine is closed or its connection has been replaced. */
  isAlive(): boolean;
  isConnected(): boolean;
  /** How long a "disconnected" may last before it counts as failure. */
  gracePeriodMs(): number;
  applyIceServers(servers: RTCIceServer[]): void | Promise<void>;
  /** Offerer side: regenerate the offer with fresh ICE. */
  restartIce(): void;
  /** Answerer side: ask the offerer to do it. */
  requestRestart(): void;
  /** Recovery is exhausted. */
  onGiveUp(): void;
};

export class IceRecovery {
  private readonly host: RecoveryHost;

  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering = false;
  private attempts = 0;
  /** The current run; a step from an older run, woken by an await, stands down. */
  private run = 0;
  private everConnected = false;
  private firstConnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: RecoveryHost) {
    this.host = host;
  }

  /** Feed every connection-state change here. */
  handleState(state: RecoveryConnectionState): void {
    if (!this.host.isAlive()) return;
    switch (state) {
      case "connected":
        this.everConnected = true;
        this.clearFirstConnect();
        this.clearGrace();
        this.stop();
        return;
      case "connecting":
        this.clearGrace();
        return;
      case "failed":
        this.clearGrace();
        this.start();
        return;
      case "closed":
        this.giveUp();
        return;
      case "disconnected": {
        if (this.disconnectedTimer) return;
        const timeout = this.host.gracePeriodMs();
        console.warn("[p2p] connection disconnected, waiting for recovery...", { timeout });
        this.disconnectedTimer = setTimeout(() => {
          this.disconnectedTimer = null;
          if (!this.host.isAlive() || this.host.isConnected()) return;
          this.start();
        }, timeout);
        return;
      }
      default:
        return;
    }
  }

  /** Also the entry point for a restart the peer asked for. Idempotent while running. */
  start(): void {
    if (!this.host.isAlive() || this.recovering) return;
    this.recovering = true;
    this.attempts = 0;
    void this.step(++this.run);
  }

  /**
   * Arm once the local side is ready. Recovery only reacts to a connection that dropped; one that
   * never came up (a rejected offer, ICE that never completes) otherwise sat silent forever.
   */
  armFirstConnect(): void {
    if (this.everConnected || this.firstConnectTimer) return;
    this.firstConnectTimer = setTimeout(() => {
      this.firstConnectTimer = null;
      if (this.everConnected || !this.host.isAlive()) return;
      console.warn("[p2p] call never connected, ending it");
      this.giveUp();
    }, FIRST_CONNECT_TIMEOUT_MS);
  }

  stop(): void {
    this.run++;
    this.recovering = false;
    this.attempts = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  dispose(): void {
    this.clearFirstConnect();
    this.clearGrace();
    this.stop();
  }

  // ─── internals ───

  private clearFirstConnect(): void {
    if (this.firstConnectTimer) {
      clearTimeout(this.firstConnectTimer);
      this.firstConnectTimer = null;
    }
  }

  private clearGrace(): void {
    if (this.disconnectedTimer) {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }
  }

  private giveUp(): void {
    this.clearGrace();
    this.stop();
    this.host.onGiveUp();
  }

  private async step(run: number): Promise<void> {
    if (run !== this.run) return;
    if (!this.host.isAlive() || this.host.isConnected()) {
      this.stop();
      return;
    }
    if (this.attempts >= MAX_ICE_RESTARTS) {
      console.warn("[p2p] ICE restart cap reached, ending call");
      this.giveUp();
      return;
    }
    this.attempts++;
    const role = this.host.isCaller() ? "caller" : "receiver";
    console.warn(`[p2p] ICE restart attempt ${this.attempts}/${MAX_ICE_RESTARTS} (${role})`);

    // On fetch failure keep the current (TURN) configuration rather than downgrade to STUN
    // exactly when a relayed reconnect is needed.
    const servers = await fetchIceServersForRecovery();
    if (run !== this.run) return; // stopped, or replaced by a newer run, while fetching
    if (!this.host.isAlive()) {
      this.stop();
      return;
    }
    if (servers) await this.host.applyIceServers(servers);

    // Re-check after the awaits: the call may have ended or recovered on its own.
    if (run !== this.run) return;
    if (!this.host.isAlive() || this.host.isConnected()) {
      this.stop();
      return;
    }

    if (this.host.isCaller()) this.host.restartIce();
    else this.host.requestRestart();

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.step(run);
    }, ICE_RESTART_ATTEMPT_MS);
  }
}
