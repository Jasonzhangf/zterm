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
  videoElementRef: RefObject<HTMLVideoElement | null>;
  overviewVideoElementRef: RefObject<HTMLVideoElement | null>;
  overviewCanvasRef: RefObject<HTMLCanvasElement | null>;
  focusDisplayCanvasRef?: RefObject<HTMLCanvasElement | null>;
  thumbnailCanvasRefs: RefObject<Map<string, HTMLCanvasElement | null>>;
}

export function useRemoteWindowCompositeCanvas({
  layout,
  focusedWindow,
  overviewCropVisible,
  receiverMediaStream,
  videoElementRef,
  overviewVideoElementRef,
  overviewCanvasRef,
  focusDisplayCanvasRef,
  thumbnailCanvasRefs,
}: UseRemoteWindowCompositeCanvasOptions) {
  // Android WebView hardware compositor does not render WebRTC MediaStream
  // <video> to the screen (readyState=4 + play() resolved still shows black).
  // This rAF loop copies decoded video frames to a visible canvas instead.
  useEffect(() => {
    if (!receiverMediaStream || !focusDisplayCanvasRef) {
      return;
    }
    let animationFrame = 0;
    const drawFocus = () => {
      animationFrame = window.requestAnimationFrame(drawFocus);
      const video = videoElementRef.current;
      const canvas = focusDisplayCanvasRef.current;
      if (!video || !canvas || video.readyState < 2 || video.videoWidth <= 0) {
        return;
      }
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const context = canvas.getContext('2d');
      context?.drawImage(video, 0, 0, canvas.width, canvas.height);
    };
    animationFrame = window.requestAnimationFrame(drawFocus);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusDisplayCanvasRef, receiverMediaStream, videoElementRef]);

  useEffect(() => {
    if (!layout || !receiverMediaStream) {
      return;
    }
    let animationFrame = 0;
    const draw = () => {
      animationFrame = window.requestAnimationFrame(draw);
      const overviewVideo = overviewVideoElementRef.current;
      const video = overviewVideo && overviewVideo.readyState >= 2
        ? overviewVideo
        : videoElementRef.current;
      if (!video || video.readyState < 2 || video.videoWidth <= 0) {
        return;
      }
      const overview = overviewCanvasRef.current;
      if (overview) {
        const context = overview.getContext('2d');
        if (context && overview.width > 0 && overview.height > 0) {
          context.drawImage(
            video,
            0,
            0,
            layout.canvasWidth,
            layout.canvasHeight,
            0,
            0,
            overview.width,
            overview.height,
          );
        }
      }
      if (overview && focusedWindow && overviewCropVisible) {
        const context = overview.getContext('2d');
        if (context && overview.width > 0 && overview.height > 0) {
          context.clearRect(0, 0, overview.width, overview.height);
          context.drawImage(
            video,
            focusedWindow.offsetX,
            focusedWindow.offsetY,
            focusedWindow.width,
            focusedWindow.height,
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
        const context = thumbnail.getContext('2d');
        if (!context) {
          continue;
        }
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
    };
    animationFrame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    focusedWindow,
    layout,
    overviewCanvasRef,
    overviewCropVisible,
    overviewVideoElementRef,
    receiverMediaStream,
    thumbnailCanvasRefs,
    videoElementRef,
  ]);
}
