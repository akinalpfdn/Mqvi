import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/auth", () => ({ reportCredentialStoreFailure: vi.fn() }));

import { queueCredentialFailure, flushCredentialFailures } from "./credentialFailureReport";
import { reportCredentialStoreFailure } from "../api/auth";
import type { CredentialStoreFailure } from "../types/electron";

const report = vi.mocked(reportCredentialStoreFailure);
const failure: CredentialStoreFailure = { reason: "decrypt_failed", detail: "x", platform: "windows", backend: "" };
const pending = () => JSON.parse(localStorage.getItem("mqvi_pending_credential_failures") ?? "[]") as unknown[];

beforeEach(() => {
  localStorage.clear();
  report.mockReset();
});

describe("credential failure reports", () => {
  it("should send a queued failure once signed in and forget it", async () => {
    report.mockResolvedValue({ success: true, httpStatus: 204 });
    queueCredentialFailure("load", failure);

    await flushCredentialFailures();

    expect(report).toHaveBeenCalledWith("load", failure);
    expect(pending()).toHaveLength(0);
  });

  it("should keep a failure the server could not take yet", async () => {
    report.mockResolvedValue({ success: false, error: "offline", httpStatus: 0 });
    queueCredentialFailure("save", failure);

    await flushCredentialFailures();

    expect(pending()).toHaveLength(1);
  });

  it("should drop a failure the server rejected", async () => {
    report.mockResolvedValue({ success: false, error: "bad", httpStatus: 400 });
    queueCredentialFailure("save", failure);

    await flushCredentialFailures();

    expect(pending()).toHaveLength(0);
  });

  it("should not grow without bound on a device that fails every launch", () => {
    for (let i = 0; i < 20; i++) queueCredentialFailure("load", failure);

    expect(pending()).toHaveLength(5);
  });
});
