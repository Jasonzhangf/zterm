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
            // 固定竖屏锁定（非 SENSOR_PORTRAIT）：不管手机处于什么姿势都不做横竖屏切换，
            // 只由客户端角落转换按钮触发切换——视频播放器式方向语义
            getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        } else if ("landscape".equals(orientation)) {
            getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        } else {
            call.reject("orientation must be portrait or landscape");
            return;
        }
        JSObject result = new JSObject();
        result.put("orientation", orientation);
        call.resolve(result);
    }
}
