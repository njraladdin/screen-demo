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
  highQuality?: boolean;
}

interface CursorAnimationState {
  startTime: number;
  isAnimating: boolean;
  progress: number;
  isSquishing: boolean;
}

export class VideoRenderer {
  private animationFrame: number | null = null;
  private isDrawing: boolean = false;
  private cursorAnimation: CursorAnimationState = {
    startTime: 0,
    isAnimating: false,
    progress: 0,
    isSquishing: false
  };
  private SQUISH_DURATION = 100; // Faster initial squish for snappier feel
  private RELEASE_DURATION = 600; // Longer release for spring effect

  private readonly DEFAULT_STATE: ZoomKeyframe = {
    time: 0,
    duration: 0,
    zoomFactor: 1,
    positionX: 0.5,
    positionY: 0.5,
    easingType: 'linear' as const
  };

  constructor() {
    // Nothing needed here for now
  }

  public startAnimation(renderContext: RenderContext) {
    console.log('[VideoRenderer] Starting animation');
    this.stopAnimation();

    let lastFrameTime = performance.now();
    const targetFrameInterval = 1000 / 60; // Target 60fps

    const animate = () => {
      const now = performance.now();
      const elapsed = now - lastFrameTime;

      // Only render if enough time has passed for next frame
      if (elapsed >= targetFrameInterval) {
        this.drawFrame(renderContext)
          .catch(err => console.error('[VideoRenderer] Draw error:', err));
        lastFrameTime = now;
      }

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
      return;
    }
    
    const { video, canvas, tempCanvas, segment, backgroundConfig, mousePositions } = context;
    if (!video || !canvas || !segment) return;

    // Less strict about readyState
    if (video.readyState < 2) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    this.isDrawing = true;

    try {
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

      // Add shadow before clipping
      if (backgroundConfig.shadow) {
        tempCtx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        tempCtx.shadowBlur = backgroundConfig.shadow;
        tempCtx.shadowOffsetY = backgroundConfig.shadow * 0.5;
      }

      // Fill the path to create the shadow
      tempCtx.fillStyle = 'white';
      tempCtx.fill();

      // Clear shadow settings before drawing video
      if (backgroundConfig.shadow) {
        tempCtx.shadowColor = 'transparent';
        tempCtx.shadowBlur = 0;
        tempCtx.shadowOffsetY = 0;
      }

      // Apply clipping and draw video frame
      tempCtx.save();
      tempCtx.clip();

      // Get interpolated zoom state for current time
      const zoomState = this.calculateCurrentZoomState(video.currentTime, segment);

      // Enable high quality rendering
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Use better quality settings for export mode
      if (options.exportMode) {
        tempCtx.imageSmoothingEnabled = true;
        tempCtx.imageSmoothingQuality = 'high';
        
        // Ensure video frame is rendered at full quality
        if (video.videoWidth > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          tempCanvas.width = video.videoWidth;
          tempCanvas.height = video.videoHeight;
        }
      }

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

      if (backgroundConfig.shadow) {
        tempCtx.shadowColor = 'transparent';
        tempCtx.shadowBlur = 0;
        tempCtx.shadowOffsetY = 0;
      }

      tempCtx.restore();

      // Draw the temporary canvas onto the main canvas
      ctx.drawImage(tempCanvas, 0, 0);
      timings.videoFrame = performance.now() - videoStart;

      // Mouse cursor
      const cursorStart = performance.now();
      const interpolatedPosition = this.interpolateCursorPosition(video.currentTime, mousePositions, backgroundConfig);
      if (interpolatedPosition) {
        // Calculate base cursor position relative to original video
        let cursorX = x + (interpolatedPosition.x * scaledWidth / video.videoWidth);
        let cursorY = y + (interpolatedPosition.y * scaledHeight / video.videoHeight);

        // If there's zoom, adjust cursor position using same transform
        if (zoomState && zoomState.zoomFactor !== 1) {
          const zoomedWidth = scaledWidth * zoomState.zoomFactor;
          const zoomedHeight = scaledHeight * zoomState.zoomFactor;
          const zoomOffsetX = (scaledWidth - zoomedWidth) * zoomState.positionX;
          const zoomOffsetY = (scaledHeight - zoomedHeight) * zoomState.positionY;

          // Apply same zoom transform to cursor position
          cursorX = (cursorX - x) * zoomState.zoomFactor + x + zoomOffsetX;
          cursorY = (cursorY - y) * zoomState.zoomFactor + y + zoomOffsetY;
        }

        const cursorScale = (backgroundConfig.cursorScale || 2) * (zoomState?.zoomFactor || 1);

        this.drawMouseCursor(
          ctx,
          cursorX,
          cursorY,
          interpolatedPosition.isClicked || false,
          cursorScale
        );
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
        // Blue to violet gradient
        const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0); // horizontal gradient
        gradient.addColorStop(0, '#2563eb'); // blue-600
        gradient.addColorStop(1, '#7c3aed'); // violet-600
        return gradient;
      }
      case 'gradient2': {
        // Rose to orange gradient
        const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient.addColorStop(0, '#fb7185'); // rose-400
        gradient.addColorStop(1, '#fdba74'); // orange-300
        return gradient;
      }
      case 'gradient3': {
        // Emerald to teal gradient
        const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient.addColorStop(0, '#10b981'); // emerald-500
        gradient.addColorStop(1, '#2dd4bf'); // teal-400
        return gradient;
      }
      case 'solid': {
        // Create a subtle dark gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
        gradient.addColorStop(0, '#0a0a0a'); // Very slightly lighter black at top
        gradient.addColorStop(0.5, '#000000'); // Pure black in middle
        gradient.addColorStop(1, '#0a0a0a'); // Very slightly lighter black at bottom
        
        // Add a subtle radial overlay for more depth
        const centerX = ctx.canvas.width / 2;
        const centerY = ctx.canvas.height / 2;
        const radialGradient = ctx.createRadialGradient(
          centerX, centerY, 0,
          centerX, centerY, ctx.canvas.width * 0.8
        );
        radialGradient.addColorStop(0, 'rgba(30, 30, 30, 0.15)'); // Subtle light center
        radialGradient.addColorStop(1, 'rgba(0, 0, 0, 0)'); // Fade to transparent

        // Draw base gradient
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        // Add radial overlay
        ctx.fillStyle = radialGradient;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        return 'rgba(0,0,0,0)'; // Return transparent as we've already filled
      }
      default:
        return '#000000';
    }
  }

  private calculateCurrentZoomState(
    currentTime: number,
    segment: VideoSegment
  ): ZoomKeyframe {
    const sortedKeyframes = [...segment.zoomKeyframes].sort((a, b) => a.time - b.time);
    if (sortedKeyframes.length === 0) return this.DEFAULT_STATE;

    const nextKeyframe = sortedKeyframes.find(k => k.time > currentTime);
    const prevKeyframe = [...sortedKeyframes].reverse().find(k => k.time <= currentTime);

    const TRANSITION_DURATION = 1.0;

    // If we have a previous keyframe and next keyframe that are close
    if (prevKeyframe && nextKeyframe && (nextKeyframe.time - prevKeyframe.time) <= TRANSITION_DURATION) {
      const progress = (currentTime - prevKeyframe.time) / (nextKeyframe.time - prevKeyframe.time);
      const easedProgress = this.easeOutCubic(Math.min(1, Math.max(0, progress)));
      
      return {
        time: currentTime,
        duration: nextKeyframe.time - prevKeyframe.time,
        zoomFactor: prevKeyframe.zoomFactor + (nextKeyframe.zoomFactor - prevKeyframe.zoomFactor) * easedProgress,
        positionX: prevKeyframe.positionX + (nextKeyframe.positionX - prevKeyframe.positionX) * easedProgress,
        positionY: prevKeyframe.positionY + (nextKeyframe.positionY - prevKeyframe.positionY) * easedProgress,
        easingType: 'easeOut' as const
      };
    }

    // If approaching next keyframe
    if (nextKeyframe) {
      const timeToNext = nextKeyframe.time - currentTime;
      if (timeToNext <= TRANSITION_DURATION) {
        const progress = (TRANSITION_DURATION - timeToNext) / TRANSITION_DURATION;
        const easedProgress = this.easeOutCubic(Math.min(1, Math.max(0, progress)));
        
        const startState = prevKeyframe || this.DEFAULT_STATE;
        
        return {
          time: currentTime,
          duration: TRANSITION_DURATION,
          zoomFactor: startState.zoomFactor + (nextKeyframe.zoomFactor - startState.zoomFactor) * easedProgress,
          positionX: startState.positionX + (nextKeyframe.positionX - startState.positionX) * easedProgress,
          positionY: startState.positionY + (nextKeyframe.positionY - startState.positionY) * easedProgress,
          easingType: 'easeOut' as const
        };
      }
    }

    // If we have a previous keyframe, maintain its state
    if (prevKeyframe) {
      return prevKeyframe;
    }

    return this.DEFAULT_STATE;
  }

  private easeOutCubic(x: number): number {
    return 1 - Math.pow(1 - x, 3);
  }

  private interpolateCursorPosition(
    currentTime: number, 
    mousePositions: MousePosition[],
    backgroundConfig: BackgroundConfig
  ): {x: number, y: number, isClicked: boolean} | null {
    if (mousePositions.length === 0) return null;

    const lookAheadTime = currentTime + 1/30;

    // Find the current position
    const currentPos = mousePositions.find(pos => pos.timestamp >= lookAheadTime) || 
                      mousePositions[mousePositions.length - 1];

    // Debug log when we find a clicked position
    if (currentPos.isClicked) {
      console.log('[VideoRenderer] Found clicked position at time:', currentPos.timestamp);
    }

    // Calculate cursor speed using nearby positions
    const prevPos = mousePositions.find(pos => pos.timestamp < currentPos.timestamp);
    let speed = 0;
    if (prevPos) {
      const dx = currentPos.x - prevPos.x;
      const dy = currentPos.y - prevPos.y;
      const dt = currentPos.timestamp - prevPos.timestamp;
      speed = Math.sqrt(dx * dx + dy * dy) / dt;
    }

    // Adjust window size based on speed and user smoothness preference
    const smoothness = backgroundConfig.cursorSmoothness || 5;
    const baseWindowSize = smoothness;  // Window size now based on smoothness
    const windowSize = Math.max(2, baseWindowSize - (speed * 2));

    const relevantPositions = mousePositions
      .filter(pos => 
        pos.timestamp >= lookAheadTime - (windowSize/30) && 
        pos.timestamp <= lookAheadTime + (windowSize/30)
      );

    if (relevantPositions.length === 0) {
      return {
        x: currentPos.x,
        y: currentPos.y,
        isClicked: currentPos.isClicked || false
      };
    }

    // Rest of the weighted average calculation...
    let totalWeight = 0;
    let smoothX = 0;
    let smoothY = 0;

    relevantPositions.forEach(pos => {
      const timeDiff = Math.abs(pos.timestamp - lookAheadTime);
      const weight = 1 / (timeDiff + 0.1);
      totalWeight += weight;
      smoothX += pos.x * weight;
      smoothY += pos.y * weight;
    });

    return {
      x: smoothX / totalWeight,
      y: smoothY / totalWeight,
      isClicked: currentPos.isClicked || false
    };
  }

  private drawMouseCursor(ctx: CanvasRenderingContext2D, x: number, y: number, isClicked: boolean, scale: number = 2) {
    ctx.save();
    ctx.translate(x, y);
    const cursorScale = scale;
    
    // First apply the base cursor scale normally
    ctx.scale(cursorScale, cursorScale);
    
    // Adjust translation for better click point alignment
    ctx.translate(-8, -5);
    
    // Handle click animation state
    if (isClicked && !this.cursorAnimation.isAnimating) {
      this.cursorAnimation.startTime = performance.now();
      this.cursorAnimation.isAnimating = true;
      this.cursorAnimation.progress = 0;
      this.cursorAnimation.isSquishing = true;
    }
    
    // Handle animation state changes
    if (this.cursorAnimation.isAnimating) {
      const elapsed = performance.now() - this.cursorAnimation.startTime;
      const duration = this.cursorAnimation.isSquishing ? this.SQUISH_DURATION : this.RELEASE_DURATION;
      this.cursorAnimation.progress = Math.min(elapsed / duration, 1);
      
      if (this.cursorAnimation.progress >= 1 && this.cursorAnimation.isSquishing && isClicked) {
        // Switch to release phase
        this.cursorAnimation.startTime = performance.now();
        this.cursorAnimation.progress = 0;
        this.cursorAnimation.isSquishing = false;
      } else if (this.cursorAnimation.progress >= 1) {
        this.cursorAnimation.isAnimating = false;
      }
    }
    
    // Apply scale animation
    if (this.cursorAnimation.isAnimating) {
      const t = this.cursorAnimation.progress;
      let scaleAmount;
      
      if (this.cursorAnimation.isSquishing) {
        // Quick scale down with slight anticipation
        const easeInBack = (t: number): number => {
          const c1 = 1.70158;
          const c3 = c1 + 1;
          return c3 * t * t * t - c1 * t * t;
        };
        scaleAmount = 1 - (0.25 * easeInBack(t));  // Scale down to 75%
      } else {
        // Springy bounce back
        const springyBounce = (t: number): number => {
          // More pronounced spring effect
          const decay = Math.exp(-t * 6);
          const oscillation = Math.sin(t * 12);
          return 1 + (decay * oscillation * 0.2); // 0.2 controls bounce magnitude
        };
        
        // Combine smooth return with spring effect
        const baseReturn = 0.75 + (0.25 * (1 - Math.exp(-t * 3)));
        scaleAmount = baseReturn * springyBounce(t);
      }
      
      // Apply uniform scaling with spring effect
      ctx.scale(scaleAmount, scaleAmount);
    }

    // Main arrow shape
    const mainArrow = new Path2D('M 8.2 4.9 L 19.8 16.5 L 13 16.5 L 12.6 16.6 L 8.2 20.9 Z');
    
    // Click indicator
    const clickIndicator = new Path2D('M 17.3 21.6 L 13.7 23.1 L 9 12 L 12.7 10.5 Z');

    // White outline
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 1.5;
    ctx.stroke(mainArrow);
    ctx.stroke(clickIndicator);

    // Black fill
    ctx.fillStyle = 'black';
    ctx.fill(mainArrow);
    ctx.fill(clickIndicator);

    ctx.restore();
  }
}

// Create and export a singleton instance
export const videoRenderer = new VideoRenderer(); 