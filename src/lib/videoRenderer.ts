import { BackgroundConfig, MousePosition, VideoSegment, ZoomKeyframe } from '@/types/video';

export interface RenderContext {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  tempCanvas: HTMLCanvasElement;
  segment: VideoSegment;
  backgroundConfig: BackgroundConfig;
  mousePositions: MousePosition[];
  currentTime: number;
}

export interface RenderOptions {
  exportMode?: boolean;
}

export class VideoRenderer {
  private animationFrame: number | null = null;
  private isDrawing: boolean = false;
  private lastFrameTime: number = performance.now();
  private frameCount: number = 0;
  private lastFpsCheck: number = performance.now();
  private drawTimes: number[] = []; // Track last 60 frame times

  constructor() {
    // Nothing needed here for now
  }

  public startAnimation(renderContext: RenderContext) {
    console.log('[VideoRenderer] Starting animation');
    this.stopAnimation();
    this.frameCount = 0;
    this.lastFpsCheck = performance.now();
    this.drawTimes = [];

    const animate = () => {
      // Draw frame regardless of video state
      this.drawFrame(renderContext)
        .catch(err => console.error('[VideoRenderer] Draw error:', err));
      
      // Continue animation
      this.animationFrame = requestAnimationFrame(animate);
    };

    this.animationFrame = requestAnimationFrame(animate);
  }

  public stopAnimation() {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  public drawFrame = async (
    context: RenderContext,
    options: RenderOptions = {}
  ): Promise<void> => {
    if (this.isDrawing) {
      console.log('[VideoRenderer] Frame skipped - still drawing previous frame');
      return;
    }
    
    const { video, canvas, tempCanvas, segment, backgroundConfig, mousePositions } = context;
    if (!video || !canvas || !segment) return;

    // Less strict about readyState
    if (video.readyState < 2) {
      console.log('[VideoRenderer] Frame skipped - video not ready:', video.readyState);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    this.isDrawing = true;

    try {
      // Remove frame rate limiting since we're syncing with video naturally
      this.lastFrameTime = performance.now();

      const drawStart = performance.now();
      
      const timings: Record<string, number> = {};
      
      // Canvas setup
      const setupStart = performance.now();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      timings.setup = performance.now() - setupStart;

      // Background
      const bgStart = performance.now();
      ctx.fillStyle = this.getBackgroundStyle(ctx, backgroundConfig.backgroundType);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      timings.background = performance.now() - bgStart;

      // Video frame
      const videoStart = performance.now();
      
      // Calculate scaled dimensions
      const scale = backgroundConfig.scale / 100;
      const scaledWidth = canvas.width * scale;
      const scaledHeight = canvas.height * scale;
      const x = (canvas.width - scaledWidth) / 2;
      const y = (canvas.height - scaledHeight) / 2;

      // Setup temporary canvas for rounded corners
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext('2d')!;

      // Draw rounded rectangle path
      const radius = backgroundConfig.borderRadius;
      tempCtx.beginPath();
      tempCtx.moveTo(x + radius, y);
      tempCtx.lineTo(x + scaledWidth - radius, y);
      tempCtx.quadraticCurveTo(x + scaledWidth, y, x + scaledWidth, y + radius);
      tempCtx.lineTo(x + scaledWidth, y + scaledHeight - radius);
      tempCtx.quadraticCurveTo(x + scaledWidth, y + scaledHeight, x + scaledWidth - radius, y + scaledHeight);
      tempCtx.lineTo(x + radius, y + scaledHeight);
      tempCtx.quadraticCurveTo(x, y + scaledHeight, x, y + scaledHeight - radius);
      tempCtx.lineTo(x, y + radius);
      tempCtx.quadraticCurveTo(x, y, x + radius, y);
      tempCtx.closePath();

      // Apply clipping and draw video frame
      tempCtx.save();
      tempCtx.clip();
      
      // Get interpolated zoom state for current time
      const zoomState = this.calculateCurrentZoomState(video.currentTime, segment);

      tempCtx.imageSmoothingEnabled = true;
      tempCtx.imageSmoothingQuality = 'high';

      if (zoomState && zoomState.zoomFactor !== 1) {
        tempCtx.save();
        const zoomedWidth = scaledWidth * zoomState.zoomFactor;
        const zoomedHeight = scaledHeight * zoomState.zoomFactor;
        const zoomOffsetX = (scaledWidth - zoomedWidth) * zoomState.positionX;
        const zoomOffsetY = (scaledHeight - zoomedHeight) * zoomState.positionY;
        
        tempCtx.translate(x + zoomOffsetX, y + zoomOffsetY);
        tempCtx.scale(zoomState.zoomFactor * scale, zoomState.zoomFactor * scale);
        tempCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
        tempCtx.restore();
      } else {
        tempCtx.drawImage(video, x, y, scaledWidth, scaledHeight);
      }

      tempCtx.restore();

      // Draw the temporary canvas onto the main canvas
      ctx.drawImage(tempCanvas, 0, 0);
      timings.videoFrame = performance.now() - videoStart;

      // Mouse cursor
      const cursorStart = performance.now();
      if (mousePositions.length > 0) {
        const currentVideoTime = video.currentTime;
        const timeWindow = 1/30; // 1 frame at 30fps
        
        const currentPositions = mousePositions.filter(pos => 
          pos.timestamp >= currentVideoTime - timeWindow && 
          pos.timestamp <= currentVideoTime
        );

        if (currentPositions.length > 0) {
          const currentPosition = currentPositions[currentPositions.length - 1];
          const cursorX = x + (currentPosition.x * scaledWidth / video.videoWidth);
          const cursorY = y + (currentPosition.y * scaledHeight / video.videoHeight);

          ctx.save();
          ctx.translate(cursorX, cursorY);
          ctx.scale(5, 5);

          // White outline
          ctx.strokeStyle = 'white';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(0, 12);
          ctx.moveTo(0, 0);
          ctx.lineTo(8, 8);
          ctx.stroke();
          
          // Black line
          ctx.strokeStyle = 'black';
          ctx.lineWidth = 1;
          ctx.stroke();
          
          ctx.restore();
        }
      }
      timings.cursor = performance.now() - cursorStart;

      const totalTime = performance.now() - drawStart;
      if (totalTime > 16) { // Log if frame took longer than 16ms (60fps)
        console.log('[VideoRenderer] Slow frame render:', {
          totalTime: `${totalTime.toFixed(2)}ms`,
          operations: Object.entries(timings).map(([key, time]) => 
            `${key}: ${time.toFixed(2)}ms`
          )
        });
      }

    } finally {
      this.isDrawing = false;
    }
  };

  private getBackgroundStyle(
    ctx: CanvasRenderingContext2D, 
    type: BackgroundConfig['backgroundType']
  ): string | CanvasGradient {
    switch (type) {
      case 'gradient1': {
        const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient.addColorStop(0, '#2563eb');
        gradient.addColorStop(1, '#7c3aed');
        return gradient;
      }
      case 'gradient2': {
        const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient.addColorStop(0, '#fb7185');
        gradient.addColorStop(1, '#fdba74');
        return gradient;
      }
      case 'gradient3': {
        const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient.addColorStop(0, '#10b981');
        gradient.addColorStop(1, '#2dd4bf');
        return gradient;
      }
      case 'solid':
      default:
        return '#000000';
    }
  }

  private calculateCurrentZoomState(
    currentTime: number,
    segment: VideoSegment
  ): ZoomKeyframe {
    const sortedKeyframes = [...segment.zoomKeyframes].sort((a, b) => a.time - b.time);
    if (sortedKeyframes.length === 0) {
      return { time: 0, duration: 0, zoomFactor: 1, positionX: 0.5, positionY: 0.5, easingType: 'linear' };
    }

    const ANIMATION_DURATION = 1.0;

    // Find the next keyframe (if any)
    const nextKeyframe = sortedKeyframes.find(k => k.time > currentTime);
    // Find the previous keyframe (if any)
    const prevKeyframe = [...sortedKeyframes].reverse().find(k => k.time <= currentTime);

    // If we're before all keyframes
    if (!prevKeyframe && !nextKeyframe) {
      return { time: 0, duration: 0, zoomFactor: 1, positionX: 0.5, positionY: 0.5, easingType: 'linear' };
    }

    // If we're after all keyframes, maintain last keyframe state
    if (prevKeyframe && !nextKeyframe) {
      return prevKeyframe;
    }

    // If we're approaching the next keyframe
    if (nextKeyframe && currentTime >= nextKeyframe.time - ANIMATION_DURATION) {
      const progress = (currentTime - (nextKeyframe.time - ANIMATION_DURATION)) / ANIMATION_DURATION;
      const easedProgress = this.easeOutCubic(Math.min(1, Math.max(0, progress)));

      const startState = prevKeyframe || { time: 0, duration: 0, zoomFactor: 1, positionX: 0.5, positionY: 0.5, easingType: 'linear' };

      return {
        time: currentTime,
        duration: ANIMATION_DURATION,
        zoomFactor: startState.zoomFactor + (nextKeyframe.zoomFactor - startState.zoomFactor) * easedProgress,
        positionX: startState.positionX + (nextKeyframe.positionX - startState.positionX) * easedProgress,
        positionY: startState.positionY + (nextKeyframe.positionY - startState.positionY) * easedProgress,
        easingType: 'easeOut'
      };
    }

    // If we're between keyframes but not in a transition
    if (prevKeyframe) {
      return prevKeyframe;
    }

    // Default state
    return { time: 0, duration: 0, zoomFactor: 1, positionX: 0.5, positionY: 0.5, easingType: 'linear' };
  }

  private easeOutCubic(x: number): number {
    return 1 - Math.pow(1 - x, 3);
  }
}

// Create and export a singleton instance
export const videoRenderer = new VideoRenderer(); 