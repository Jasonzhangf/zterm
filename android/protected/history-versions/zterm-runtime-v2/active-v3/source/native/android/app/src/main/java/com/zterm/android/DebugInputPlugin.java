package com.zterm.android;
import com.getcapacitor.*; import com.getcapacitor.annotation.CapacitorPlugin;
@CapacitorPlugin(name = "DebugInput")
public class DebugInputPlugin extends Plugin {
 @PluginMethod public void sendInput(PluginCall call){
  JSObject p=new JSObject(); p.put("sessionId",call.getString("sessionId","")); p.put("text",call.getString("text","")); p.put("newline",call.getString("newline","\r")); p.put("ts",System.currentTimeMillis());
  notifyListeners("debug-input",p); JSObject r=new JSObject(); r.put("ok",true); call.resolve(r);
 }
}
