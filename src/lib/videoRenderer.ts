import { BackgroundConfig, VideoSegment, ZoomKeyframe } from '@/types/video';

export interface RenderContext {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  tempCanvas: HTMLCanvasElement;
  segment: VideoSegment;
  backgroundConfig: BackgroundConfig;
  currentTime: number;
}

export interface RenderOptions {
  exportMode?: boolean;
  highQuality?: boolean;
}

export class VideoRenderer {
  private animationFrame: number | null = null;
  private isDrawing: boolean = false;
  private lastDrawTime: number = 0;
  private readonly FRAME_INTERVAL = 1000 / 120; // Increase to 120fps for smoother animation
  private backgroundConfig: BackgroundConfig | null = null;

  private readonly DEFAULT_STATE: ZoomKeyframe = {
    time: 0,
    duration: 0,
    zoomFactor: 1,
    positionX: 0.5,
    positionY: 0.5,
    easingType: 'linear' as const
  };

  constructor() {
    // Empty constructor
  }

  public startAnimation(renderContext: RenderContext) {
    console.log('[VideoRenderer] Starting animation');
    this.stopAnimation();
    this.lastDrawTime = 0;

    const animate = () => {
      // Only animate if video is playing
      if (renderContext.video.paused) {
        this.animationFrame = requestAnimationFrame(animate);
        return;
      }

      const now = performance.now();
      const elapsed = now - this.lastDrawTime;

      if (this.lastDrawTime === 0 || elapsed >= this.FRAME_INTERVAL) {
        this.drawFrame(renderContext)
          .catch(err => console.error('[VideoRenderer] Draw error:', err));
        this.lastDrawTime = now;
      }

      this.animationFrame = requestAnimationFrame(animate);
    };

    this.animationFrame = requestAnimationFrame(animate);
  }

  public stopAnimation() {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
      this.lastDrawTime = 0; // Reset timing when stopping
    }
  }

  public drawFrame = async (
    context: RenderContext,
    options: RenderOptions = {}
  ): Promise<void> => {
    if (this.isDrawing) return;
    
    const { video, canvas, tempCanvas, segment, backgroundConfig } = context;
    if (!video || !canvas || !segment) return;

    // Store original canvas dimensions
    const targetWidth = canvas.width;
    const targetHeight = canvas.height;

    // For export mode, ensure we're using consistent dimensions
    const isExportMode = options.exportMode || false;
    if (isExportMode) {
      // Don't resize during export - maintain the canvas dimensions as set by the exporter
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
    } else {
      // For preview, temporarily set canvas to video dimensions
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      tempCanvas.width = video.videoWidth;
      tempCanvas.height = video.videoHeight;
    }

    const useHighQuality = options.highQuality || isExportMode; // Always use high quality for export
    const quality = useHighQuality ? 'high' : 'medium';
    
    const ctx = canvas.getContext('2d', {
        alpha: false,
        willReadFrequently: isExportMode, // Enable for export mode since we'll read pixels
        desynchronized: !useHighQuality // Disable desynchronized for high quality
    });
    if (!ctx) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = quality;
    this.isDrawing = true;
    const drawStart = performance.now();

    try {
        // Calculate dimensions once
        const scale = backgroundConfig.scale / 100;
        const scaledWidth = canvas.width * scale;
        const scaledHeight = canvas.height * scale;
        const x = (canvas.width - scaledWidth) / 2;
        const y = (canvas.height - scaledHeight) / 2;

        ctx.save();
        
        // Draw background - simplified to just use a solid color
        ctx.fillStyle = '#000000'; // Simple black background
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Setup temporary canvas for rounded corners and shadows
        const tempCtx = tempCanvas.getContext('2d', {
            alpha: true,
            willReadFrequently: isExportMode,
            desynchronized: !useHighQuality // Disable desynchronized for high quality
        });
        if (!tempCtx) return;

        // Clear temp canvas
        tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
        
        // Draw video frame with rounded corners to temp canvas
        tempCtx.save();
        
        // Improve anti-aliasing
        tempCtx.imageSmoothingEnabled = true;
        tempCtx.imageSmoothingQuality = quality;

        // For export mode, use additional optimizations
        if (isExportMode) {
          // Use a more precise rendering approach for export
          tempCtx.imageSmoothingQuality = 'high';
          // Force a full redraw for consistency
          tempCtx.globalCompositeOperation = 'source-over';
        }

        // Create path for the rounded rectangle
        const radius = backgroundConfig.borderRadius;
        const offset = 0.5;

        // Draw shadow first if enabled
        if (backgroundConfig.shadow) {
            tempCtx.save();
            
            // Set shadow properties
            tempCtx.shadowColor = 'rgba(0, 0, 0, 0.5)';
            tempCtx.shadowBlur = backgroundConfig.shadow;
            tempCtx.shadowOffsetY = backgroundConfig.shadow * 0.5;
            
            // Create the rounded rectangle path
            tempCtx.beginPath();
            tempCtx.moveTo(x + radius + offset, y + offset);
            tempCtx.lineTo(x + scaledWidth - radius - offset, y + offset);
            tempCtx.quadraticCurveTo(x + scaledWidth - offset, y + offset, x + scaledWidth - offset, y + radius + offset);
            tempCtx.lineTo(x + scaledWidth - offset, y + scaledHeight - radius - offset);
            tempCtx.quadraticCurveTo(x + scaledWidth - offset, y + scaledHeight - offset, x + scaledWidth - radius - offset, y + scaledHeight - offset);
            tempCtx.lineTo(x + radius + offset, y + scaledHeight - offset);
            tempCtx.quadraticCurveTo(x + offset, y + scaledHeight - offset, x + offset, y + scaledHeight - radius - offset);
            tempCtx.lineTo(x + offset, y + radius + offset);
            tempCtx.quadraticCurveTo(x + offset, y + offset, x + radius + offset, y + offset);
            tempCtx.closePath();
            
            // Fill with white to create shadow
            tempCtx.fillStyle = '#fff';
            tempCtx.fill();
            
            tempCtx.restore();
        }

        // Now draw the actual video content
        tempCtx.beginPath();
        tempCtx.moveTo(x + radius + offset, y + offset);
        tempCtx.lineTo(x + scaledWidth - radius - offset, y + offset);
        tempCtx.quadraticCurveTo(x + scaledWidth - offset, y + offset, x + scaledWidth - offset, y + radius + offset);
        tempCtx.lineTo(x + scaledWidth - offset, y + scaledHeight - radius - offset);
        tempCtx.quadraticCurveTo(x + scaledWidth - offset, y + scaledHeight - offset, x + scaledWidth - radius - offset, y + scaledHeight - offset);
        tempCtx.lineTo(x + radius + offset, y + scaledHeight - offset);
        tempCtx.quadraticCurveTo(x + offset, y + scaledHeight - offset, x + offset, y + scaledHeight - radius - offset);
        tempCtx.lineTo(x + offset, y + radius + offset);
        tempCtx.quadraticCurveTo(x + offset, y + offset, x + radius + offset, y + offset);
        tempCtx.closePath();

        // Clip and draw the video
        tempCtx.clip();
        
        // Always use the more precise drawing method for consistency
        // Lock dimensions to avoid fractional pixels
        const sx = Math.round(0);
        const sy = Math.round(0);
        const sWidth = Math.round(video.videoWidth);
        const sHeight = Math.round(video.videoHeight);
        const dx = Math.round(x);
        const dy = Math.round(y);
        const dWidth = Math.round(scaledWidth);
        const dHeight = Math.round(scaledHeight);
        
        // Use the more explicit drawImage signature for better control
        tempCtx.drawImage(video, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);

        // Add a subtle border to smooth out edges
        tempCtx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
        tempCtx.lineWidth = 1;
        tempCtx.stroke();

        tempCtx.restore();

        // Composite temp canvas onto main canvas
        ctx.drawImage(tempCanvas, 0, 0);

        const totalTime = performance.now() - drawStart;
        if (totalTime > 16 && !isExportMode) { // Don't log during export to reduce console spam
            console.log('[VideoRenderer] Slow frame render:', {
                totalTime: `${totalTime.toFixed(2)}ms`
            });
        }

        this.backgroundConfig = context.backgroundConfig;

    } finally {
        this.isDrawing = false;
        ctx.restore();

        // If we're not in export mode, restore original canvas size with proper scaling
        if (!isExportMode && (targetWidth !== video.videoWidth || targetHeight !== video.videoHeight)) {
            // For preview, restore original canvas size with proper scaling
            const previewCanvas = document.createElement('canvas');
            previewCanvas.width = targetWidth;
            previewCanvas.height = targetHeight;
            const previewCtx = previewCanvas.getContext('2d', {
                alpha: false,
                willReadFrequently: false
            });
            
            if (previewCtx) {
                previewCtx.imageSmoothingEnabled = true;
                previewCtx.imageSmoothingQuality = 'high';
                previewCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
                
                canvas.width = targetWidth;
                canvas.height = targetHeight;
                ctx?.drawImage(previewCanvas, 0, 0);
                previewCanvas.remove(); // Clean up
            }
        }
    }
  };
}

// Create and export a singleton instance
export const videoRenderer = new VideoRenderer(); 