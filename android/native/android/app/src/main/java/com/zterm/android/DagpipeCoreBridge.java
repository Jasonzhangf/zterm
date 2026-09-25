package com.zterm.android;

/**
 * Thin JNI projection to the zterm-dagpipe Rust core.
 *
 * This class is a transport for pure graph execution only. It does not own
 * transport, session, buffer, renderer, or input state. The TypeScript bridge
 * decides when native Rust execution is the active path and keeps the old TS
 * implementation available until the parity gate passes.
 */
public final class DagpipeCoreBridge {
    static {
        System.loadLibrary("zterm_dagpipe");
    }

    private DagpipeCoreBridge() {
    }

    public static native String compilePhase0();

    public static native String compileAllDagpipePhases();

    public static native String runPhase8Connection(String inputJson);

    public static native String runPhase6Control(String inputJson);

    public static native String runPhase7Update(String inputJson);

    public static native String runPhase4RemoteWindow(String inputJson);

    public static native String runPhase5ShellLifecycle(String inputJson);

    public static native String runPhase3InputSchedule(String inputJson);

    public static native String runPhase2DaemonConnection(String inputJson);

    public static native String runPhase5PreviewLattice(String inputJson);

    public static native String runConnectionLifecycle(String inputJson);

    public static native String runBufferManagement(String inputJson);

    public static native String runBufferRender(String inputJson);

    public static native String runInputDispatch(String inputJson);
}
