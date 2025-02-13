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
  lastPosition?: { x: number; y: number };
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
  private RELEASE_DURATION = 300; // Shorter release for quicker bounce back
  private lastDrawTime: number = 0;
  private readonly FRAME_INTERVAL = 1000 / 120; // Increase to 120fps for smoother animation
  private backgroundConfig: BackgroundConfig | null = null;
  private pointerImage: HTMLImageElement;

  private readonly DEFAULT_STATE: ZoomKeyframe = {
    time: 0,
    duration: 0,
    zoomFactor: 1,
    positionX: 0.5,
    positionY: 0.5,
    easingType: 'linear' as const
  };

  private smoothedPositions: MousePosition[] | null = null;
  private hasLoggedPositions = false;

  constructor() {
    // Preload the pointer SVG image.
    this.pointerImage = new Image();
    this.pointerImage.src = '/pointer.svg';
    this.pointerImage.onload = () => {
      console.log('[VideoRenderer] Pointer image loaded:', this.pointerImage.naturalWidth, this.pointerImage.naturalHeight);
    };
  }

  public startAnimation(renderContext: RenderContext) {
    console.log('[VideoRenderer] Starting animation');
    this.stopAnimation();
    this.lastDrawTime = 0;
    this.smoothedPositions = null;

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
    
    const { video, canvas, tempCanvas, segment, backgroundConfig, mousePositions } = context;
    if (!video || !canvas || !segment) return;

    // Store original canvas dimensions
    const targetWidth = canvas.width;
    const targetHeight = canvas.height;

    // Temporarily set canvas to video dimensions for consistent rendering
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;

    const isExportMode = options.exportMode || false;
    const quality = isExportMode ? 'high' : 'medium';
    
    const ctx = canvas.getContext('2d', {
        alpha: false,
        willReadFrequently: false
    });
    if (!ctx) return;

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
        const zoomState = this.calculateCurrentZoomState(video.currentTime, segment);

        ctx.save();
        
        // Apply zoom transformation to entire canvas before drawing anything
        if (zoomState && zoomState.zoomFactor !== 1) {
            const zoomedWidth = canvas.width * zoomState.zoomFactor;
            const zoomedHeight = canvas.height * zoomState.zoomFactor;
            const zoomOffsetX = (canvas.width - zoomedWidth) * zoomState.positionX;
            const zoomOffsetY = (canvas.height - zoomedHeight) * zoomState.positionY;
            
            ctx.translate(zoomOffsetX, zoomOffsetY);
            ctx.scale(zoomState.zoomFactor, zoomState.zoomFactor);
        }

        // Draw background first
        ctx.fillStyle = this.getBackgroundStyle(ctx, backgroundConfig.backgroundType);
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Setup temporary canvas for rounded corners and shadows
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        if (!tempCtx) return;

        // Clear temp canvas
        tempCtx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw video frame with rounded corners to temp canvas
        tempCtx.save();
        
        // Create rounded rectangle path
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

        // Fill white first to create the shape
        tempCtx.fillStyle = 'white';
        tempCtx.fill();

        // Add shadow before clipping
        if (backgroundConfig.shadow) {
            tempCtx.shadowColor = 'rgba(0, 0, 0, 0.3)';
            tempCtx.shadowBlur = backgroundConfig.shadow;
            tempCtx.shadowOffsetY = backgroundConfig.shadow * 0.5;
            tempCtx.fill();
            tempCtx.shadowColor = 'transparent';
            tempCtx.shadowBlur = 0;
            tempCtx.shadowOffsetY = 0;
        }

        // Now clip and draw video
        tempCtx.clip();
        tempCtx.drawImage(video, x, y, scaledWidth, scaledHeight);
        tempCtx.restore();

        // Composite temp canvas onto main canvas
        ctx.drawImage(tempCanvas, 0, 0);

        // Mouse cursor
        const cursorStart = performance.now();
        const interpolatedPosition = this.interpolateCursorPosition(video.currentTime, mousePositions, backgroundConfig);
        if (interpolatedPosition) {
            // Save current transform
            ctx.save();
            // Reset the transform before drawing cursor
            ctx.setTransform(1, 0, 0, 1, 0, 0);

            // Calculate cursor position in original video space first
            let cursorX = x + (interpolatedPosition.x * scaledWidth / video.videoWidth);
            let cursorY = y + (interpolatedPosition.y * scaledHeight / video.videoHeight);

            // If there's zoom, adjust cursor position
            if (zoomState && zoomState.zoomFactor !== 1) {
                // Apply the same zoom transformation to cursor position
                cursorX = cursorX * zoomState.zoomFactor + (canvas.width - canvas.width * zoomState.zoomFactor) * zoomState.positionX;
                cursorY = cursorY * zoomState.zoomFactor + (canvas.height - canvas.height * zoomState.zoomFactor) * zoomState.positionY;
            }

            // Scale cursor size based on video dimensions ratio and zoom
            const sizeRatio = Math.min(targetWidth / video.videoWidth, targetHeight / video.videoHeight);
            const cursorScale = (backgroundConfig.cursorScale || 2) * sizeRatio * (zoomState?.zoomFactor || 1);

            this.drawMouseCursor(
                ctx,
                cursorX,
                cursorY,
                interpolatedPosition.isClicked || false,
                cursorScale,
                interpolatedPosition.cursor_type || 'default'
            );

            // Restore transform
            ctx.restore();
        }
        const timings = { cursor: performance.now() - cursorStart };

        const totalTime = performance.now() - drawStart;
        if (totalTime > 16) { // Log if frame took longer than 16ms (60fps)
            console.log('[VideoRenderer] Slow frame render:', {
                totalTime: `${totalTime.toFixed(2)}ms`,
                operations: Object.entries(timings).map(([key, time]) => 
                    `${key}: ${time.toFixed(2)}ms`
                )
            });
        }

        this.backgroundConfig = context.backgroundConfig;

    } finally {
        this.isDrawing = false;
        ctx.restore();

        // If we're exporting and dimensions are different
        if (options.exportMode && (targetWidth !== video.videoWidth || targetHeight !== video.videoHeight)) {
            // Create a temporary canvas for scaling
            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = targetWidth;
            exportCanvas.height = targetHeight;
            const exportCtx = exportCanvas.getContext('2d', {
                alpha: false,
                willReadFrequently: false
            });
            
            if (exportCtx) {
                // Use better quality settings for export
                exportCtx.imageSmoothingEnabled = true;
                exportCtx.imageSmoothingQuality = 'high';
                
                exportCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
                // Copy scaled content back to main canvas
                canvas.width = targetWidth;
                canvas.height = targetHeight;
                ctx?.drawImage(exportCanvas, 0, 0);
                exportCanvas.remove(); // Clean up
            }
        } else if (!options.exportMode) {
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

  private catmullRomInterpolate(
    p0: number,
    p1: number,
    p2: number,
    p3: number,
    t: number
  ): number {
    const t2 = t * t;
    const t3 = t2 * t;
    
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  private smoothMousePositions(
    positions: MousePosition[],
    targetFps: number = 120
  ): MousePosition[] {
    if (positions.length < 4) return positions;

    const smoothed: MousePosition[] = [];
    const timeStep = 1 / targetFps;

    // First pass: Catmull-Rom interpolation
    for (let i = 0; i < positions.length - 3; i++) {
      const p0 = positions[i];
      const p1 = positions[i + 1];
      const p2 = positions[i + 2];
      const p3 = positions[i + 3];

      const segmentDuration = p2.timestamp - p1.timestamp;
      const numFrames = Math.ceil(segmentDuration * targetFps);

      for (let frame = 0; frame < numFrames; frame++) {
        const t = frame / numFrames;
        const timestamp = p1.timestamp + (segmentDuration * t);

        const x = this.catmullRomInterpolate(p0.x, p1.x, p2.x, p3.x, t);
        const y = this.catmullRomInterpolate(p0.y, p1.y, p2.y, p3.y, t);
        const isClicked = Boolean(p1.isClicked || p2.isClicked);
        // Use the cursor type from the nearest position
        const cursor_type = t < 0.5 ? p1.cursor_type : p2.cursor_type;

        smoothed.push({ x, y, timestamp, isClicked, cursor_type });
      }
    }

    // Get smoothness value from background config, default to 5 if not set
    // Scale it up to make the effect more noticeable (1-10 becomes 2-20)
    const windowSize = ((this.backgroundConfig?.cursorSmoothness || 5) * 2) + 1;
    
    // Multiple smoothing passes based on smoothness value
    const passes = Math.ceil(windowSize / 2);
    let currentSmoothed = smoothed;

    // Apply multiple passes of smoothing based on the smoothness value
    for (let pass = 0; pass < passes; pass++) {
        const passSmoothed: MousePosition[] = [];
        
        for (let i = 0; i < currentSmoothed.length; i++) {
            let sumX = 0;
            let sumY = 0;
            let totalWeight = 0;
            
            // Keep cursor type from original position
            const cursor_type = currentSmoothed[i].cursor_type;
            
            // Only smooth position, not cursor type
            for (let j = Math.max(0, i - windowSize); j <= Math.min(currentSmoothed.length - 1, i + windowSize); j++) {
                const distance = Math.abs(i - j);
                const weight = Math.exp(-distance * (0.5 / windowSize));
                
                sumX += currentSmoothed[j].x * weight;
                sumY += currentSmoothed[j].y * weight;
                totalWeight += weight;
            }

            passSmoothed.push({
                x: sumX / totalWeight,
                y: sumY / totalWeight,
                timestamp: currentSmoothed[i].timestamp,
                isClicked: currentSmoothed[i].isClicked,
                cursor_type // Preserve the cursor type
            });
        }
        
        currentSmoothed = passSmoothed;
    }

    // Apply threshold to remove tiny movements
    // Make threshold smaller for higher smoothness values
    const threshold = 0.5 / (windowSize / 2); // Adjust threshold based on smoothness
    let lastSignificantPos = currentSmoothed[0];
    const finalSmoothed = [lastSignificantPos];

    for (let i = 1; i < currentSmoothed.length; i++) {
        const current = currentSmoothed[i];
        const distance = Math.sqrt(
            Math.pow(current.x - lastSignificantPos.x, 2) + 
            Math.pow(current.y - lastSignificantPos.y, 2)
        );

        if (distance > threshold || current.isClicked !== lastSignificantPos.isClicked) {
            finalSmoothed.push(current);
            lastSignificantPos = current;
        } else {
            finalSmoothed.push({
                ...lastSignificantPos,
                timestamp: current.timestamp
            });
        }
    }

    return finalSmoothed;
  }

  private interpolateCursorPosition(
    currentTime: number,
    mousePositions: MousePosition[],
    backgroundConfig: BackgroundConfig
  ): { x: number; y: number; isClicked: boolean; cursor_type: string } | null {
    if (mousePositions.length === 0) return null;

    // Add cursor type frequency analysis
    if (!this.hasLoggedPositions) {
      const typeCounts = mousePositions.reduce((acc, pos) => {
        const type = pos.cursor_type || 'default';
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log('Cursor type frequencies:', {
        total: mousePositions.length,
        types: typeCounts
      });
      
      this.hasLoggedPositions = true;
    }

    // Cache smoothed positions
    if (!this.smoothedPositions || this.smoothedPositions.length === 0) {
      this.smoothedPositions = this.smoothMousePositions(mousePositions);
    }

    const positions = this.smoothedPositions;
    
    // Find the exact position for the current time
    const exactMatch = positions.find(pos => Math.abs(pos.timestamp - currentTime) < 0.001);
    if (exactMatch) {
      console.log('Exact match found:', {
        time: currentTime,
        cursor_type: exactMatch.cursor_type,
        pos: exactMatch
      });
      return {
        x: exactMatch.x,
        y: exactMatch.y,
        isClicked: Boolean(exactMatch.isClicked),
        cursor_type: exactMatch.cursor_type || 'default'
      };
    }

    // Find the two closest positions
    const nextIndex = positions.findIndex(pos => pos.timestamp > currentTime);
    if (nextIndex === -1) {
      const last = positions[positions.length - 1];
      console.log('Using last position:', {
        time: currentTime,
        cursor_type: last.cursor_type,
        pos: last
      });
      return {
        x: last.x,
        y: last.y,
        isClicked: Boolean(last.isClicked),
        cursor_type: last.cursor_type || 'default'
      };
    }

    if (nextIndex === 0) {
      const first = positions[0];
      return {
        x: first.x,
        y: first.y,
        isClicked: Boolean(first.isClicked),
        cursor_type: first.cursor_type || 'default'
      };
    }

    // Linear interpolation between the two closest points
    const prev = positions[nextIndex - 1];
    const next = positions[nextIndex];
    const t = (currentTime - prev.timestamp) / (next.timestamp - prev.timestamp);
    console.log('Interpolating between:', {
      time: currentTime,
      prev_type: prev.cursor_type,
      next_type: next.cursor_type,
      prev,
      next
    });

    return {
      x: prev.x + (next.x - prev.x) * t,
      y: prev.y + (next.y - prev.y) * t,
      isClicked: Boolean(prev.isClicked || next.isClicked),
      cursor_type: next.cursor_type || 'default'
    };
  }

  private drawMouseCursor(
    ctx: CanvasRenderingContext2D, 
    x: number, 
    y: number, 
    isClicked: boolean, 
    scale: number = 2,
    cursorType: string = 'default'
  ) {
    ctx.save();
    this.drawCursorShape(ctx, x, y, isClicked, scale, cursorType);
    ctx.restore();
  }

  private drawCursorShape(
    ctx: CanvasRenderingContext2D, 
    x: number, 
    y: number, 
    isClicked: boolean, 
    scale: number = 2,
    cursorType: string
  ) {
    const lowerType = cursorType.toLowerCase();
    console.log('Drawing cursor:', {
      type: cursorType,
      lowerType,
      x,
      y,
      isClicked
    });

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    
    // Handle click animation state
    const now = performance.now();
    if (isClicked && !this.cursorAnimation.isAnimating) {
        // Start new click animation
        this.cursorAnimation.startTime = now;
        this.cursorAnimation.isAnimating = true;
        this.cursorAnimation.isSquishing = true;
    }
    
    // Apply animation transforms
    if (this.cursorAnimation.isAnimating) {
        const elapsed = now - this.cursorAnimation.startTime;
        
        if (this.cursorAnimation.isSquishing) {
            // Squish phase
            const progress = Math.min(1, elapsed / this.SQUISH_DURATION);
            const scaleAmount = 1 - (0.2 * this.easeOutQuad(progress)); // Reduce scale by 20%
            ctx.scale(scaleAmount, scaleAmount);
            
            if (progress >= 1) {
                // Switch to release phase
                this.cursorAnimation.isSquishing = false;
                this.cursorAnimation.startTime = now;
            }
        } else {
            // Release/bounce phase
            const progress = Math.min(1, elapsed / this.RELEASE_DURATION);
            const baseScale = 0.8 + (0.2 * this.easeOutBack(progress));
            ctx.scale(baseScale, baseScale);
            
            if (progress >= 1) {
                this.cursorAnimation.isAnimating = false;
            }
        }
    }

    // Add some debug logging
    console.log('Drawing cursor type:', cursorType);
    
    switch (lowerType) {
      case 'text': {
        console.log('Drawing TEXT cursor');
        ctx.translate(-6, -8);
        
        // I-beam cursor with more detailed shape
        const ibeam = new Path2D(`
          M 2 0 L 10 0 L 10 2 L 7 2 L 7 14 L 10 14 L 10 16 L 2 16 L 2 14 L 5 14 L 5 2 L 2 2 Z
        `);
        
        // White outline
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke(ibeam);
        
        // Black fill
        ctx.fillStyle = 'black';
        ctx.fill(ibeam);
        break;
      }
      
      case 'pointer': {
        console.log('Drawing POINTER cursor with image, applying offset');
        // If the pointer image is loaded, draw it. Use fallback dimensions if necessary.
        let imgWidth = 24, imgHeight = 24;
        if (this.pointerImage.complete && this.pointerImage.naturalWidth > 0) {
          imgWidth = this.pointerImage.naturalWidth;
          imgHeight = this.pointerImage.naturalHeight;
        }
        
        // Shift the image offset to center the pointer tip
        // Adjust offsetX and offsetY as needed. Here we shift right and down by 4 pixels each.
        const offsetX = 8;
        const offsetY = 16;
        ctx.translate(-imgWidth / 2 + offsetX, -imgHeight / 2 + offsetY);
        ctx.drawImage(this.pointerImage, 0, 0, imgWidth, imgHeight);
        break;
      }
      
      default: {
        console.log('Drawing DEFAULT cursor');
        ctx.translate(-8, -5);
        const mainArrow = new Path2D('M 8.2 4.9 L 19.8 16.5 L 13 16.5 L 12.6 16.6 L 8.2 20.9 Z');
        const clickIndicator = new Path2D('M 17.3 21.6 L 13.7 23.1 L 9 12 L 12.7 10.5 Z');

        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke(mainArrow);
        ctx.stroke(clickIndicator);

        ctx.fillStyle = 'black';
        ctx.fill(mainArrow);
        ctx.fill(clickIndicator);
        break;
      }
    }

    ctx.restore();
  }

  // Helper methods for animations
  private easeOutQuad(t: number): number {
    return t * (2 - t);
  }

  private easeOutBack(t: number): number {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
}

// Create and export a singleton instance
export const videoRenderer = new VideoRenderer(); 