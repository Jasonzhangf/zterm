import { useEffect, type RefObject } from 'react';

export interface RemoteWindowCompositeCanvasSlot {
  windowId: string;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export interface RemoteWindowCompositeCanvasLayout {
  windows: RemoteWindowCompositeCanvasSlot[];
  canvasWidth: number;
  canvasHeight: number;
}

export interface UseRemoteWindowCompositeCanvasOptions {
  layout: RemoteWindowCompositeCanvasLayout | null;
  focusedWindow: RemoteWindowCompositeCanvasSlot | null;
  overviewCropVisible: boolean;
  receiverMediaStream: MediaStream | null;
  overviewMediaStream: MediaStream | null;
  videoElementRef: RefObject<HTMLVideoElement | null>;
  overviewVideoElementRef: RefObject<HTMLVideoElement | null>;
  overviewCanvasRef: RefObject<HTMLCanvasElement | null>;
  focusDisplayCanvasRef?: RefObject<HTMLCanvasElement | null>;
  thumbnailCanvasRefs: RefObject<Map<string, HTMLCanvasElement | null>>;
  onProjectionError?: (message: string) => void;
}

export function useRemoteWindowCompositeCanvas({
  layout,
  focusedWindow,
  overviewCropVisible,
  receiverMediaStream,
  overviewMediaStream,
  videoElementRef,
  overviewVideoElementRef,
  overviewCanvasRef,
  focusDisplayCanvasRef,
  thumbnailCanvasRefs,
  onProjectionError,
}: UseRemoteWindowCompositeCanvasOptions) {
  useEffect(() => {
    if (!receiverMediaStream || !focusDisplayCanvasRef) {
      return;
    }
    const video = videoElementRef.current;
    if (!video) {
      return;
    }
    if (typeof video.requestVideoFrameCallback !== 'function') {
      onProjectionError?.('remote window decoded-frame callback is unavailable');
      return;
    }
    let cancelled = false;
    let callbackId: number | null = null;
    let lastPresentedFrames: number | null = null;
    let cachedCanvas: HTMLCanvasElement | null = null;
    let cachedContext: CanvasRenderingContext2D | null = null;
    const requestFrame = video.requestVideoFrameCallback.bind(video);
    const drawFocus = (_now: number, metadata: { presentedFrames?: number }) => {
      if (cancelled) {
        return;
      }
      const presentedFrames = Number.isFinite(metadata?.presentedFrames)
        ? Number(metadata.presentedFrames)
        : null;
      if (presentedFrames !== null && presentedFrames === lastPresentedFrames) {
        callbackId = requestFrame(drawFocus);
        return;
      }
      const canvas = focusDisplayCanvasRef.current;
      if (!canvas || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        callbackId = requestFrame(drawFocus);
        return;
      }
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      if (cachedCanvas !== canvas) {
        cachedCanvas = canvas;
        cachedContext = canvas.getContext('2d');
      }
      if (!cachedContext) {
        onProjectionError?.('remote window focus canvas 2D context is unavailable');
        return;
      }
      try {
        cachedContext.drawImage(video, 0, 0, canvas.width, canvas.height);
        lastPresentedFrames = presentedFrames;
      } catch (error) {
        onProjectionError?.(error instanceof Error ? error.message : 'remote window focus canvas draw failed');
        return;
      }
      callbackId = requestFrame(drawFocus);
    };
    callbackId = requestFrame(drawFocus);
    return () => {
      cancelled = true;
      if (callbackId !== null) {
        video.cancelVideoFrameCallback?.(callbackId);
      }
    };
  }, [focusDisplayCanvasRef, onProjectionError, receiverMediaStream, videoElementRef]);

  useEffect(() => {
    if (!layout || !receiverMediaStream || !overviewMediaStream) {
      return;
    }
    const video = overviewVideoElementRef.current;
    if (!video) {
      return;
    }
    if (typeof video.requestVideoFrameCallback !== 'function') {
      onProjectionError?.('remote window overview decoded-frame callback is unavailable');
      return;
    }
    let cancelled = false;
    let callbackId: number | null = null;
    let lastPresentedFrames: number | null = null;
    let overviewContext: CanvasRenderingContext2D | null = null;
    let overviewContextCanvas: HTMLCanvasElement | null = null;
    const thumbnailContexts = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();
    const requestFrame = video.requestVideoFrameCallback.bind(video);
    const draw = (_now: number, metadata: { presentedFrames?: number }) => {
      if (cancelled) {
        return;
      }
      const presentedFrames = Number.isFinite(metadata?.presentedFrames)
        ? Number(metadata.presentedFrames)
        : null;
      if (presentedFrames !== null && presentedFrames === lastPresentedFrames) {
        callbackId = requestFrame(draw);
        return;
      }
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        callbackId = requestFrame(draw);
        return;
      }
      try {
        const overview = overviewCanvasRef.current;
        if (overview) {
          if (overviewContextCanvas !== overview) {
            overviewContextCanvas = overview;
            overviewContext = overview.getContext('2d');
          }
          if (!overviewContext) {
            onProjectionError?.('remote window overview canvas 2D context is unavailable');
            return;
          }
          if (overview.width > 0 && overview.height > 0) {
            overviewContext.clearRect(0, 0, overview.width, overview.height);
            const source = focusedWindow && overviewCropVisible
              ? focusedWindow
              : { offsetX: 0, offsetY: 0, width: layout.canvasWidth, height: layout.canvasHeight };
            overviewContext.drawImage(
              video,
              source.offsetX,
              source.offsetY,
              source.width,
              source.height,
              0,
              0,
              overview.width,
              overview.height,
            );
          }
        }
        for (const windowSlot of layout.windows) {
          const thumbnail = thumbnailCanvasRefs.current.get(windowSlot.windowId);
          if (!thumbnail || thumbnail.width <= 0 || thumbnail.height <= 0) {
            continue;
          }
          const context = thumbnailContexts.get(thumbnail) ?? thumbnail.getContext('2d');
          if (!context) {
            onProjectionError?.('remote window thumbnail canvas 2D context is unavailable');
            return;
          }
          thumbnailContexts.set(thumbnail, context);
          context.clearRect(0, 0, thumbnail.width, thumbnail.height);
          const scale = Math.min(
            thumbnail.width / Math.max(1, windowSlot.width),
            thumbnail.height / Math.max(1, windowSlot.height),
          );
          const drawWidth = windowSlot.width * scale;
          const drawHeight = windowSlot.height * scale;
          context.drawImage(
            video,
            windowSlot.offsetX,
            windowSlot.offsetY,
            windowSlot.width,
            windowSlot.height,
            (thumbnail.width - drawWidth) / 2,
            (thumbnail.height - drawHeight) / 2,
            drawWidth,
            drawHeight,
          );
        }
      } catch (error) {
        onProjectionError?.(error instanceof Error ? error.message : 'remote window overview canvas draw failed');
        return;
      }
      lastPresentedFrames = presentedFrames;
      callbackId = requestFrame(draw);
    };
    callbackId = requestFrame(draw);
    return () => {
      cancelled = true;
      if (callbackId !== null) {
        video.cancelVideoFrameCallback?.(callbackId);
      }
    };
  }, [
    focusedWindow,
    layout,
    onProjectionError,
    overviewCanvasRef,
    overviewCropVisible,
    overviewMediaStream,
    overviewVideoElementRef,
    receiverMediaStream,
    thumbnailCanvasRefs,
  ]);
}
