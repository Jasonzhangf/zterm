package com.zterm.android;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Objects;

/**
 * Typed description of a single mux target the AndroidConnectionService may
 * bind to. Mirrors {@code AndroidConnectionServiceTarget} in
 * {@code src/lib/android-connection-service-commands.ts}.
 *
 * Field provenance:
 *   targetKey     — stable route / daemon key (chosen by upper-layer).
 *   bridgeHost    — IPv4 / IPv6 / hostname of the mux bridge.
 *   bridgePort    — TCP port of the mux bridge.
 *   authToken     — opaque auth payload, treated as a string only.
 *   daemonHostId  — optional canonical daemon id (no PII).
 *   relayHostId   — optional Relay account identity.
 *   tailscaleHost — optional Tailscale-specific endpoint host.
 *   ipv6Host      — optional IPv6 endpoint host.
 *   ipv4Host      — optional IPv4 endpoint host.
 *   signalUrl     — optional WebRTC signal URL.
 */
public final class AndroidConnectionServiceTarget {
    public final String targetKey;
    public final String bridgeHost;
    public final int bridgePort;
    public final String authToken;
    public final String daemonHostId;
    public final String relayHostId;
    public final String tailscaleHost;
    public final String ipv6Host;
    public final String ipv4Host;
    public final String signalUrl;

    private AndroidConnectionServiceTarget(Builder b) {
        this.targetKey = b.targetKey;
        this.bridgeHost = b.bridgeHost;
        this.bridgePort = b.bridgePort;
        this.authToken = b.authToken;
        this.daemonHostId = b.daemonHostId;
        this.relayHostId = b.relayHostId;
        this.tailscaleHost = b.tailscaleHost;
        this.ipv6Host = b.ipv6Host;
        this.ipv4Host = b.ipv4Host;
        this.signalUrl = b.signalUrl;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("targetKey", targetKey);
        json.put("bridgeHost", bridgeHost);
        json.put("bridgePort", bridgePort);
        if (authToken != null) json.put("authToken", authToken);
        if (daemonHostId != null) json.put("daemonHostId", daemonHostId);
        if (relayHostId != null) json.put("relayHostId", relayHostId);
        if (tailscaleHost != null) json.put("tailscaleHost", tailscaleHost);
        if (ipv6Host != null) json.put("ipv6Host", ipv6Host);
        if (ipv4Host != null) json.put("ipv4Host", ipv4Host);
        if (signalUrl != null) json.put("signalUrl", signalUrl);
        return json;
    }

    public static AndroidConnectionServiceTarget fromJson(JSONObject json) throws JSONException {
        if (json == null) {
            throw new IllegalArgumentException("target payload missing");
        }
        String targetKey = json.optString("targetKey", "");
        String bridgeHost = json.optString("bridgeHost", "");
        int bridgePort = json.optInt("bridgePort", 0);
        if (targetKey.trim().isEmpty()) throw new IllegalArgumentException("target.targetKey missing");
        if (bridgeHost.trim().isEmpty()) throw new IllegalArgumentException("target.bridgeHost missing");
        if (bridgePort <= 0 || bridgePort > 65535) {
            throw new IllegalArgumentException("target.bridgePort out of range");
        }
        return new Builder()
            .targetKey(targetKey.trim())
            .bridgeHost(bridgeHost.trim())
            .bridgePort(bridgePort)
            .authToken(optTrim(json, "authToken"))
            .daemonHostId(optTrim(json, "daemonHostId"))
            .relayHostId(optTrim(json, "relayHostId"))
            .tailscaleHost(optTrim(json, "tailscaleHost"))
            .ipv6Host(optTrim(json, "ipv6Host"))
            .ipv4Host(optTrim(json, "ipv4Host"))
            .signalUrl(optTrim(json, "signalUrl"))
            .build();
    }

    private static String optTrim(JSONObject json, String field) {
        if (!json.has(field) || json.isNull(field)) return null;
        String value = json.optString(field, "");
        return value.trim().isEmpty() ? null : value;
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof AndroidConnectionServiceTarget)) return false;
        AndroidConnectionServiceTarget that = (AndroidConnectionServiceTarget) other;
        return Objects.equals(targetKey, that.targetKey)
            && Objects.equals(bridgeHost, that.bridgeHost)
            && bridgePort == that.bridgePort
            && Objects.equals(authToken, that.authToken)
            && Objects.equals(daemonHostId, that.daemonHostId)
            && Objects.equals(relayHostId, that.relayHostId)
            && Objects.equals(tailscaleHost, that.tailscaleHost)
            && Objects.equals(ipv6Host, that.ipv6Host)
            && Objects.equals(ipv4Host, that.ipv4Host)
            && Objects.equals(signalUrl, that.signalUrl);
    }

    @Override
    public int hashCode() {
        return Objects.hash(targetKey, bridgeHost, bridgePort, authToken, daemonHostId,
            relayHostId, tailscaleHost, ipv6Host, ipv4Host, signalUrl);
    }

    public static final class Builder {
        private String targetKey;
        private String bridgeHost;
        private int bridgePort;
        private String authToken;
        private String daemonHostId;
        private String relayHostId;
        private String tailscaleHost;
        private String ipv6Host;
        private String ipv4Host;
        private String signalUrl;

        public Builder targetKey(String v) { this.targetKey = v; return this; }
        public Builder bridgeHost(String v) { this.bridgeHost = v; return this; }
        public Builder bridgePort(int v) { this.bridgePort = v; return this; }
        public Builder authToken(String v) { this.authToken = v; return this; }
        public Builder daemonHostId(String v) { this.daemonHostId = v; return this; }
        public Builder relayHostId(String v) { this.relayHostId = v; return this; }
        public Builder tailscaleHost(String v) { this.tailscaleHost = v; return this; }
        public Builder ipv6Host(String v) { this.ipv6Host = v; return this; }
        public Builder ipv4Host(String v) { this.ipv4Host = v; return this; }
        public Builder signalUrl(String v) { this.signalUrl = v; return this; }

        public AndroidConnectionServiceTarget build() {
            return new AndroidConnectionServiceTarget(this);
        }
    }
}
