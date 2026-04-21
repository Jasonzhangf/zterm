package com.zterm.android;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.text.TextUtils;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeviceClipboard")
public class DeviceClipboardPlugin extends Plugin {
    @PluginMethod
    public void readText(PluginCall call) {
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            call.reject("系统剪贴板服务不可用");
            return;
        }

        ClipData clipData = clipboard.getPrimaryClip();
        if (clipData == null || clipData.getItemCount() <= 0) {
            call.reject("系统剪贴板当前为空");
            return;
        }

        CharSequence text = clipData.getItemAt(0).coerceToText(getContext());
        if (TextUtils.isEmpty(text)) {
            call.reject("系统剪贴板当前为空");
            return;
        }

        JSObject result = new JSObject();
        result.put("value", text.toString());
        call.resolve(result);
    }
}
