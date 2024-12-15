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
}

export class VideoExporter {
  private isExporting = false;

  private setupMediaRecorder(stream: MediaStream): MediaRecorder {
    const supportedMimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') 
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm;codecs=vp8,opus';

    return new MediaRecorder(stream, {
      mimeType: supportedMimeType,
      videoBitsPerSecond: 8000000
    });
  }

  async exportVideo(options: ExportOptions): Promise<Blob> {
    if (this.isExporting) {
      console.log('[VideoExporter] Already exporting, ignoring request');
      return Promise.reject('Export already in progress');
    }

    console.log('[VideoExporter] Starting export process');
    this.isExporting = true;

    const { video, canvas, segment, onProgress } = options;
    
    // Store original video state
    const originalTime = video.currentTime;
    const originalPaused = video.paused;
    
    const stream = canvas.captureStream(60);
    const mediaRecorder = this.setupMediaRecorder(stream);
    const chunks: Blob[] = [];
    let timeUpdateHandler: ((e: Event) => void) | null = null;

    try {
      // Start recording
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.start(1000);

      // Set video to start position
      video.currentTime = segment.trimStart;
      await video.play();

      // Wait for video completion
      await new Promise<void>((resolve, reject) => {
        timeUpdateHandler = (e) => {
          // Calculate progress
          const currentProgress = (video.currentTime - segment.trimStart) / (segment.trimEnd - segment.trimStart) * 100;
          
          // Check if we're at or very close to the end
          const isAtEnd = Math.abs(video.currentTime - segment.trimEnd) < 0.1;
          
          console.log('[VideoExporter] Progress:', {
            currentTime: video.currentTime,
            trimEnd: segment.trimEnd,
            progress: currentProgress,
            isAtEnd
          });

          // Report progress, ensuring we hit 100% at the end
          onProgress?.(isAtEnd ? 100 : Math.min(currentProgress, 99.9));

          const renderContext = {
            video,
            canvas,
            tempCanvas: options.tempCanvas,
            segment,
            backgroundConfig: options.backgroundConfig,
            mousePositions: options.mousePositions,
            currentTime: video.currentTime
          };

          videoRenderer.drawFrame(renderContext, { exportMode: true });

          // Stop when we're close enough to the end
          if (isAtEnd) {
            console.log('[VideoExporter] Reached end of trim range');
            if (timeUpdateHandler) {
              video.removeEventListener('timeupdate', timeUpdateHandler);
              timeUpdateHandler = null;
            }
            video.pause();
            mediaRecorder.stop();
            resolve();
          }
        };

        video.addEventListener('timeupdate', timeUpdateHandler);
        video.addEventListener('error', reject);
      });

      // Get the final blob
      const finalBlob = await new Promise<Blob>((resolve, reject) => {
        mediaRecorder.onstop = () => {
          try {
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
            resolve(blob);
          } catch (error) {
            reject(error);
          }
        };
      });

      return finalBlob;

    } catch (error) {
      console.error('[VideoExporter] Export failed:', error);
      throw error;
    } finally {
      // Clean up everything
      if (timeUpdateHandler) {
        video.removeEventListener('timeupdate', timeUpdateHandler);
      }
      stream.getTracks().forEach(track => track.stop());
      this.isExporting = false;
      video.currentTime = originalTime;
      if (originalPaused) video.pause();
    }
  }

  async exportAndDownload(options: ExportOptions): Promise<void> {
    try {
      console.log('[VideoExporter] Starting export and download');
      const blob = await this.exportVideo(options);
      
      console.log('[VideoExporter] Export complete, creating download');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `processed_video_${Date.now()}.webm`;
      a.click();

      console.log('[VideoExporter] Download triggered');
      // Wait a bit before cleaning up URL to ensure download starts
      await new Promise(resolve => setTimeout(resolve, 1000));
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error('[VideoExporter] Download failed:', error);
      throw error;
    }
  }
}

export const videoExporter = new VideoExporter(); 