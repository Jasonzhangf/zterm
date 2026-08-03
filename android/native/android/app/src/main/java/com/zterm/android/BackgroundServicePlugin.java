package com.zterm.android;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BackgroundService")
public class BackgroundServicePlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        int sessionCount = Math.max(0, call.getInt("sessionCount", 0));
        if (sessionCount <= 0) {
            stopService();
            call.resolve(result(true));
            return;
        }

        Intent serviceIntent = new Intent(getContext(), BackgroundService.class);
        serviceIntent.putExtra("sessionCount", sessionCount);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(serviceIntent);
        } else {
            getContext().startService(serviceIntent);
        }
        call.resolve(result(true));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopService();
        call.resolve(result(true));
    }

    @PluginMethod
    public void updateSessionCount(PluginCall call) {
        int sessionCount = Math.max(0, call.getInt("sessionCount", 0));
        if (sessionCount <= 0) {
            stopService();
            call.resolve(result(true));
            return;
        }

        Intent serviceIntent = new Intent(getContext(), BackgroundService.class);
        serviceIntent.putExtra("sessionCount", sessionCount);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(serviceIntent);
        } else {
            getContext().startService(serviceIntent);
        }
        call.resolve(result(true));
    }

    private void stopService() {
        Intent serviceIntent = new Intent(getContext(), BackgroundService.class);
        getContext().stopService(serviceIntent);
    }

    private JSObject result(boolean ok) {
        JSObject result = new JSObject();
        result.put("ok", ok);
        return result;
    }
}
