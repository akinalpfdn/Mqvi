/**
 * The reproduction for the concurrent-ratchet bug.
 *
 * Signal sessions are load → mutate → save against IndexedDB, and a read hands back an independent
 * copy. The socket routes inbound events without awaiting, so two messages on one conversation
 * decrypt at the same time: both load the same state, both advance it, and whichever saves last
 * throws the other's advance away.
 *
 * These tests drive the real protocol code against a fake store that reproduces IndexedDB's copy
 * semantics. They are written to fail without the lock — see the phase file for the mutation runs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";

/**
 * Stand-in for IndexedDB. The two properties that matter are both load-bearing:
 * a read returns a *clone* (so concurrent callers cannot see each other's mutations), and every
 * call yields to the microtask queue (so they can actually interleave).
 */
const store = new Map<string, unknown>();

function clone<T>(value: T): T {
  return structuredClone(value);
}

vi.mock("./keyStorage", () => ({
  getSession: vi.fn(async (userId: string, deviceId: string) => {
    await Promise.resolve();
    const held = store.get(`session:${userId}:${deviceId}`);
    return held ? clone(held) : null;
  }),
  saveSession: vi.fn(async (session: { userId: string; deviceId: string }) => {
    await Promise.resolve();
    store.set(`session:${session.userId}:${session.deviceId}`, clone(session));
  }),
  getMetadata: vi.fn(async () => {
    await Promise.resolve();
    return null;
  }),
  setMetadata: vi.fn(async () => {
    await Promise.resolve();
  }),
  hasSession: vi.fn(async () => true),
  deleteSession: vi.fn(async () => {}),
  deleteAllSessionsForUser: vi.fn(async () => {}),
  getIdentityKeyPair: vi.fn(async () => null),
  getSignedPreKey: vi.fn(async () => null),
  getPreKey: vi.fn(async () => null),
  saveTrustedIdentity: vi.fn(async () => {}),
  getRegistrationData: vi.fn(async () => null),
}));

import { encryptMessage, decryptMessage } from "./signalProtocol";
import type { StoredSession, SessionState, SignalWireMessage } from "./types";

const PEER_USER = "peer-user";
const PEER_DEVICE = "peer-device";

function keyPair() {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

function baseState(over: Partial<SessionState>): SessionState {
  return {
    rootKey: new Uint8Array(32).fill(7),
    sendingChainKey: null,
    receivingChainKey: null,
    sendingRatchetKeyPair: keyPair(),
    receivingRatchetKey: null,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendChainLength: 0,
    skippedMessageKeys: [],
    ...over,
  };
}

function put(state: SessionState) {
  const session: StoredSession = {
    userId: PEER_USER,
    deviceId: PEER_DEVICE,
    state,
    createdAt: 0,
    updatedAt: 0,
  };
  store.set(`session:${PEER_USER}:${PEER_DEVICE}`, clone(session));
}

function held(): StoredSession {
  return clone(store.get(`session:${PEER_USER}:${PEER_DEVICE}`) as StoredSession);
}

beforeEach(() => {
  store.clear();
});

describe("concurrent encrypt on one session", () => {
  it("should give each message its own number and chain step", async () => {
    const chainKey = new Uint8Array(32).fill(3);
    put(baseState({ sendingChainKey: chainKey, sendingRatchetKeyPair: keyPair() }));

    const [first, second] = await Promise.all([
      encryptMessage(PEER_USER, PEER_DEVICE, "one"),
      encryptMessage(PEER_USER, PEER_DEVICE, "two"),
    ]);

    // Two messages claiming message number 0 are two messages encrypted with the same key. The
    // receiver ratchets once and can only ever read one of them.
    const numbers = [first.header.messageNumber, second.header.messageNumber].sort();
    expect(numbers).toEqual([0, 1]);
    expect(held().state.sendMessageNumber).toBe(2);
  });
});

describe("concurrent decrypt on one session", () => {
  /**
   * Builds a matched pair: a sending session, and a receiving session already pointed at its
   * ratchet key and chain. No DH step is involved, so the messages ride one chain — the simplest
   * shape in which the lost update is visible.
   */
  async function twoMessagesOnOneChain(): Promise<SignalWireMessage[]> {
    const chainKey = new Uint8Array(32).fill(11);
    const senderRatchet = keyPair();

    put(baseState({ sendingChainKey: chainKey, sendingRatchetKeyPair: senderRatchet }));
    const wire = [
      await encryptMessage(PEER_USER, PEER_DEVICE, "first"),
      await encryptMessage(PEER_USER, PEER_DEVICE, "second"),
    ];

    // Now stand the store up as the receiver of that same chain.
    put(
      baseState({
        receivingChainKey: chainKey,
        receivingRatchetKey: senderRatchet.publicKey,
        sendingRatchetKeyPair: keyPair(),
      })
    );
    return wire;
  }

  // Invariant, not a proof of the fix: this assertion also holds unserialized, because the second
  // decrypt works from a stale copy, re-derives the first message's key as a "skipped" one, and
  // arrives at the same counter. It is here so a future change cannot break it unnoticed.
  it("should decrypt both messages and end on the right counter", async () => {
    const [m0, m1] = await twoMessagesOnOneChain();

    const results = await Promise.all([
      decryptMessage(PEER_USER, PEER_DEVICE, m0),
      decryptMessage(PEER_USER, PEER_DEVICE, m1),
    ]);

    expect(results).toEqual(["first", "second"]);
    expect(held().state.receiveMessageNumber).toBe(2);
  });

  // This is the discriminator on the receive side. It is what the counter assertion above hides:
  // the second decrypt re-derived a key for a message the first had already consumed, and left it
  // behind as if it were still missing.
  it("should not leave a consumed message key sitting in the skipped list", async () => {
    const [m0, m1] = await twoMessagesOnOneChain();

    await Promise.all([
      decryptMessage(PEER_USER, PEER_DEVICE, m0),
      decryptMessage(PEER_USER, PEER_DEVICE, m1),
    ]);

    // In-order delivery skips nothing. An entry here is a message key that stays in storage long
    // after forward secrecy should have retired it, and a ratchet that disagrees with the sender
    // about what it has already read.
    expect(held().state.skippedMessageKeys).toHaveLength(0);
  });
});

describe("distinct sessions", () => {
  it("should not serialize behind each other", async () => {
    const order: string[] = [];
    const { withSessionLock, signalSessionKey } = await import("./sessionLock");

    await Promise.all([
      withSessionLock(signalSessionKey("u1", "d1"), async () => {
        order.push("a:enter");
        await Promise.resolve();
        order.push("a:exit");
      }),
      withSessionLock(signalSessionKey("u2", "d2"), async () => {
        order.push("b:enter");
        await Promise.resolve();
        order.push("b:exit");
      }),
    ]);

    expect(order).toEqual(["a:enter", "b:enter", "a:exit", "b:exit"]);
  });
});
