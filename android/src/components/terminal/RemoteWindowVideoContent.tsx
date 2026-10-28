import type { CSSProperties, RefObject } from 'react';
import ztermRemoteWindowLogoUrl from '../../../../assets/logo_engraved.png';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import { formatRemoteWindowStageLabel, formatTargetSubtitle } from './remote-window-overlay-helpers';
import { styles } from './remote-window-overlay-styles';

export interface RemoteWindowVideoContentProps {
  streamStarted: boolean;
  streamStatus: string;
  streamErrorMessage?: string | null;
  target: RemoteWindowStreamTargetManifest;
  receiverAttached: boolean;
  overviewCropVisible: boolean;
  videoHasPlayed: boolean;
  focusedVideoStyle: CSSProperties | null;
  overviewCanvasRef: RefObject<HTMLCanvasElement | null>;
  videoElementRef: RefObject<HTMLVideoElement | null>;
  overviewVideoElementRef: RefObject<HTMLVideoElement | null>;
  focusDisplayCanvasRef?: RefObject<HTMLCanvasElement | null>;
  onVideoLifecycle: (event: 'loadedmetadata' | 'loadeddata' | 'canplay') => void;
}

export function RemoteWindowVideoContent({
  streamStarted,
  streamStatus,
  streamErrorMessage,
  target,
  receiverAttached,
  overviewCropVisible,
  videoHasPlayed,
  focusedVideoStyle,
  overviewCanvasRef,
  videoElementRef,
  overviewVideoElementRef,
  focusDisplayCanvasRef,
  onVideoLifecycle,
}: RemoteWindowVideoContentProps) {
  const wallpaper = (
    <div
      data-testid="remote-window-video-wallpaper"
      aria-hidden="true"
      style={{
        ...styles.videoWallpaper,
        opacity: videoHasPlayed ? 0 : 1,
        transition: 'opacity 120ms ease-out',
      }}
    >
      <img data-testid="remote-window-video-wallpaper-logo" src={ztermRemoteWindowLogoUrl} alt="" style={styles.videoWallpaperLogo} />
    </div>
  );

  if (streamStarted && receiverAttached) {
    return (
      <>
        {wallpaper}
        {!videoHasPlayed ? (
          <div data-testid="remote-window-stage-status" style={{ ...styles.videoStatus, position: 'absolute', zIndex: 3 }}>
            {formatRemoteWindowStageLabel(streamStatus)}
          </div>
        ) : null}
        {overviewCropVisible ? (
          <canvas
            ref={overviewCanvasRef}
            data-testid="remote-window-overview-crop"
            width={1920}
            height={1080}
            style={{
              ...styles.videoElement,
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              objectPosition: '50% 50%',
              zIndex: 2,
              opacity: 1,
            }}
          />
        ) : focusDisplayCanvasRef ? (
          <canvas
            ref={focusDisplayCanvasRef}
            data-testid="remote-window-focus-display-canvas"
            width={1920}
            height={1080}
            style={{
              ...styles.videoElement,
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              objectPosition: '50% 50%',
              zIndex: 2,
              opacity: 1,
            }}
          />
        ) : null}
        <video
          data-testid="remote-window-video"
          ref={videoElementRef}
          autoPlay
          muted
          controls={false}
          disablePictureInPicture
          preload="auto"
          poster={ztermRemoteWindowLogoUrl}
          playsInline
          onLoadedMetadata={() => onVideoLifecycle('loadedmetadata')}
          onLoadedData={() => onVideoLifecycle('loadeddata')}
          onCanPlay={() => onVideoLifecycle('canplay')}
          style={{
            ...styles.videoElement,
            ...focusedVideoStyle,
            objectFit: 'contain',
            objectPosition: '50% 50%',
            // Android WebView hardware compositor does not render WebRTC
            // MediaStream <video> to the screen even when readyState=4 and
            // play() resolves. The focus display canvas draws the same frames
            // via drawImage, so the source video is kept at opacity 0 as the
            // decode surface only.
            opacity: 0,
            visibility: 'visible',
          }}
        />
        <video
          ref={overviewVideoElementRef}
          data-testid="remote-window-overview-video"
          autoPlay
          muted
          controls={false}
          disablePictureInPicture
          playsInline
          style={{ display: 'none' }}
        />
      </>
    );
  }

  if (streamStatus === 'starting') {
    return (
      <div style={styles.videoFrame}>
        {wallpaper}
        <div data-testid="remote-window-stage-status" style={styles.videoStatus}>
          {formatRemoteWindowStageLabel(streamStatus)}
        </div>
        <div style={styles.videoMeta}>{formatTargetSubtitle(target)}</div>
      </div>
    );
  }
  if (streamStatus === 'error') {
    return (
      <div data-testid="remote-window-stream-error" style={{ ...styles.videoFrame, ...styles.videoError }}>
        {wallpaper}
        <div style={styles.videoStatus}>{formatRemoteWindowStageLabel(streamStatus)}</div>
        <div style={styles.videoMeta}>{streamErrorMessage || 'remote window stream failed'}</div>
      </div>
    );
  }
  return (
    <div style={styles.videoFrame}>
      {wallpaper}
      <div data-testid="remote-window-stage-status" style={styles.videoStatus}>
        {formatRemoteWindowStageLabel(streamStatus)}
      </div>
      <div style={styles.videoMeta}>{formatTargetSubtitle(target)}</div>
    </div>
  );
}
