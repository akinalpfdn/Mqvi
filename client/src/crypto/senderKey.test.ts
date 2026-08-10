/**
 * Sender-key round-trip: channel encryption, where one sender's key is distributed to many members
 * and every message rides the same chain.
 *
 * The property that separates this from the pairwise protocol is who can read what. A member is
 * handed the chain key as it stands when they join, so everything sent before that must stay
 * unreadable to them — a bug there is not a broken feature, it is a member reading a channel's
 * history they were never in. It also fails in the quiet direction: they simply see plaintext that
 * looks like it was always theirs to see.
 *
 * Runs the real protocol against per-device in-memory storage, the way signalRoundTrip does.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Device = {
  senderKeys: Map<string, unknown>;
  metadata: Map<string, unknown>;
};

let current: Device;

function clone<T>(v: T): T {
  return structuredClone(v);
}

function newDevice(): Device {
  return { senderKeys: new Map(), metadata: new Map() };
}

function senderKeyId(channelId: string, userId: string, deviceId: string): string {
  return `${channelId}:${userId}:${deviceId}`;
}

vi.mock("./keyStorage", () => ({
  getSenderKey: vi.fn(async (c: string, u: string, d: string) => {
    const held = current.senderKeys.get(senderKeyId(c, u, d));
    return held ? clone(held) : null;
  }),
  saveSenderKey: vi.fn(async (sk: { channelId: string; senderUserId: string; senderDeviceId: string }) => {
    current.senderKeys.set(senderKeyId(sk.channelId, sk.senderUserId, sk.senderDeviceId), clone(sk));
  }),
  deleteAllSenderKeysForChannel: vi.fn(async (channelId: string) => {
    for (const key of [...current.senderKeys.keys()]) {
      if (key.startsWith(`${channelId}:`)) current.senderKeys.delete(key);
    }
  }),
  getMetadata: vi.fn(async (k: string) => current.metadata.get(k) ?? null),
  setMetadata: vi.fn(async (k: string, v: unknown) => { current.metadata.set(k, v); }),
}));

const {
  createDistribution,
  processDistribution,
  encryptGroupMessage,
  decryptGroupMessage,
  clearChannelSenderKeys,
} = await import("./senderKeyProtocol");

const CHANNEL = "channel-1";
const SENDER = { userId: "sender", deviceId: "sender-1" };

async function as<T>(d: Device, fn: () => Promise<T>): Promise<T> {
  current = d;
  return fn();
}

let sender: Device;
let member: Device;
let latecomer: Device;

beforeEach(() => {
  sender = newDevice();
  member = newDevice();
  latecomer = newDevice();
});

/** Hand a member the sender's current distribution and let them install it. */
async function distributeTo(recipient: Device, distribution: unknown): Promise<void> {
  await as(recipient, () =>
    processDistribution(CHANNEL, SENDER.userId, SENDER.deviceId, distribution as never)
  );
}

describe("sender key", () => {
  it("should deliver a channel message to a member who has the distribution", async () => {
    const distribution = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    await distributeTo(member, distribution);

    const wire = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "hello channel")
    );

    const got = await as(member, () =>
      decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, wire)
    );
    expect(got).toBe("hello channel");
  });

  it("should deliver a run of messages on the same chain", async () => {
    const distribution = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    await distributeTo(member, distribution);

    for (let i = 0; i < 5; i++) {
      const wire = await as(sender, () =>
        encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, `m${i}`)
      );
      const got = await as(member, () =>
        decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, wire)
      );
      expect(got).toBe(`m${i}`);
    }
  });

  it("should reach two members independently from one distribution", async () => {
    const distribution = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    await distributeTo(member, distribution);
    await distributeTo(latecomer, distribution);

    const wire = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "for both of you")
    );

    // Each member advances their own copy of the chain; one reading must not consume the other's.
    expect(
      await as(member, () => decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, wire))
    ).toBe("for both of you");
    expect(
      await as(latecomer, () => decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, wire))
    ).toBe("for both of you");
  });

  // Within one distribution there is deliberately NO forward secrecy: the recipient keeps the
  // iteration-0 key and rewinds to it, which is what lets scrollback decrypt after a reload. It is
  // documented on StoredSenderKey.initialChainKey and mitigated by rotation, not an oversight —
  // pinned here so that "hardening" it by dropping initialChainKey shows up as a failing test
  // rather than as users losing their channel history.
  it("should still open an older message from the same distribution", async () => {
    const distribution = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    await distributeTo(member, distribution);

    const older = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "older")
    );
    const newer = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "newer")
    );

    // Read the newer one first, advancing the stored chain past the older one.
    expect(
      await as(member, () => decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, newer))
    ).toBe("newer");
    expect(
      await as(member, () => decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, older))
    ).toBe("older");
  });

  // What cuts a newcomer off is the re-key, not the ratchet: createDistribution mints a fresh chain
  // key, a fresh distribution id AND a fresh ed25519 signing key, so a message from the previous
  // distribution has nothing in common with what they hold.
  //
  // Deliberately a property test, not a mechanism test — and it cannot be otherwise. Pinning all
  // three was tried: fixing the chain key, then the distribution id, then both, left this green,
  // because the signature check alone still rejects the old message. Any one of the three suffices,
  // so this catches "a newcomer can read history" but will not catch the loss of a single guard.
  it("should not let a member read anything sent before the distribution they were given", async () => {
    const first = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    await distributeTo(member, first);

    const beforeTheyJoined = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "private history")
    );
    expect(
      await as(member, () =>
        decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, beforeTheyJoined)
      )
    ).toBe("private history");

    // A new member joins now and is handed the chain as it currently stands.
    const rekeyed = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    await distributeTo(latecomer, rekeyed);

    // The message sent before they arrived must not open for them.
    await expect(
      as(latecomer, () =>
        decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, beforeTheyJoined)
      )
    ).rejects.toThrow();
  });

  it("should refuse a message with no distribution installed", async () => {
    const distribution = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    // member never processes it.
    void distribution;

    const wire = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "unreadable")
    );

    await expect(
      as(member, () => decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, wire))
    ).rejects.toThrow();
  });

  it("should refuse a message whose ciphertext was altered", async () => {
    const distribution = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    await distributeTo(member, distribution);

    const wire = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "genuine")
    );
    const bytes = Uint8Array.from(atob(wire.ciphertext), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = { ...wire, ciphertext: btoa(String.fromCharCode(...bytes)) };

    await expect(
      as(member, () => decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, tampered))
    ).rejects.toThrow();
  });

  it("should produce a different ciphertext for the same plaintext twice", async () => {
    const distribution = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    await distributeTo(member, distribution);

    const a = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "same words")
    );
    const b = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "same words")
    );

    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("should stop decrypting once the channel's keys are cleared", async () => {
    const distribution = await as(sender, () =>
      createDistribution(CHANNEL, SENDER.userId, SENDER.deviceId)
    );
    await distributeTo(member, distribution);

    const wire = await as(sender, () =>
      encryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, "before the purge")
    );

    // What leaving a channel does. Anything still in flight must stop opening.
    await as(member, () => clearChannelSenderKeys(CHANNEL));

    await expect(
      as(member, () => decryptGroupMessage(CHANNEL, SENDER.userId, SENDER.deviceId, wire))
    ).rejects.toThrow();
  });
});
