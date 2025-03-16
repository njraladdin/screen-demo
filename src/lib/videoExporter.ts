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

  private setupMediaRecorder(stream: MediaStream, quality: ExportQuality): MediaRecorder {
    // Prioritize MP4 formats over WebM for compatibility
    const mimeTypes = [
      'video/mp4;codecs=h264',         // H.264 MP4 - most compatible
      'video/mp4',                      // Default MP4
      'video/webm;codecs=h264',         // WebM with H.264
      'video/webm;codecs=vp9',          // VP9 fallback
      'video/webm'                      // Default WebM as last resort
    ];

    let selectedMimeType = '';
    for (const mimeType of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        selectedMimeType = mimeType;
        console.log(`[VideoExporter] Found supported MIME type: ${mimeType}`);
        break;
      }
    }

    if (!selectedMimeType) {
      console.warn('[VideoExporter] No supported video MIME types found, falling back to default');
    }

    // Increase bitrate based on quality setting and ensure it's high enough for smooth video
    const qualityPreset = EXPORT_PRESETS[quality];
    const baseBitrate = qualityPreset.bitrate;
    
    // Adjust bitrate based on video dimensions - higher resolution needs higher bitrate
    const videoTrack = stream.getVideoTracks()[0];
    const settings = videoTrack.getSettings();
    const videoWidth = settings.width || 1920;
    const videoHeight = settings.height || 1080;
    const pixelCount = videoWidth * videoHeight;
    const resolutionFactor = Math.max(1, pixelCount / (1920 * 1080)); // Compared to 1080p
    
    // Scale bitrate according to resolution, with a higher base for better quality
    const scaledBitrate = Math.round(baseBitrate * Math.sqrt(resolutionFactor) * 1.25);
    
    console.log(`[VideoExporter] Using bitrate: ${scaledBitrate} for resolution: ${videoWidth}x${videoHeight}`);
    
    const options = {
      videoBitsPerSecond: scaledBitrate,
      mimeType: selectedMimeType || 'video/mp4',
      videoConstraints: {
        frameRate: 60,
        width: { ideal: videoWidth },
        height: { ideal: videoHeight }
      }
    };

    console.log('[VideoExporter] Using MIME type:', options.mimeType, 'with bitrate:', options.videoBitsPerSecond);
    const mediaRecorder = new MediaRecorder(stream, options);
    
    // Force keyframe insertion - less frequent for more consistent encoding (500ms instead of 250ms)
    // This helps reduce micro-stutters between keyframes
    const keyframeInterval = setInterval(() => {
      if (mediaRecorder.state === 'recording') {
        // @ts-ignore - forceKeyframe is a non-standard but widely supported feature
        if (mediaRecorder.requestData) mediaRecorder.requestData();
      }
    }, 500);

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
  }): Promise<Blob> {
    if (this.isExporting) {
      return Promise.reject('Export already in progress');
    }

    console.log('[VideoExporter] Starting export with options:', {
      trimStart: options.segment.trimStart,
      trimEnd: options.segment.trimEnd,
      videoDuration: options.video.duration,
      videoWidth: options.video.videoWidth,
      videoHeight: options.video.videoHeight
    });

    this.isExporting = true;
    const { video, canvas, tempCanvas, segment } = options;
    
    // Store original video state
    const originalTime = video.currentTime;
    const originalPaused = video.paused;

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

    try {
      // COMPLETELY NEW APPROACH: Capture frames to an array first, then encode
      // This avoids the issues with MediaRecorder and streaming
      
      // Set up the export canvas with the correct dimensions
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      
      // Create a high-quality context
      const ctx = canvas.getContext('2d', {
        alpha: false,
        desynchronized: false,
        willReadFrequently: true, // We'll be reading pixel data
      }) as CanvasRenderingContext2D | null;
      
      if (!ctx) {
        throw new Error('Failed to get canvas context');
      }
      
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      
      // Ensure video is fully loaded before starting
      if (video.readyState < 4) {
        console.log('[VideoExporter] Waiting for video to fully load...');
        await new Promise<void>(resolve => {
          function checkReadyState() {
            if (video.readyState >= 4) {
              console.log('[VideoExporter] Video fully loaded');
              resolve();
            } else {
              console.log(`[VideoExporter] Waiting for video to load: readyState=${video.readyState}`);
              setTimeout(checkReadyState, 200);
            }
          }
          
          checkReadyState();
          
          const canPlayHandler = () => {
            console.log('[VideoExporter] Video can play through');
            video.removeEventListener('canplaythrough', canPlayHandler);
            resolve();
          };
          video.addEventListener('canplaythrough', canPlayHandler);
        });
      }
      
      // Calculate frame parameters
      const FPS = 30; // Use 30fps for better performance and quality balance
      const totalDuration = segment.trimEnd - segment.trimStart;
      
      // Remove speed adjustment
      const frameCount = Math.ceil(totalDuration * FPS);
      
      console.log(`[VideoExporter] Capturing ${frameCount} frames at ${FPS}fps for ${totalDuration.toFixed(2)}s duration`);
      
      // Array to store frame data
      const frames: Blob[] = [];
      
      // Capture each frame
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        // Calculate the exact time in the video for this frame
        // No speed adjustment needed
        const frameTime = segment.trimStart + (frameIndex / FPS);
        
        // Skip past the end
        if (frameTime >= segment.trimEnd) {
          console.log('[VideoExporter] Reached end of segment');
          break;
        }
        
        // Seek to exact frame time
        video.currentTime = frameTime;
        
        // Wait for seeking to complete
        await new Promise<void>(resolve => {
          const seekHandler = () => {
            video.removeEventListener('seeked', seekHandler);
            resolve();
          };
          video.addEventListener('seeked', seekHandler);
          
          // Failsafe timeout
          setTimeout(() => {
            video.removeEventListener('seeked', seekHandler);
            resolve();
          }, 100);
        });
        
        // Render this frame with high quality settings
        const renderContext = {
          video,
          canvas,
          tempCanvas,
          segment,
          backgroundConfig: options.backgroundConfig,
          mousePositions: options.mousePositions,
          currentTime: frameTime
        };
        
        // Draw the frame in high quality mode
        await videoRenderer.drawFrame(renderContext, {
          exportMode: true,
          highQuality: true
        });
        
        // Capture the frame as a high-quality JPEG (better compression than PNG)
        const frameBlob = await new Promise<Blob>(resolve => {
          canvas.toBlob(blob => {
            resolve(blob || new Blob());
          }, 'image/jpeg', 0.95); // Use high quality but not maximum to save space
        });
        
        frames.push(frameBlob);
        
        // Update progress
        const progress = (frameIndex / frameCount) * 100;
        options.onProgress?.(Math.min(progress, 99.9));
        
        // Log progress periodically
        if (frameIndex % 30 === 0 || frameIndex === frameCount - 1) {
          console.log(`[VideoExporter] Captured frame ${frameIndex + 1}/${frameCount} (${progress.toFixed(1)}%)`);
        }
      }
      
      console.log(`[VideoExporter] Captured ${frames.length} frames, creating video...`);
      
      // SIMPLIFIED APPROACH: Use WebM Writer directly
      // This gives us more control over the output video
      
      // Create a WebM video using the frames
      // We'll use a simple approach that works reliably
      
      // Set quality based on options
      const quality = options.quality || 'balanced';
      const bitrate = EXPORT_PRESETS[quality].bitrate;
      
      // Find the best supported codec
      const mimeTypes = [
        'video/mp4;codecs=h264',
        'video/webm;codecs=h264',
        'video/webm;codecs=vp9',
        'video/webm'
      ];
      
      let selectedMimeType = '';
      for (const mimeType of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          selectedMimeType = mimeType;
          console.log(`[VideoExporter] Using codec: ${mimeType}`);
          break;
        }
      }
      
      if (!selectedMimeType) {
        selectedMimeType = 'video/webm';
        console.warn('[VideoExporter] No preferred codec supported, using default webm');
      }
      
      // Create a temporary video element to play back our frames
      const tempVideo = document.createElement('video');
      tempVideo.autoplay = false;
      tempVideo.controls = false;
      tempVideo.muted = true;
      tempVideo.width = outputWidth;
      tempVideo.height = outputHeight;
      
      // Create a MediaRecorder to capture the video playback
      const tempCanvas2 = document.createElement('canvas');
      tempCanvas2.width = outputWidth;
      tempCanvas2.height = outputHeight;
      const tempCtx = tempCanvas2.getContext('2d');
      
      if (!tempCtx) {
        throw new Error('Failed to get temporary canvas context');
      }
      
      // Create a stream from the canvas
      const stream = tempCanvas2.captureStream(FPS);
      
      // Create a MediaRecorder with the stream
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: selectedMimeType,
        videoBitsPerSecond: bitrate
      });
      
      const chunks: Blob[] = [];
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      
      // Start recording
      mediaRecorder.start();
      
      // Function to draw a frame to the canvas
      const drawFrame = (frameIndex: number) => {
        return new Promise<void>((resolve) => {
          if (frameIndex >= frames.length) {
            resolve();
            return;
          }
          
          const img = new Image();
          const frameUrl = URL.createObjectURL(frames[frameIndex]);
          
          img.onload = () => {
            tempCtx.drawImage(img, 0, 0, outputWidth, outputHeight);
            URL.revokeObjectURL(frameUrl);
            
            // Request a frame from the stream
            const videoTrack = stream.getVideoTracks()[0];
            // @ts-ignore
            if (videoTrack.requestFrame) {
              // @ts-ignore
              videoTrack.requestFrame();
            }
            
            // Update progress
            const progress = 90 + (frameIndex / frames.length) * 10;
            options.onProgress?.(Math.min(progress, 99.9));
            
            // Wait for the next frame time
            setTimeout(() => {
              resolve();
            }, 1000 / FPS); // Exact frame timing
          };
          
          img.src = frameUrl;
        });
      };
      
      // Draw all frames sequentially
      for (let i = 0; i < frames.length; i++) {
        await drawFrame(i);
      }
      
      // Stop recording after all frames are processed
      mediaRecorder.stop();
      
      // Wait for the recording to complete
      const finalBlob = await new Promise<Blob>((resolve) => {
        mediaRecorder.onstop = () => {
          const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
          resolve(blob);
        };
      });
      
      console.log('[VideoExporter] Export completed successfully', {
        size: finalBlob.size,
        type: finalBlob.type,
        frames: frames.length,
        duration: `${totalDuration.toFixed(2)}s`
      });
      
      // Clean up
      frames.length = 0;
      tempVideo.remove();
      tempCanvas2.remove();
      
      return finalBlob;
    } catch (error) {
      console.error('[VideoExporter] Export failed:', error);
      throw error;
    } finally {
      this.isExporting = false;

      // Restore video state
      video.currentTime = originalTime;
      if (originalPaused) video.pause();
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
        mousePositions: options.mousePositions || []
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