import { describe, expect, it } from "vitest";
import type { Host } from "@zterm/shared";
import {
  buildReconnectHostFallback,
  enumerateHostCandidates,
  pickNextReconnectCandidate,
} from "./reconnect-host-fallback";

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: "host-1",
    createdAt: 1,
    name: "demo",
    bridgeHost: "192.168.1.10",
    bridgePort: 3333,
    sessionName: "demo",
    authType: "password",
    tags: [],
    pinned: false,
    ...overrides,
  };
}

describe("enumerateHostCandidates", () => {
  it("returns the primary bridge host when no extras are present", () => {
    const candidates = enumerateHostCandidates(makeHost());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      bridgeHost: "192.168.1.10",
      bridgePort: 3333,
      label: "bridge",
      isRelay: false,
    });
  });

  it("lists tailscale and ip endpoints after the primary host", () => {
    const host = makeHost({
      tailscaleHost: "host.tail.ts.net",
      ipv6Host: "fe80::1",
      ipv4Host: "10.0.0.1",
    });
    const labels = enumerateHostCandidates(host).map((c) => c.label);
    expect(labels).toEqual(["bridge", "tailscale", "ipv4", "ipv6"]);
  });

  it("deduplicates overlapping host:port candidates", () => {
    const host = makeHost({
      bridgeHost: "192.168.1.10",
      tailscaleHost: "192.168.1.10",
      ipv4Host: "192.168.1.10",
    });
    const candidates = enumerateHostCandidates(host);
    expect(candidates).toHaveLength(1);
  });

  it("appends relay candidates after the LAN ones", () => {
    const host = makeHost({
      relayEndpointCandidates: [
        { kind: "relay", host: "relay.example.com", port: 443 },
        { kind: "relay", host: "relay2.example.com", port: 443 },
      ],
    });
    const candidates = enumerateHostCandidates(host);
    expect(candidates.map((c) => c.label)).toEqual([
      "bridge",
      "relay:relay",
      "relay:relay",
    ]);
  });
});

describe("buildReconnectHostFallback", () => {
  it("identifies the current candidate index for the cached host", () => {
    const host = makeHost({
      bridgeHost: "192.168.1.10",
      tailscaleHost: "host.tail.ts.net",
      ipv4Host: "10.0.0.1",
    });
    const fallback = buildReconnectHostFallback(host);
    expect(fallback.currentIndex).toBe(0);
    expect(fallback.candidates[fallback.currentIndex]?.bridgeHost).toBe(
      "192.168.1.10",
    );
  });

  it("returns the fallback at index 0 when the cached bridge host is unknown", () => {
    const host = makeHost({
      bridgeHost: "100.100.100.100",
      tailscaleHost: "host.tail.ts.net",
    });
    const fallback = buildReconnectHostFallback(host);
    expect(fallback.currentIndex).toBe(0);
  });
});

describe("pickNextReconnectCandidate", () => {
  it("returns the highest-priority candidate", () => {
    const host = makeHost({
      bridgeHost: "192.168.1.10",
      tailscaleHost: "host.tail.ts.net",
    });
    const next = pickNextReconnectCandidate(host);
    expect(next?.bridgeHost).toBe("192.168.1.10");
  });

  it("returns null when no candidates exist", () => {
    const host = makeHost({ bridgeHost: "   " });
    expect(pickNextReconnectCandidate(host)).toBeNull();
  });
});
