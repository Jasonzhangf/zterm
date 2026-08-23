import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface RemoteWindowVideoDebugSnapshot {
  attached: boolean;
  visible: boolean;
  readyState: number;
  paused: boolean;
  videoWidth: number;
  videoHeight: number;
  playAttempts: number;
  playAccepted: number;
  playRejected: number;
  framesReceived: number;
  lastEvent: string;
  lastError: string;
  updatedAt: number | null;
  trackAttachedAt: number | null;
  decodedFirstFrameAt: number | null;
  playingAt: number | null;
}

export interface RemoteWindowLiveDiagnostics {
  sampledAt: number;
  currentTime: number;
  paused: boolean;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  framesReceived: number;
  trackState: string;
  trackMuted: boolean;
  epoch: number;
  streamId: string | null;
}

export interface UseRemoteWindowPlaybackOptions {
  receiverMediaStream: MediaStream | null;
  overviewMediaStream: MediaStream | null;
  streamStatus: string | null;
  streamId: string | null;
  videoElementRef: RefObject<HTMLVideoElement | null>;
  overviewVideoElementRef: RefObject<HTMLVideoElement | null>;
  onVideoDebug?: (snapshot: RemoteWindowVideoDebugSnapshot) => void;
}

export function useRemoteWindowPlayback({
  receiverMediaStream,
  overviewMediaStream,
  streamStatus,
  streamId,
  videoElementRef,
  overviewVideoElementRef,
  onVideoDebug,
}: UseRemoteWindowPlaybackOptions) {
  const [videoHasPlayed, setVideoHasPlayed] = useState(false);
  const videoHasPlayedRef = useRef(false);
  const [liveDiagnostics, setLiveDiagnostics] = useState<RemoteWindowLiveDiagnostics | null>(null);
  const [videoDebugSnapshot, setVideoDebugSnapshot] = useState<RemoteWindowVideoDebugSnapshot | null>(null);
  const frameCallbackRef = useRef<((now: number) => void) | null>(null);
  const playbackEpochRef = useRef(0);
  const playbackBindingRef = useRef<{ epoch: number; stream: MediaStream } | null>(null);
  const playbackStatsRef = useRef({
    playAttempts: 0,
    playAccepted: 0,
    playRejected: 0,
    framesReceived: 0,
    lastError: '-',
    trackAttachedAt: null as number | null,
    decodedFirstFrameAt: null as number | null,
    playingAt: null as number | null,
  });

  const updateVisibility = useCallback((visible: boolean) => {
    videoHasPlayedRef.current = visible;
    setVideoHasPlayed(visible);
  }, []);

  const publishDebugSnapshot = useCallback((lastEvent: string, options?: { visible?: boolean; error?: string }) => {
    const video = videoElementRef.current;
    const stats = playbackStatsRef.current;
    if (options?.error) {
      stats.lastError = options.error;
    }
    const snapshot: RemoteWindowVideoDebugSnapshot = {
      attached: Boolean(video && receiverMediaStream && video.srcObject === receiverMediaStream),
      visible: options?.visible ?? videoHasPlayedRef.current,
      readyState: video?.readyState ?? 0,
      paused: video?.paused ?? true,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      playAttempts: stats.playAttempts,
      playAccepted: stats.playAccepted,
      playRejected: stats.playRejected,
      framesReceived: stats.framesReceived,
      lastEvent,
      lastError: stats.lastError,
      updatedAt: Date.now(),
      trackAttachedAt: stats.trackAttachedAt,
      decodedFirstFrameAt: stats.decodedFirstFrameAt,
      playingAt: stats.playingAt,
    };
    setVideoDebugSnapshot(snapshot);
    onVideoDebug?.(snapshot);
  }, [onVideoDebug, receiverMediaStream, videoElementRef]);

  const reveal = useCallback((video: HTMLVideoElement, stream: MediaStream, epoch: number, lastEvent = 'playing') => {
    const binding = playbackBindingRef.current;
    console.log(
      `[remote-window-reveal] lastEvent=${lastEvent} epoch_in=${epoch} epoch_cur=${playbackEpochRef.current} ` +
      `epoch_match=${playbackEpochRef.current === epoch} binding_epoch=${binding?.epoch ?? '-'} ` +
      `binding_match=${binding?.epoch === epoch} binding_stream_match=${binding?.stream === stream} ` +
      `video_ref_match=${videoElementRef.current === video} srcObject_match=${video.srcObject === stream}`,
    );
    if (
      playbackEpochRef.current !== epoch
      || binding?.epoch !== epoch
      || binding.stream !== stream
      || videoElementRef.current !== video
      || video.srcObject !== stream
    ) {
      return;
    }
    playbackStatsRef.current.playingAt ??= Date.now();
    updateVisibility(true);
    publishDebugSnapshot(lastEvent, { visible: true });
  }, [publishDebugSnapshot, updateVisibility, videoElementRef]);

  const scheduleFrameReveal = useCallback((video: HTMLVideoElement, stream: MediaStream, epoch: number) => {
    const requestFrame = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    }).requestVideoFrameCallback;
    if (typeof requestFrame !== 'function') {
      return false;
    }
    requestFrame.call(video, () => reveal(video, stream, epoch, 'frame'));
    return true;
  }, [reveal]);

  const requestPlayback = useCallback((stream: MediaStream, epoch: number) => {
    const video = videoElementRef.current;
    if (!video) {
      publishDebugSnapshot('play-missing-video');
      return;
    }
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = false;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    const requestFrame = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number;
    }).requestVideoFrameCallback;
    if (typeof requestFrame === 'function' && !frameCallbackRef.current) {
      const onVideoFrame = () => {
        playbackStatsRef.current.framesReceived += 1;
        playbackStatsRef.current.decodedFirstFrameAt ??= Date.now();
        const received = playbackStatsRef.current.framesReceived;
        if (received === 1 || received % 60 === 0) {
          console.log(
            `[remote-window] client framesReceived=${received} video=${video.videoWidth}x${video.videoHeight} ` +
            `paused=${video.paused} readyState=${video.readyState} seeking=${video.seeking} ` +
            `currentTime=${video.currentTime.toFixed(3)}`,
          );
          publishDebugSnapshot('frame-callback');
        }
        const nextRequestFrame = (video as HTMLVideoElement & {
          requestVideoFrameCallback?: (callback: (now: number) => void) => number;
        }).requestVideoFrameCallback;
        nextRequestFrame?.call(video, onVideoFrame);
      };
      frameCallbackRef.current = onVideoFrame;
      requestFrame.call(video, onVideoFrame);
    }
    scheduleFrameReveal(video, stream, epoch);
    playbackStatsRef.current.playAttempts += 1;
    console.log(
      `[remote-window-playback] enter play_attempt=${playbackStatsRef.current.playAttempts} ` +
      `srcObject_equal=${video.srcObject === stream} paused=${video.paused} readyState=${video.readyState} ` +
      `seeking=${video.seeking} currentTime=${video.currentTime.toFixed(3)} epoch=${epoch}`,
    );
    publishDebugSnapshot('play-request');
    const playResult = typeof video.play === 'function' ? video.play() : null;
    if (playResult && typeof playResult.then === 'function') {
      playResult.then(() => {
        playbackStatsRef.current.playAccepted += 1;
        reveal(video, stream, epoch, 'play-resolved');
      }).catch((error) => {
        playbackStatsRef.current.playRejected += 1;
        publishDebugSnapshot('play-rejected', {
          error: error instanceof Error ? error.message : String(error || 'play rejected'),
        });
      });
      return;
    }
    publishDebugSnapshot('play-sync-pending');
  }, [publishDebugSnapshot, reveal, scheduleFrameReveal, videoElementRef]);

  const requestBoundPlayback = useCallback(() => {
    const binding = playbackBindingRef.current;
    if (!binding) {
      publishDebugSnapshot('play-missing-binding');
      return;
    }
    requestPlayback(binding.stream, binding.epoch);
  }, [publishDebugSnapshot, requestPlayback]);

  const restoreRetainedPlayback = useCallback((visible: boolean) => {
    const epoch = playbackEpochRef.current;
    playbackBindingRef.current = receiverMediaStream ? { epoch, stream: receiverMediaStream } : null;
    updateVisibility(visible);
    if (!visible && receiverMediaStream) {
      requestPlayback(receiverMediaStream, epoch);
    }
  }, [receiverMediaStream, requestPlayback, updateVisibility]);

  const invalidatePlayback = useCallback(() => {
    playbackEpochRef.current += 1;
  }, []);

  useEffect(() => {
    const video = videoElementRef.current;
    if (!video) {
      return;
    }
    const epoch = ++playbackEpochRef.current;
    updateVisibility(false);
    playbackStatsRef.current = {
      playAttempts: 0,
      playAccepted: 0,
      playRejected: 0,
      framesReceived: 0,
      lastError: '-',
      trackAttachedAt: receiverMediaStream ? Date.now() : null,
      decodedFirstFrameAt: null,
      playingAt: null,
    };
    if (!receiverMediaStream) {
      playbackBindingRef.current = null;
      return;
    }
    playbackBindingRef.current = { epoch, stream: receiverMediaStream };
    const tracks = typeof receiverMediaStream.getTracks === 'function' ? receiverMediaStream.getTracks() : [];
    console.log(
      `[remote-window-tracks] epoch=${epoch} tracks=${tracks.length} ` +
      `kinds=${tracks.map((track) => `${track.kind}:${track.readyState}:${track.muted ? 'muted' : 'live'}`).join(',') || 'no-tracks-api'}`,
    );
    frameCallbackRef.current = null;
    requestPlayback(receiverMediaStream, epoch);
    const pollTimer = window.setInterval(() => {
      if (videoElementRef.current?.srcObject === receiverMediaStream) {
        publishDebugSnapshot('play-poll');
      }
    }, 350);
    const stopTimer = window.setTimeout(() => window.clearInterval(pollTimer), 5000);
    return () => {
      window.clearInterval(pollTimer);
      window.clearTimeout(stopTimer);
    };
  }, [publishDebugSnapshot, receiverMediaStream, requestPlayback, updateVisibility, videoElementRef]);

  useEffect(() => {
    const overviewVideo = overviewVideoElementRef.current;
    if (!overviewVideo || !overviewMediaStream) {
      return;
    }
    overviewVideo.autoplay = true;
    overviewVideo.muted = true;
    overviewVideo.defaultMuted = true;
    overviewVideo.playsInline = true;
    overviewVideo.controls = false;
    if (overviewVideo.srcObject !== overviewMediaStream) {
      overviewVideo.srcObject = overviewMediaStream;
    }
  }, [overviewMediaStream, overviewVideoElementRef]);

  useEffect(() => {
    if (streamStatus !== 'streaming' || !receiverMediaStream) {
      return;
    }
    const timer = window.setInterval(() => {
      const video = videoElementRef.current;
      const track = typeof receiverMediaStream.getTracks === 'function' ? receiverMediaStream.getTracks()[0] : undefined;
      const next: RemoteWindowLiveDiagnostics = {
        sampledAt: Date.now(),
        currentTime: video?.currentTime ?? -1,
        paused: video?.paused ?? true,
        readyState: video?.readyState ?? -1,
        videoWidth: video?.videoWidth ?? 0,
        videoHeight: video?.videoHeight ?? 0,
        framesReceived: playbackStatsRef.current.framesReceived,
        trackState: track?.readyState ?? 'none',
        trackMuted: track?.muted ?? false,
        epoch: playbackEpochRef.current,
        streamId,
      };
      setLiveDiagnostics(next);
      console.log(`[remote-window-live] ${JSON.stringify(next)}`);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [receiverMediaStream, streamId, streamStatus, videoElementRef]);

  return {
    invalidatePlayback,
    liveDiagnostics,
    publishDebugSnapshot,
    requestBoundPlayback,
    restoreRetainedPlayback,
    updateVisibility,
    videoDebugSnapshot,
    videoHasPlayed,
    videoHasPlayedRef,
  };
}
