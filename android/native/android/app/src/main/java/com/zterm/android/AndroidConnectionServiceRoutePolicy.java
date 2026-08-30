package com.zterm.android;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Typed route policy. Manual chooses one of {@link Path}; auto leaves path
 * selection to the service-side resolver.
 */
public final class AndroidConnectionServiceRoutePolicy {
    public enum Path {
        LAN,
        TAILSCALE,
        IPV4,
        IPV6,
        RTC_DIRECT,
        RTC_RELAY;

        public String wireName() {
            switch (this) {
                case LAN: return "lan";
                case TAILSCALE: return "tailscale";
                case IPV4: return "ipv4";
                case IPV6: return "ipv6";
                case RTC_DIRECT: return "rtc-direct";
                case RTC_RELAY: return "rtc-relay";
                default: throw new IllegalStateException();
            }
        }

        public static Path fromWireName(String name) {
            switch (name) {
                case "lan": return LAN;
                case "tailscale": return TAILSCALE;
                case "ipv4": return IPV4;
                case "ipv6": return IPV6;
                case "rtc-direct": return RTC_DIRECT;
                case "rtc-relay": return RTC_RELAY;
                default: throw new IllegalArgumentException("unknown route path: " + name);
            }
        }
    }

    public final Mode mode;
    public final Path path;

    private AndroidConnectionServiceRoutePolicy(Mode mode, Path path) {
        this.mode = mode;
        this.path = path;
    }

    public static AndroidConnectionServiceRoutePolicy auto() {
        return new AndroidConnectionServiceRoutePolicy(Mode.AUTO, null);
    }

    public static AndroidConnectionServiceRoutePolicy manual(Path path) {
        if (path == null) {
            throw new IllegalArgumentException("manual policy requires a path");
        }
        return new AndroidConnectionServiceRoutePolicy(Mode.MANUAL, path);
    }

    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("mode", mode == Mode.AUTO ? "auto" : "manual");
        if (path != null) json.put("path", path.wireName());
        return json;
    }

    public static AndroidConnectionServiceRoutePolicy fromJson(JSONObject json) throws JSONException {
        if (json == null) {
            throw new IllegalArgumentException("route policy missing");
        }
        String mode = json.optString("mode", "");
        if ("auto".equals(mode)) return auto();
        if ("manual".equals(mode)) {
            return manual(Path.fromWireName(json.optString("path", "")));
        }
        throw new IllegalArgumentException("invalid route policy mode: " + mode);
    }

    public enum Mode { AUTO, MANUAL }
}
