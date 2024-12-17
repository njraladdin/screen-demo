import { videoRenderer } from './videoRenderer';
import type { VideoSegment, BackgroundConfig, MousePosition } from '@/types/video';

interface ExportOptions {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  tempCanvas: HTMLCanvasElement;
  segment: VideoSegment;
  backgroundConfig: BackgroundConfig;
  mousePositions: MousePosition[];
  onProgress?: (progress: number) => void;
  format?: 'webm' | 'mp4';
}

export class VideoExporter {
  private isExporting = false;
  private lastProgress = 0;

  private setupMediaRecorder(stream: MediaStream): MediaRecorder {
    const options = {
      videoBitsPerSecond: 50000000, // Increase to 50 Mbps
      mimeType: 'video/webm;codecs=vp9' // Force VP9 for better quality
    };

    return new MediaRecorder(stream, options);
  }

  async exportVideo(options: ExportOptions): Promise<Blob> {
    if (this.isExporting) {
      return Promise.reject('Export already in progress');
    }

    this.isExporting = true;
    this.lastProgress = 0;
    const { video, canvas, tempCanvas, segment } = options;
    
    // Store original video state
    const originalTime = video.currentTime;
    const originalPaused = video.paused;

    // Use higher framerate for capture
    const stream = canvas.captureStream(60);
    
    // Force high quality canvas settings
    canvas.width = video.videoWidth;   // Match source resolution
    canvas.height = video.videoHeight;
    
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

    const mediaRecorder = this.setupMediaRecorder(stream);
    const chunks: Blob[] = [];
    let recordingComplete = false;

    try {
      // Create a promise that resolves when recording is complete
      const recordingPromise = new Promise<Blob>((resolve) => {
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          recordingComplete = true;
          const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
          resolve(blob);
        };
      });

      // Start recording
      mediaRecorder.start(1000);

      // Set video to start position
      video.currentTime = segment.trimStart;
      await video.play();

      // Wait for video completion
      await new Promise<void>((resolve, reject) => {
        const timeUpdateHandler = () => {
          if (recordingComplete) return;

          const renderContext = {
            video,
            canvas,
            tempCanvas,
            segment,
            backgroundConfig: options.backgroundConfig,
            mousePositions: options.mousePositions,
            currentTime: video.currentTime
          };

          // Simpler frame handling - just use requestAnimationFrame
          requestAnimationFrame(() => {
            if (video.readyState >= 2) {
              videoRenderer.drawFrame(renderContext, { exportMode: true });
            }

            const currentProgress = (video.currentTime - segment.trimStart) / (segment.trimEnd - segment.trimStart) * 100;
            
            if (currentProgress === 0 && this.lastProgress > 90) {
              console.log('[VideoExporter] Detected completion via progress drop', {
                lastProgress: this.lastProgress,
                currentProgress
              });
              video.removeEventListener('timeupdate', timeUpdateHandler);
              mediaRecorder.stop();
              resolve();
              return;
            }

            this.lastProgress = currentProgress;
            options.onProgress?.(Math.min(currentProgress, 99.9));

            if (recordingComplete) {
              video.removeEventListener('timeupdate', timeUpdateHandler);
              mediaRecorder.stop();
              resolve();
            }
          });
        };

        video.addEventListener('timeupdate', timeUpdateHandler);
        video.addEventListener('error', reject);
      });

      // Wait for the MediaRecorder to finish and get the final blob
      const finalBlob = await recordingPromise;

      // Only now pause the video and restore state
      video.pause();
      
      return finalBlob;

    } catch (error) {
      console.error('[VideoExporter] Export failed:', error);
      throw error;
    } finally {
      // Only cleanup after we're sure recording is complete
      if (!recordingComplete && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      
      stream.getTracks().forEach(track => track.stop());
      this.isExporting = false;

      // Restore video state
      video.currentTime = originalTime;
      if (originalPaused) video.pause();

      this.lastProgress = 0;
    }
  }

  async exportAndDownload(options: ExportOptions): Promise<void> {
    try {
      const blob = await this.exportVideo(options);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      // Get extension from actual MIME type
      const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
      a.download = `processed_video_${Date.now()}.${extension}`;
      
      a.click();
      await new Promise(resolve => setTimeout(resolve, 1000));
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('[VideoExporter] Download failed:', error);
      throw error;
    }
  }
}

export const videoExporter = new VideoExporter(); 