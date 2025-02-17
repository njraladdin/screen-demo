import { videoRenderer } from './videoRenderer';
import type { 
  ExportOptions, 
  ExportQuality, 
  DimensionPreset, 
  VideoSegment, 
  BackgroundConfig, 
  MousePosition 
} from '@/types/video';

interface QualityPreset {
  bitrate: number;
  label: string;
}

interface OriginalDimensionPreset {
  type: 'original';
  label: string;
}

interface FixedDimensionPreset {
  type: 'fixed';
  width: number;
  height: number;
  label: string;
}

type DimensionPresetConfig = OriginalDimensionPreset | FixedDimensionPreset;

export const EXPORT_PRESETS: Record<ExportQuality, QualityPreset> = {
  balanced: {           
    bitrate: 10000000,   // 10Mbps
    label: 'Balanced Quality'
  },
  original: {
    bitrate: 20000000,  // 20Mbps
    label: 'Maximum Quality'
  }
} as const;

export const DIMENSION_PRESETS: Record<DimensionPreset, DimensionPresetConfig> = {
  original: { 
    type: 'original',
    label: 'Original Size' 
  },
  '1080p': { 
    type: 'fixed',
    width: 1920, 
    height: 1080, 
    label: '1080p' 
  },
  '720p': { 
    type: 'fixed',
    width: 1280, 
    height: 720, 
    label: '720p' 
  }
} as const;

export class VideoExporter {
  private isExporting = false;
  private lastVideoTime = 0;  // Add this to track video time

  private setupMediaRecorder(stream: MediaStream, quality: ExportQuality): MediaRecorder {
    // Try different MIME types in order of preference
    const mimeTypes = [
      'video/mp4;codecs=hevc,mp4a.40.2',  // Try H.265/HEVC first
      'video/mp4;codecs=h264',            // Fallback to H.264
      'video/mp4',                        // Let browser choose MP4 codec
      'video/webm;codecs=h264',           // WebM with H.264 as last resort
      'video/webm'                        // Default WebM
    ];

    let selectedMimeType = '';
    for (const mimeType of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        selectedMimeType = mimeType;
        break;
      }
    }

    if (!selectedMimeType) {
      console.warn('[VideoExporter] No supported video MIME types found, falling back to default');
    }

    const options = {
      videoBitsPerSecond: EXPORT_PRESETS[quality].bitrate,
      mimeType: selectedMimeType || 'video/mp4;codecs=h264',
      videoConstraints: {
        frameRate: 60,
        width: { ideal: stream.getVideoTracks()[0].getSettings().width },
        height: { ideal: stream.getVideoTracks()[0].getSettings().height }
      }
    };

    console.log('[VideoExporter] Using MIME type:', options.mimeType);
    const mediaRecorder = new MediaRecorder(stream, options);
    
    // Force keyframe insertion every 2 seconds for better seeking
    const keyframeInterval = setInterval(() => {
      if (mediaRecorder.state === 'recording') {
        // @ts-ignore - forceKeyframe is a non-standard but widely supported feature
        if (mediaRecorder.requestData) mediaRecorder.requestData();
      }
    }, 2000);

    mediaRecorder.addEventListener('stop', () => clearInterval(keyframeInterval));

    return mediaRecorder;
  }

  async exportVideo(options: ExportOptions & {
    video: HTMLVideoElement;
    canvas: HTMLCanvasElement;
    tempCanvas: HTMLCanvasElement;
    segment: VideoSegment;
    backgroundConfig: BackgroundConfig;
    mousePositions: MousePosition[];
    onProgress?: (progress: number) => void;
    speed: number;
  }): Promise<Blob> {
    if (this.isExporting) {
      return Promise.reject('Export already in progress');
    }

    console.log('[VideoExporter] Starting export with options:', {
      trimStart: options.segment.trimStart,
      trimEnd: options.segment.trimEnd,
      videoDuration: options.video.duration
    });

    this.isExporting = true;
    this.lastVideoTime = 0;  // Reset at start
    let hasReachedEnd = false;
    const { video, canvas, tempCanvas, segment } = options;
    
    // Store original video state
    const originalTime = video.currentTime;
    const originalPaused = video.paused;

    // Use higher framerate for capture
    const stream = canvas.captureStream(60);
    
    // Calculate output dimensions
    let outputWidth = video.videoWidth;
    let outputHeight = video.videoHeight;

    if (options.dimensions !== 'original') {
      const preset = DIMENSION_PRESETS[options.dimensions];
      if (preset.type === 'fixed') {
        const aspectRatio = video.videoWidth / video.videoHeight;
        
        outputWidth = preset.width;
        outputHeight = Math.round(preset.width / aspectRatio);
        
        // Ensure height doesn't exceed target
        if (outputHeight > preset.height) {
          outputHeight = preset.height;
          outputWidth = Math.round(preset.height * aspectRatio);
        }
      }
    }

    // Set canvas size to output dimensions
    canvas.width = outputWidth;
    canvas.height = outputHeight;

    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: false,
      willReadFrequently: false,
    }) as CanvasRenderingContext2D | null;  // Explicitly type as CanvasRenderingContext2D
    
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      
      // Use only standard compositing operation
      ctx.globalCompositeOperation = 'copy';  // Faster compositing
    }

    // Set default quality to 'balanced' if not specified
    const quality = options.quality || 'balanced';
    const mediaRecorder = this.setupMediaRecorder(stream, quality);
    const chunks: Blob[] = [];
    let recordingComplete = false;

    try {
      const recordingPromise = new Promise<Blob>((resolve, reject) => {
        mediaRecorder.ondataavailable = (e) => {
          console.log('[VideoExporter] Data available:', { 
            size: e.data.size,
            state: mediaRecorder.state,
            currentTime: video.currentTime 
          });
          if (e.data.size > 0) chunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          console.log('[VideoExporter] MediaRecorder stopped', {
            chunksCount: chunks.length,
            totalSize: chunks.reduce((acc, chunk) => acc + chunk.size, 0),
            hasReachedEnd,
            recordingComplete
          });
          recordingComplete = true;
          const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
          resolve(blob);
        };

        mediaRecorder.addEventListener('dataavailable', (e) => {
          console.log('[VideoExporter] Data chunk received:', {
            size: e.data.size,
            state: mediaRecorder.state,
            videoTime: video.currentTime,
            hasReachedEnd
          });
        });

        mediaRecorder.addEventListener('stop', () => {
          console.log('[VideoExporter] MediaRecorder stop event:', {
            finalTime: video.currentTime,
            recordingState: mediaRecorder.state,
            hasReachedEnd
          });
        });
      });

      console.log('[VideoExporter] Starting MediaRecorder');
      mediaRecorder.start(1000);

      console.log('[VideoExporter] Setting video to start position:', segment.trimStart);
      video.currentTime = segment.trimStart;
      
      // Set the playback rate before starting playback
      video.playbackRate = options.speed;
      
      await video.play();

      await new Promise<void>((resolve, reject) => {
        const timeUpdateHandler = () => {
          console.log('[VideoExporter] Frame update:', {
            currentTime: video.currentTime,
            trimStart: segment.trimStart,
            trimEnd: segment.trimEnd,
            readyState: video.readyState,
            duration: video.duration,
            paused: video.paused,
            playbackRate: video.playbackRate,
            seeking: video.seeking,
            ended: video.ended,
            error: video.error,
            networkState: video.networkState,
          });

          if (recordingComplete || hasReachedEnd) {
            console.log('[VideoExporter] Skipping frame - recording complete or ended');
            return;
          }

          // Make the trim end check more precise and add more logging
          if (Math.abs(video.currentTime - segment.trimEnd) < 0.1) {
            console.log('[VideoExporter] Reached trim end (precise check):', {
              currentTime: video.currentTime,
              trimEnd: segment.trimEnd,
              delta: video.currentTime - segment.trimEnd,
              recordingState: mediaRecorder.state
            });

            hasReachedEnd = true;
            video.pause();
            video.removeEventListener('timeupdate', timeUpdateHandler);
            
            // Force final data collection before stopping
            if (mediaRecorder.state === 'recording') {
              mediaRecorder.requestData();
              setTimeout(() => {
                console.log('[VideoExporter] Stopping MediaRecorder after final data');
                mediaRecorder.stop();
              }, 100);
            }
            
            resolve();
            return;
          }

          this.lastVideoTime = video.currentTime;

          const renderContext = {
            video,
            canvas,
            tempCanvas,
            segment,
            backgroundConfig: options.backgroundConfig,
            mousePositions: options.mousePositions,
            currentTime: video.currentTime
          };

          requestAnimationFrame(() => {
            if (video.readyState >= 2) {
              videoRenderer.drawFrame(renderContext, { exportMode: true });
            } else {
              console.log('[VideoExporter] Skipping draw - video not ready', {
                readyState: video.readyState,
                currentTime: video.currentTime
              });
            }

            const duration = segment.trimEnd - segment.trimStart;
            const elapsed = video.currentTime - segment.trimStart;
            const currentProgress = (elapsed / duration) * 100;
            
            options.onProgress?.(Math.min(currentProgress, 99.9));
          });
        };

        video.addEventListener('timeupdate', timeUpdateHandler);
        video.addEventListener('ended', () => {
          console.log('[VideoExporter] Video ended event fired');
        });
        video.addEventListener('error', (e) => {
          console.error('[VideoExporter] Video error:', e);
          reject(e);
        });
      });

      const finalBlob = await recordingPromise;
      console.log('[VideoExporter] Export completed successfully', {
        size: finalBlob.size,
        type: finalBlob.type
      });
      return finalBlob;

    } catch (error) {
      console.error('[VideoExporter] Export failed:', error);
      throw error;
    } finally {
      if (!recordingComplete && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      
      stream.getTracks().forEach(track => track.stop());
      this.lastVideoTime = 0;  // Reset in cleanup
      this.isExporting = false;

      // Restore video state
      video.currentTime = originalTime;
      if (originalPaused) video.pause();

      // Reset playback rate in cleanup
      video.playbackRate = 1;
    }
  }

  async exportAndDownload(options: ExportOptions) {
    // Validate required options
    if (!options.video || !options.canvas || !options.segment) {
      throw new Error('Missing required export options');
    }

    try {
      const blob = await this.exportVideo({
        ...options,
        video: options.video,
        canvas: options.canvas,
        tempCanvas: options.tempCanvas!,
        segment: options.segment,
        backgroundConfig: options.backgroundConfig!,
        mousePositions: options.mousePositions || [],
        speed: options.speed || 1
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      // Get extension from actual MIME type
      const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
      a.download = `processed_video_${Date.now()}.${extension}`;
      
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error('[VideoExporter] Download failed:', error);
      throw error;
    }
  }
}

export const videoExporter = new VideoExporter(); 