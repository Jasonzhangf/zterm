package com.zterm.android;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Client-only network fingerprint owner.
 *
 * Reads ConnectivityManager active networks and their interface addresses so
 * the JS-side NetworkIdentityRuntime can detect WiFi/cellular/VPN/IP changes
 * and bump its generation. The daemon must never receive this data; the JS
 * owner decides locally when to retire stale physical transports.
 */
@CapacitorPlugin(name = "NetworkIdentity")
public class NetworkIdentityPlugin extends Plugin {

    @PluginMethod
    public void snapshot(PluginCall call) {
        Context ctx = getContext();
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) {
            call.reject("ConnectivityManager not available");
            return;
        }
        try {
            JSObject result = buildSnapshot(cm);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() != null ? error.getMessage() : "snapshot failed");
        }
    }

    private static JSObject buildSnapshot(ConnectivityManager cm) {
        JSArray interfaces = new JSArray();
        String connectionType = "none";
        boolean connected = false;
        Network[] networks = cm.getAllNetworks();
        Network activeNetwork = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? cm.getActiveNetwork() : null;
        if (networks != null) {
            List<Network> sorted = new ArrayList<>();
            for (Network network : networks) {
                sorted.add(network);
            }
            sorted.sort((left, right) -> {
                if (activeNetwork != null && activeNetwork.equals(left) != (activeNetwork.equals(right))) {
                    return activeNetwork.equals(left) ? -1 : 1;
                }
                NetworkCapabilities leftCaps = cm.getNetworkCapabilities(left);
                NetworkCapabilities rightCaps = cm.getNetworkCapabilities(right);
                int priority = Integer.compare(transportPriority(leftCaps), transportPriority(rightCaps));
                if (priority != 0) {
                    return priority;
                }
                return String.valueOf(left).compareTo(String.valueOf(right));
            });
            if (activeNetwork != null) {
                NetworkCapabilities activeCaps = cm.getNetworkCapabilities(activeNetwork);
                if (activeCaps != null) {
                    connectionType = classify(activeCaps);
                }
            }
            for (Network network : sorted) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                if (caps == null) {
                    continue;
                }
                String type = classify(caps);
                if ("none".equals(connectionType)) {
                    connectionType = type;
                }
                connected = true;
                JSObject entry = new JSObject();
                entry.put("name", String.valueOf(network));
                entry.put("vpn", caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
                entry.put("validated", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
                entry.put("transport", type);
                StringBuilder signature = new StringBuilder();
                LinkProperties link = cm.getLinkProperties(network);
                if (link != null && link.getLinkAddresses() != null) {
                    List<String> addresses = new ArrayList<>();
                    for (LinkAddress linkAddress : link.getLinkAddresses()) {
                        InetAddress address = linkAddress.getAddress();
                        String host = address.getHostAddress();
                        if (host == null) {
                            continue;
                        }
                        int percent = host.indexOf('%');
                        if (percent >= 0) {
                            host = host.substring(0, percent);
                        }
                        addresses.add((address instanceof Inet4Address ? "v4:" : "v6:") + host);
                    }
                    java.util.Collections.sort(addresses);
                    for (String address : addresses) {
                        if (signature.length() > 0) {
                            signature.append(',');
                        }
                        signature.append(address);
                    }
                }
                entry.put("addressesSignature", signature.toString());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    String ifaceName = link != null ? link.getInterfaceName() : null;
                    if (ifaceName != null) {
                        entry.put("name", ifaceName);
                    }
                }
                interfaces.put(entry);
            }
        }
        JSObject result = new JSObject();
        result.put("connected", connected);
        result.put("connectionType", connectionType);
        result.put("interfaces", interfaces);
        return result;
    }

    private static int transportPriority(NetworkCapabilities caps) {
        if (caps == null) {
            return 100;
        }
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
            return 0;
        }
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            return 1;
        }
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
            return 2;
        }
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            return 3;
        }
        return 4;
    }

    private static String classify(NetworkCapabilities caps) {
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            return "wifi";
        }
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            return "cellular";
        }
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
            return "ethernet";
        }
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
            return "vpn";
        }
        return "unknown";
    }
}
