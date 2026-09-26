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
    public void runPhase8Connection(PluginCall call) {
        try {
            call.resolve(result("runPhase8Connection", DagpipeCoreBridge.runPhase8Connection(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase8Connection", error);
        }
    }

    @PluginMethod
    public void runPhase6Control(PluginCall call) {
        try {
            call.resolve(result("runPhase6Control", DagpipeCoreBridge.runPhase6Control(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase6Control", error);
        }
    }

    @PluginMethod
    public void runPhase7Update(PluginCall call) {
        try {
            call.resolve(result("runPhase7Update", DagpipeCoreBridge.runPhase7Update(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase7Update", error);
        }
    }

    @PluginMethod
    public void runPhase4RemoteWindow(PluginCall call) {
        try {
            call.resolve(result("runPhase4RemoteWindow", DagpipeCoreBridge.runPhase4RemoteWindow(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase4RemoteWindow", error);
        }
    }

    @PluginMethod
    public void runPhase5ShellLifecycle(PluginCall call) {
        try {
            call.resolve(result("runPhase5ShellLifecycle", DagpipeCoreBridge.runPhase5ShellLifecycle(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase5ShellLifecycle", error);
        }
    }

    @PluginMethod
    public void runPhase3InputSchedule(PluginCall call) {
        try {
            call.resolve(result("runPhase3InputSchedule", DagpipeCoreBridge.runPhase3InputSchedule(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase3InputSchedule", error);
        }
    }

    @PluginMethod
    public void runPhase2DaemonConnection(PluginCall call) {
        try {
            call.resolve(result("runPhase2DaemonConnection", DagpipeCoreBridge.runPhase2DaemonConnection(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase2DaemonConnection", error);
        }
    }

    @PluginMethod
    public void runPhase5PreviewLattice(PluginCall call) {
        try {
            call.resolve(result("runPhase5PreviewLattice", DagpipeCoreBridge.runPhase5PreviewLattice(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase5PreviewLattice", error);
        }
    }

    @PluginMethod
    public void runPhase6ConfigExport(PluginCall call) {
        try {
            call.resolve(result("runPhase6ConfigExport", DagpipeCoreBridge.runPhase6ConfigExport(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase6ConfigExport", error);
        }
    }

    @PluginMethod
    public void runPhase6ConfigImport(PluginCall call) {
        try {
            call.resolve(result("runPhase6ConfigImport", DagpipeCoreBridge.runPhase6ConfigImport(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase6ConfigImport", error);
        }
    }

    @PluginMethod
    public void runPhase6Composition(PluginCall call) {
        try {
            call.resolve(result("runPhase6Composition", DagpipeCoreBridge.runPhase6Composition(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase6Composition", error);
        }
    }

    @PluginMethod
    public void runPhase7Release(PluginCall call) {
        try {
            call.resolve(result("runPhase7Release", DagpipeCoreBridge.runPhase7Release(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase7Release", error);
        }
    }

    @PluginMethod
    public void runPhase7Debug(PluginCall call) {
        try {
            call.resolve(result("runPhase7Debug", DagpipeCoreBridge.runPhase7Debug(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase7Debug", error);
        }
    }

    @PluginMethod
    public void runPhase2Relay(PluginCall call) {
        try {
            call.resolve(result("runPhase2Relay", DagpipeCoreBridge.runPhase2Relay(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase2Relay", error);
        }
    }

    @PluginMethod
    public void runPhase3FileBrowse(PluginCall call) {
        try {
            call.resolve(result("runPhase3FileBrowse", DagpipeCoreBridge.runPhase3FileBrowse(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase3FileBrowse", error);
        }
    }

    @PluginMethod
    public void runPhase3Upload(PluginCall call) {
        try {
            call.resolve(result("runPhase3Upload", DagpipeCoreBridge.runPhase3Upload(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase3Upload", error);
        }
    }

    @PluginMethod
    public void runPhase3Download(PluginCall call) {
        try {
            call.resolve(result("runPhase3Download", DagpipeCoreBridge.runPhase3Download(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase3Download", error);
        }
    }

    @PluginMethod
    public void runPhase3Attachment(PluginCall call) {
        try {
            call.resolve(result("runPhase3Attachment", DagpipeCoreBridge.runPhase3Attachment(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase3Attachment", error);
        }
    }

    @PluginMethod
    public void runPhase3Screenshot(PluginCall call) {
        try {
            call.resolve(result("runPhase3Screenshot", DagpipeCoreBridge.runPhase3Screenshot(call.getString("inputJson", "{}"))));
        } catch (Throwable error) {
            rejectCall(call, "runPhase3Screenshot", error);
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
