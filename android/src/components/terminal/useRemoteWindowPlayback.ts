import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type {
  DecodedFrameCommit,
  RemoteWindowPlaybackBinding,
} from '../../lib/remote-window-receiver-runtime';

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

export interface RemoteWindowDecodedFrame {
  video: HTMLVideoElement;
  lane: 'focus' | 'overview';
  presentedFrames?: number;
}

export interface UseRemoteWindowPlaybackOptions {
  receiverMediaStream: MediaStream | null;
  overviewMediaStream: MediaStream | null;
  receiverPlaybackBinding?: RemoteWindowPlaybackBinding | null;
  overviewPlaybackBinding?: RemoteWindowPlaybackBinding | null;
  streamStatus: string | null;
  streamId: string | null;
  videoElementRef: RefObject<HTMLVideoElement | null>;
  overviewVideoElementRef: RefObject<HTMLVideoElement | null>;
  onVideoDebug?: (snapshot: RemoteWindowVideoDebugSnapshot) => void;
  onDecodedFrameSize?: (size: { width: number; height: number }) => void;
  onProjectionError?: (message: string) => void;
  commitDecodedFrame?: (commit: DecodedFrameCommit) => boolean;
}

export function useRemoteWindowPlayback({
  receiverMediaStream,
  overviewMediaStream,
  receiverPlaybackBinding = null,
  overviewPlaybackBinding = null,
  streamStatus,
  streamId,
  videoElementRef,
  overviewVideoElementRef,
  onVideoDebug,
  onDecodedFrameSize,
  onProjectionError,
  commitDecodedFrame,
}: UseRemoteWindowPlaybackOptions) {
  const [videoHasPlayed, setVideoHasPlayed] = useState(false);
  const videoHasPlayedRef = useRef(false);
  const [liveDiagnostics, setLiveDiagnostics] = useState<RemoteWindowLiveDiagnostics | null>(null);
  const [videoDebugSnapshot, setVideoDebugSnapshot] = useState<RemoteWindowVideoDebugSnapshot | null>(null);
  const frameCallbackRef = useRef<{ video: HTMLVideoElement; callbackId: number } | null>(null);
  const overviewFrameCallbackRef = useRef<{ video: HTMLVideoElement; callbackId: number } | null>(null);
  const decodedFrameSubscribersRef = useRef(new Set<(frame: RemoteWindowDecodedFrame) => void>());
  const decodedFrameIdRef = useRef(0);
  const playbackEpochRef = useRef(0);
  const overviewEpochRef = useRef(0);
  const playbackBindingRef = useRef<{
    epoch: number;
    stream: MediaStream;
    track: MediaStreamTrack | null;
    trackId: string | null;
  } | null>(null);
  const overviewPlaybackBindingRef = useRef<{
    epoch: number;
    stream: MediaStream;
    track: MediaStreamTrack | null;
  } | null>(null);
  const overviewDecodedFrameIdRef = useRef(0);
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

  const isCurrentPlayback = useCallback((
    video: HTMLVideoElement,
    stream: MediaStream,
    track: MediaStreamTrack | null,
    epoch: number,
  ) => {
    const binding = playbackBindingRef.current;
    return playbackEpochRef.current === epoch
      && binding?.epoch === epoch
      && binding.stream === stream
      && binding.track === track
      && (!receiverPlaybackBinding
        || (receiverPlaybackBinding.mediaStream === stream
          && receiverPlaybackBinding.trackId === (track?.id || '')))
      && videoElementRef.current === video
      && video.srcObject === stream;
  }, [receiverPlaybackBinding, videoElementRef]);

  const reveal = useCallback((
    video: HTMLVideoElement,
    stream: MediaStream,
    track: MediaStreamTrack | null,
    epoch: number,
    lastEvent = 'playing',
  ) => {
    if (!isCurrentPlayback(video, stream, track, epoch)) return;
    playbackStatsRef.current.playingAt ??= Date.now();
    updateVisibility(true);
    publishDebugSnapshot(lastEvent, { visible: true });
  }, [isCurrentPlayback, publishDebugSnapshot, updateVisibility]);

  const cancelFrameCallback = useCallback((
    ref: { current: { video: HTMLVideoElement; callbackId: number } | null },
  ) => {
    const scheduled = ref.current;
    ref.current = null;
    if (scheduled) {
      scheduled.video.cancelVideoFrameCallback?.(scheduled.callbackId);
    }
  }, []);

  const cancelPlaybackFrameCallback = useCallback(() => {
    cancelFrameCallback(frameCallbackRef);
  }, [cancelFrameCallback]);
  const cancelOverviewFrameCallback = useCallback(() => {
    cancelFrameCallback(overviewFrameCallbackRef);
  }, [cancelFrameCallback]);

  const requestPlayback = useCallback((
    stream: MediaStream,
    epoch: number,
    boundTrack: MediaStreamTrack | null = null,
  ) => {
    const videoElement = videoElementRef.current;
    if (!videoElement) {
      publishDebugSnapshot('play-missing-video');
      return;
    }
    const video = videoElement;
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = false;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    const track = boundTrack ?? (typeof stream.getVideoTracks === 'function'
      ? stream.getVideoTracks()[0] || null
      : null);
    const requestFrame = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number;
      }).requestVideoFrameCallback;
    if (receiverPlaybackBinding && typeof requestFrame !== 'function') {
      onProjectionError?.('remote window decoded-frame callback is unavailable');
      return;
    }
    if (typeof requestFrame === 'function' && !frameCallbackRef.current) {
      let lastFrameWidth = 0;
      let lastFrameHeight = 0;
      function scheduleNextFrame() {
        if (!isCurrentPlayback(video, stream, track, epoch)) return;
        const nextRequestFrame = (video as HTMLVideoElement & {
          requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number;
        }).requestVideoFrameCallback;
        if (typeof nextRequestFrame === 'function') {
          frameCallbackRef.current = {
            video,
            callbackId: nextRequestFrame.call(video, onVideoFrame),
          };
        } else {
          frameCallbackRef.current = null;
        }
      }
      function onVideoFrame(_now: number, metadata: unknown) {
        if (!isCurrentPlayback(video, stream, track, epoch)) return;
        if (frameCallbackRef.current?.video === video) {
          frameCallbackRef.current = null;
        }
        const width = video.videoWidth;
        const height = video.videoHeight;
        const decodedFrameValid = video.readyState >= 2 && width > 0 && height > 0;
        if (width > 0 && height > 0 && (width !== lastFrameWidth || height !== lastFrameHeight)) {
          lastFrameWidth = width;
          lastFrameHeight = height;
          onDecodedFrameSize?.({ width, height });
          if (receiverPlaybackBinding && commitDecodedFrame) {
            const commit: DecodedFrameCommit = {
              streamId: receiverPlaybackBinding.streamId,
              mediaPlanVersion: receiverPlaybackBinding.mediaPlanVersion,
              lane: receiverPlaybackBinding.lane,
              mediaEpoch: receiverPlaybackBinding.mediaEpoch,
              trackId: receiverPlaybackBinding.trackId,
              frameId: ++decodedFrameIdRef.current,
              width,
              height,
            };
            commitDecodedFrame(commit);
          }
        }
        if (decodedFrameValid) {
          const presentedFrames = typeof metadata === 'object' && metadata !== null
            && 'presentedFrames' in metadata && typeof metadata.presentedFrames === 'number'
            ? metadata.presentedFrames
            : undefined;
          decodedFrameSubscribersRef.current.forEach((subscriber) => subscriber({ video, lane: 'focus', presentedFrames }));
          if (!isCurrentPlayback(video, stream, track, epoch)) return;
          playbackStatsRef.current.framesReceived += 1;
          playbackStatsRef.current.decodedFirstFrameAt ??= Date.now();
          if (!videoHasPlayedRef.current) reveal(video, stream, track, epoch, 'frame');
          const received = playbackStatsRef.current.framesReceived;
          if (received === 1 || received % 60 === 0) {
            publishDebugSnapshot('frame-callback');
          }
        }
        if (!isCurrentPlayback(video, stream, track, epoch)) return;
        scheduleNextFrame();
      }
      frameCallbackRef.current = {
        video,
        callbackId: requestFrame.call(video, onVideoFrame),
      };
    }
    playbackStatsRef.current.playAttempts += 1;
    publishDebugSnapshot('play-request');
    const playResult = typeof video.play === 'function' ? video.play() : null;
    if (playResult && typeof playResult.then === 'function') {
      playResult.then(() => {
        if (!isCurrentPlayback(video, stream, track, epoch)) return;
        playbackStatsRef.current.playAccepted += 1;
        playbackStatsRef.current.playingAt ??= Date.now();
        reveal(video, stream, track, epoch, 'play-resolved');
        publishDebugSnapshot('play-resolved');
      }).catch((error) => {
        if (!isCurrentPlayback(video, stream, track, epoch)) return;
        playbackStatsRef.current.playRejected += 1;
        publishDebugSnapshot('play-rejected', {
          error: error instanceof Error ? error.message : String(error || 'play rejected'),
        });
      });
      return;
    }
    publishDebugSnapshot('play-sync-pending');
  }, [
    isCurrentPlayback,
    onDecodedFrameSize,
    commitDecodedFrame,
    receiverPlaybackBinding,
    onProjectionError,
    publishDebugSnapshot,
    reveal,
    videoElementRef,
  ]);

  const requestBoundPlayback = useCallback(() => {
    const binding = playbackBindingRef.current;
    if (!binding) {
      publishDebugSnapshot('play-missing-binding');
      return;
    }
    requestPlayback(binding.stream, binding.epoch, binding.track);
  }, [publishDebugSnapshot, requestPlayback]);

  const requestOverviewPlayback = useCallback(() => {
    const overviewVideo = overviewVideoElementRef.current;
    if (!overviewVideo || !overviewMediaStream) {
      return;
    }
    const epoch = ++overviewEpochRef.current;
    cancelOverviewFrameCallback();
    const track = overviewMediaStream.getVideoTracks?.()[0] || null;
    overviewPlaybackBindingRef.current = {
      epoch,
      stream: overviewMediaStream,
      track,
    };
    overviewVideo.autoplay = true;
    overviewVideo.muted = true;
    overviewVideo.defaultMuted = true;
    overviewVideo.playsInline = true;
    overviewVideo.controls = false;
    if (overviewVideo.srcObject !== overviewMediaStream) {
      overviewVideo.srcObject = overviewMediaStream;
    }
    const isCurrentOverviewPlayback = () => {
      const binding = overviewPlaybackBindingRef.current;
      return overviewEpochRef.current === epoch
        && binding?.epoch === epoch
        && binding.stream === overviewMediaStream
        && binding.track === track
        && overviewVideoElementRef.current === overviewVideo
        && overviewVideo.srcObject === overviewMediaStream;
    };
    const requestFrame = (overviewVideo as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number;
    }).requestVideoFrameCallback;
    if (typeof requestFrame !== 'function') {
      onProjectionError?.('remote window decoded-frame callback is unavailable');
      return;
    }
    const onOverviewFrame = (_now: number, metadata: unknown) => {
      if (!isCurrentOverviewPlayback()) return;
      if (overviewFrameCallbackRef.current?.video === overviewVideo) {
        overviewFrameCallbackRef.current = null;
      }
      const width = overviewVideo.videoWidth;
      const height = overviewVideo.videoHeight;
      if (overviewVideo.readyState >= 2 && width > 0 && height > 0) {
        if (overviewPlaybackBinding && commitDecodedFrame) {
          commitDecodedFrame({
            streamId: overviewPlaybackBinding.streamId,
            mediaPlanVersion: overviewPlaybackBinding.mediaPlanVersion,
            lane: overviewPlaybackBinding.lane,
            mediaEpoch: overviewPlaybackBinding.mediaEpoch,
            trackId: overviewPlaybackBinding.trackId,
            frameId: ++overviewDecodedFrameIdRef.current,
            width,
            height,
          });
        }
        const presentedFrames = typeof metadata === 'object' && metadata !== null
          && 'presentedFrames' in metadata && typeof metadata.presentedFrames === 'number'
          ? metadata.presentedFrames
          : undefined;
        decodedFrameSubscribersRef.current.forEach((subscriber) => subscriber({
          video: overviewVideo,
          lane: 'overview',
          presentedFrames,
        }));
      }
      if (!isCurrentOverviewPlayback()) return;
      const nextRequestFrame = (overviewVideo as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number;
      }).requestVideoFrameCallback;
      if (typeof nextRequestFrame === 'function') {
        overviewFrameCallbackRef.current = {
          video: overviewVideo,
          callbackId: nextRequestFrame.call(overviewVideo, onOverviewFrame),
        };
      }
    };
    overviewFrameCallbackRef.current = {
      video: overviewVideo,
      callbackId: requestFrame.call(overviewVideo, onOverviewFrame),
    };
    const playResult = typeof overviewVideo.play === 'function' ? overviewVideo.play() : null;
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch((error) => {
        if (!isCurrentOverviewPlayback()) return;
        onProjectionError?.(
          `remote window overview playback was rejected: ${error instanceof Error ? error.message : String(error || 'play rejected')}`,
        );
      });
    }
  }, [
    cancelOverviewFrameCallback,
    commitDecodedFrame,
    overviewMediaStream,
    overviewPlaybackBinding,
    overviewVideoElementRef,
    onProjectionError,
  ]);

  const rearmBoundPlayback = useCallback(() => {
    const binding = playbackBindingRef.current;
    if (!binding) {
      publishDebugSnapshot('rearm-missing-binding');
      return;
    }
    cancelPlaybackFrameCallback();
    cancelOverviewFrameCallback();
    const epoch = ++playbackEpochRef.current;
    playbackBindingRef.current = { ...binding, epoch };
    requestPlayback(binding.stream, epoch, binding.track);
    requestOverviewPlayback();
  }, [
    cancelOverviewFrameCallback,
    cancelPlaybackFrameCallback,
    publishDebugSnapshot,
    requestOverviewPlayback,
    requestPlayback,
  ]);

  const restoreRetainedPlayback = useCallback((visible: boolean) => {
    const epoch = playbackEpochRef.current;
    playbackBindingRef.current = receiverMediaStream ? {
      epoch,
      stream: receiverMediaStream,
      track: receiverMediaStream.getVideoTracks?.()[0] || null,
      trackId: receiverMediaStream.getVideoTracks?.()[0]?.id || null,
    } : null;
    updateVisibility(visible);
    if (!visible && receiverMediaStream) {
      requestPlayback(receiverMediaStream, epoch);
    }
    if (overviewMediaStream) {
      requestOverviewPlayback();
    }
  }, [
    overviewMediaStream,
    receiverMediaStream,
    requestOverviewPlayback,
    requestPlayback,
    updateVisibility,
  ]);

  const invalidatePlayback = useCallback(() => {
    playbackEpochRef.current += 1;
    overviewEpochRef.current += 1;
    cancelPlaybackFrameCallback();
    cancelOverviewFrameCallback();
  }, [cancelOverviewFrameCallback, cancelPlaybackFrameCallback]);

  useEffect(() => {
    const video = videoElementRef.current;
    if (!video) {
      return;
    }
    const epoch = ++playbackEpochRef.current;
    cancelPlaybackFrameCallback();
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
    decodedFrameIdRef.current = 0;
    if (!receiverMediaStream) {
      playbackBindingRef.current = null;
      return;
    }
    const track = receiverMediaStream.getVideoTracks?.()[0] || null;
    playbackBindingRef.current = {
      epoch,
      stream: receiverMediaStream,
      track,
      trackId: track?.id || null,
    };
    requestPlayback(receiverMediaStream, epoch, track);
    const pollTimer = window.setInterval(() => {
      if (videoElementRef.current?.srcObject === receiverMediaStream) {
        publishDebugSnapshot('play-poll');
      }
    }, 350);
    const stopTimer = window.setTimeout(() => window.clearInterval(pollTimer), 5000);
    return () => {
      if (playbackEpochRef.current === epoch) {
        playbackEpochRef.current += 1;
        playbackBindingRef.current = null;
      }
      cancelPlaybackFrameCallback();
      window.clearInterval(pollTimer);
      window.clearTimeout(stopTimer);
    };
  }, [cancelPlaybackFrameCallback, publishDebugSnapshot, receiverMediaStream, requestPlayback, updateVisibility, videoElementRef]);

  useEffect(() => {
    if (!overviewMediaStream) {
      overviewEpochRef.current += 1;
      overviewPlaybackBindingRef.current = null;
      cancelOverviewFrameCallback();
      return;
    }
    requestOverviewPlayback();
    return () => {
      overviewEpochRef.current += 1;
      overviewPlaybackBindingRef.current = null;
      cancelOverviewFrameCallback();
    };
  }, [
    cancelOverviewFrameCallback,
    overviewMediaStream,
    requestOverviewPlayback,
  ]);

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
    }, 1000);
    return () => window.clearInterval(timer);
  }, [receiverMediaStream, streamId, streamStatus, videoElementRef]);

  const subscribeDecodedFrame = useCallback((callback: (frame: RemoteWindowDecodedFrame) => void) => {
    decodedFrameSubscribersRef.current.add(callback);
    return () => decodedFrameSubscribersRef.current.delete(callback);
  }, []);

  return {
    invalidatePlayback,
    liveDiagnostics,
    publishDebugSnapshot,
    rearmBoundPlayback,
    requestBoundPlayback,
    restoreRetainedPlayback,
    subscribeDecodedFrame,
    updateVisibility,
    videoDebugSnapshot,
    videoHasPlayed,
    videoHasPlayedRef,
  };
}
