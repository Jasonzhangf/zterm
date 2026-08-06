package com.zterm.android;

import android.content.pm.ActivityInfo;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenOrientation")
public class ScreenOrientationPlugin extends Plugin {
    @PluginMethod
    public void setOrientation(PluginCall call) {
        String orientation = call.getString("orientation", "");
        if ("portrait".equals(orientation)) {
            getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
        } else if ("landscape".equals(orientation)) {
            getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        } else {
            call.reject("orientation must be portrait or landscape");
            return;
        }
        JSObject result = new JSObject();
        result.put("orientation", orientation);
        call.resolve(result);
    }
}
