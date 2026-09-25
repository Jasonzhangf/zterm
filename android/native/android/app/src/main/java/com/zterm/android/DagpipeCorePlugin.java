package com.zterm.android;

import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor projection for the zterm-dagpipe Rust core.
 *
 * The plugin is an explicit transport: it parses one JSON request, calls the
 * Rust core, and returns the JSON response. It never owns graph state.
 */
@CapacitorPlugin(name = "DagpipeCore")
public final class DagpipeCorePlugin extends Plugin {
    @PluginMethod
    public void compilePhase0(PluginCall call) {
        try {
            String raw = DagpipeCoreBridge.compilePhase0();
            if (BuildConfig.DEBUG) {
                Log.i("DagpipeCore", "compilePhase0 result=" + raw);
            }
            call.resolve(result("compilePhase0", raw));
        } catch (Throwable error) {
            rejectCall(call, "compilePhase0", error);
        }
    }

    @PluginMethod
    public void compileAllDagpipePhases(PluginCall call) {
        try {
            String raw = DagpipeCoreBridge.compileAllDagpipePhases();
            if (BuildConfig.DEBUG) {
                Log.i("DagpipeCore", "compileAllDagpipePhases result=" + raw);
            }
            call.resolve(result("compileAllDagpipePhases", raw));
        } catch (Throwable error) {
            rejectCall(call, "compileAllDagpipePhases", error);
        }
    }

    @PluginMethod
    public void runConnectionLifecycle(PluginCall call) {
        try {
            call.resolve(result("runConnectionLifecycle", DagpipeCoreBridge.runConnectionLifecycle(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runConnectionLifecycle", error);
        }
    }

    @PluginMethod
    public void runBufferManagement(PluginCall call) {
        try {
            call.resolve(result("runBufferManagement", DagpipeCoreBridge.runBufferManagement(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runBufferManagement", error);
        }
    }

    @PluginMethod
    public void runBufferRender(PluginCall call) {
        try {
            call.resolve(result("runBufferRender", DagpipeCoreBridge.runBufferRender(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runBufferRender", error);
        }
    }

    @PluginMethod
    public void runInputDispatch(PluginCall call) {
        try {
            call.resolve(result("runInputDispatch", DagpipeCoreBridge.runInputDispatch(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runInputDispatch", error);
        }
    }

    private JSObject result(String method, String raw) {
        JSObject result = new JSObject();
        result.put("method", method);
        result.put("json", raw);
        return result;
    }

    private void rejectCall(PluginCall call, String method, Throwable error) {
        String message = error.getMessage() != null ? error.getMessage() : error.getClass().getSimpleName();
        if (error instanceof Exception) {
            call.reject(method + " failed: " + message, (Exception) error);
        } else {
            call.reject(method + " failed: " + message);
        }
    }
}
