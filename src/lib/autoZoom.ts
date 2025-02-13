import { VideoSegment, ZoomKeyframe, MousePosition } from '@/types/video';

interface AutoZoomOptions {
  minZoomFactor?: number;
  maxZoomFactor?: number;
  minDuration?: number;
  maxZooms?: number;
  minDistance?: number;
  mouseAnalysisWindow?: number; // Time window to analyze mouse movement
  zoomTransitionTime?: number;  // Duration of zoom transitions
  minTimeForZoomOut?: number;   // Minimum time needed to add zoom-out
  activityThreshold?: number;   // Mouse movement threshold for "active" areas
  hoverThreshold?: number;     // Time in seconds to consider a "hover"
  clickIntensityWindow?: number; // Window to analyze click intensity
  edgeBuffer?: number;         // % of screen to avoid zooming into
  maxClickZoom?: number;       // Max zoom for intense clicking
  dramaticPauseThreshold?: number; // Time without movement to trigger dramatic zoom
  zoomOutSpeed?: number;      // How fast to zoom out (lower = more dramatic)
  focusAreaSize?: number;     // Size of area to analyze for focus (px)
  mouseSpeedThreshold?: number; // Speed threshold for "intentional" movement
  doubleClickBoost?: number;  // Extra zoom boost for double-clicks
  minStayDuration?: number;   // Min time to stay zoomed in
}

export class AutoZoomGenerator {
  private readonly DEFAULT_OPTIONS: AutoZoomOptions = {
    minZoomFactor: 1.3,      // Increased from 1.15 for more noticeable minimum zoom
    maxZoomFactor: 3.2,      // Increased from 2.8 for more dramatic max zoom
    minDuration: 400,          // Slightly faster minimum duration
    maxZooms: 15,             // Allow more zooms if needed
    minDistance: 150,         // Reduced distance threshold
    mouseAnalysisWindow: 1.5, // Longer analysis window
    zoomTransitionTime: 0.4,  // Slightly slower transitions
    minTimeForZoomOut: 0.8,   // Minimum time needed between zooms
    activityThreshold: 50,     // Pixels of movement to consider "active"
    hoverThreshold: 0.8,       // Consider it a hover after 0.8s
    clickIntensityWindow: 1.0, // Look at clicks within 1s
    edgeBuffer: 0.15,         // Keep 15% buffer from edges
    maxClickZoom: 3.8,        // Increased from 3.2 for even more dramatic moments
    dramaticPauseThreshold: 1.2, // Dramatic zoom after 1.2s pause
    zoomOutSpeed: 0.6,        // Slower zoom outs for drama
    focusAreaSize: 200,       // Analysis area in pixels
    mouseSpeedThreshold: 400, // pixels per second
    doubleClickBoost: 1.5,    // Increased from 1.4 for more dramatic double clicks
    minStayDuration: 0.7,     // Stay zoomed in for at least 0.7s
  };

  generateZooms(
    segment: VideoSegment,
    mousePositions: MousePosition[],
    options: AutoZoomOptions = {}
  ): ZoomKeyframe[] {
    const opts = { ...this.DEFAULT_OPTIONS, ...options };
    const keyframes: ZoomKeyframe[] = [];
    
    // 1. Find click points within trimmed segment, excluding first second
    const clickPoints = mousePositions.filter(pos => 
      pos.isClicked && 
      pos.timestamp >= segment.trimStart + 1 && // Add 1 second buffer
      pos.timestamp <= segment.trimEnd
    );

    // 2. Group nearby clicks (within 0.5s)
    const groupedClicks = this.groupNearbyClicks(clickPoints, 0.5);

    // 3. Filter groups by distance and limit total zooms
    const significantPoints = this.filterSignificantPoints(
      groupedClicks.map(group => group[0]), 
      opts.minDistance!
    ).slice(0, opts.maxZooms);

    // 4. Generate keyframes for each significant point
    let lastZoomArea: MousePosition | null = null;

    significantPoints.forEach((point, index) => {
      // Calculate zoom factor based on time spent in area
      const zoomFactor = this.calculateDynamicZoom(
        point,
        mousePositions,
        opts.minZoomFactor!,
        opts.maxZoomFactor!
      );

      const normalizedX = point.x / 1920;
      const normalizedY = point.y / 1080;

      // Check if we need to zoom out from previous area
      if (lastZoomArea && this.getDistance(lastZoomArea, point) > opts.minDistance!) {
        const timeBetween = point.timestamp - lastZoomArea.timestamp;
        if (timeBetween >= opts.minDuration!) {
          // Add zoom-out keyframe
          const zoomOutTime = point.timestamp - 0.5; // Zoom out before next point
          keyframes.push({
            time: zoomOutTime,
            duration: 0.3,
            zoomFactor: 1.0,
            positionX: lastZoomArea.x / 1920,
            positionY: lastZoomArea.y / 1080,
            easingType: 'easeInOut'
          });
        }
      }

      // Add zoom-in keyframe
      keyframes.push({
        time: Math.max(segment.trimStart, point.timestamp - 0.2),
        duration: 0.3,
        zoomFactor,
        positionX: normalizedX,
        positionY: normalizedY,
        easingType: 'easeOut'
      });

      // Check if this is the last point or if we should add a final zoom-out
      const isLastPoint = index === significantPoints.length - 1;
      if (isLastPoint) {
        const timeUntilEnd = segment.trimEnd - point.timestamp;
        if (timeUntilEnd >= 1.0) {
          keyframes.push({
            time: point.timestamp + Math.min(1.0, timeUntilEnd - 0.5),
            duration: 0.5,
            zoomFactor: 1.0,
            positionX: normalizedX,
            positionY: normalizedY,
            easingType: 'easeInOut'
          });
        }
      }

      lastZoomArea = point;
    });

    return keyframes.sort((a, b) => a.time - b.time);
  }

  private calculateDynamicZoom(
    point: MousePosition,
    allPositions: MousePosition[],
    minZoom: number,
    maxZoom: number
  ): number {
    const timeWindow = allPositions.filter(pos => 
      Math.abs(pos.timestamp - point.timestamp) <= this.DEFAULT_OPTIONS.mouseAnalysisWindow!
    );

    // Calculate engagement factors with improved weights
    const mouseActivity = this.calculateMouseActivity(timeWindow);
    const hoverScore = this.calculateHoverScore(timeWindow);
    const clickIntensity = this.calculateClickIntensity(timeWindow);
    const dramaticPause = this.detectDramaticPause(timeWindow);
    const intentionalMovement = this.detectIntentionalMovement(timeWindow);
    const isDoubleClick = this.isDoubleClick(timeWindow);
    
    let dynamicMaxZoom = maxZoom;
    
    // Boost zoom for more engaging scenarios
    if (dramaticPause) {
      // More dramatic pause = deeper zoom
      dynamicMaxZoom = Math.min(this.DEFAULT_OPTIONS.maxClickZoom!, maxZoom * 1.4);
    }
    
    if (clickIntensity > 2) {
      // Scale zoom with click intensity
      const intensityBoost = Math.min(clickIntensity / 2, 2);
      dynamicMaxZoom = Math.min(this.DEFAULT_OPTIONS.maxClickZoom!, maxZoom * (1.3 + intensityBoost * 0.2));
    }
    
    if (isDoubleClick) {
      dynamicMaxZoom *= this.DEFAULT_OPTIONS.doubleClickBoost!;
    }
    
    if (hoverScore > 0.7) {
      // More dramatic hover zoom based on hover duration
      const hoverBoost = 1 + (hoverScore - 0.7) * 0.5;
      dynamicMaxZoom *= hoverBoost;
    }

    if (intentionalMovement) {
      // Reduce zoom less for intentional movement
      dynamicMaxZoom *= 0.9;
    } else {
      // Reduce more for erratic movement
      dynamicMaxZoom *= 0.7;
    }

    // Adjust for edge proximity with smoother falloff
    const edgeProximity = this.calculateEdgeProximity(point);
    const edgeFalloff = Math.pow(1 - edgeProximity, 1.5); // Smoother falloff curve
    dynamicMaxZoom *= edgeFalloff;

    // Activity reduces zoom with improved curve
    const activityFactor = Math.min(mouseActivity / this.DEFAULT_OPTIONS.activityThreshold!, 1);
    const activityReduction = Math.pow(activityFactor, 1.5); // More forgiving for medium activity
    dynamicMaxZoom = Math.max(minZoom, dynamicMaxZoom - (activityReduction * (dynamicMaxZoom - minZoom) * 0.6));

    return this.findBestZoomLevel(point, timeWindow, minZoom, dynamicMaxZoom);
  }

  private calculateMouseActivity(positions: MousePosition[]): number {
    if (positions.length < 2) return 0;
    
    let totalDistance = 0;
    for (let i = 1; i < positions.length; i++) {
      totalDistance += this.getDistance(positions[i-1], positions[i]);
    }
    
    const timeSpan = positions[positions.length-1].timestamp - positions[0].timestamp;
    return totalDistance / timeSpan; // pixels per second
  }

  private getDistance(p1: MousePosition, p2: MousePosition): number {
    return Math.sqrt(
      Math.pow(p2.x - p1.x, 2) + 
      Math.pow(p2.y - p1.y, 2)
    );
  }

  private filterSignificantPoints(points: MousePosition[], minDistance: number): MousePosition[] {
    const significant: MousePosition[] = [];
    
    points.forEach(point => {
      // Check if this point is far enough from all previous significant points
      const isFarEnough = significant.every(sigPoint => 
        this.getDistance(point, sigPoint) >= minDistance
      );

      if (isFarEnough || significant.length === 0) {
        significant.push(point);
      }
    });

    return significant;
  }

  private groupNearbyClicks(clicks: MousePosition[], threshold: number): MousePosition[][] {
    const groups: MousePosition[][] = [];
    let currentGroup: MousePosition[] = [];

    clicks.forEach(click => {
      if (currentGroup.length === 0 || 
          click.timestamp - currentGroup[currentGroup.length - 1].timestamp <= threshold) {
        currentGroup.push(click);
      } else {
        groups.push(currentGroup);
        currentGroup = [click];
      }
    });

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }

  private calculateHoverScore(positions: MousePosition[]): number {
    if (positions.length < 2) return 0;
    
    const timeSpan = positions[positions.length-1].timestamp - positions[0].timestamp;
    const totalMovement = this.calculateMouseActivity(positions) * timeSpan;
    
    // Higher score when mouse moves less
    return Math.max(0, 1 - (totalMovement / 100));
  }

  private calculateClickIntensity(positions: MousePosition[]): number {
    const clicks = positions.filter(p => p.isClicked);
    if (clicks.length <= 1) return 0;
    
    const timeSpan = clicks[clicks.length-1].timestamp - clicks[0].timestamp;
    return clicks.length / Math.max(timeSpan, 0.1); // clicks per second
  }

  private detectDramaticPause(positions: MousePosition[]): boolean {
    if (positions.length < 2) return false;
    
    const recentPositions = positions.slice(-5); // Look at last 5 positions
    const activity = this.calculateMouseActivity(recentPositions);
    const timeSpan = recentPositions[recentPositions.length-1].timestamp - recentPositions[0].timestamp;
    
    return activity < 10 && timeSpan >= this.DEFAULT_OPTIONS.dramaticPauseThreshold!;
  }

  private calculateEdgeProximity(point: MousePosition): number {
    const buffer = this.DEFAULT_OPTIONS.edgeBuffer!;
    
    // Calculate distance from edges as a percentage
    const edgeDistances = [
      point.x / 1920,                // Left edge
      point.y / 1080,                // Top edge
      (1920 - point.x) / 1920,       // Right edge
      (1080 - point.y) / 1080        // Bottom edge
    ];
    
    // Return how close we are to an edge (0 = far from edges, 1 = at edge)
    const closestEdge = Math.min(...edgeDistances);
    return Math.max(0, (buffer - closestEdge) / buffer);
  }

  private findBestZoomLevel(
    point: MousePosition,
    positions: MousePosition[],
    minZoom: number,
    maxZoom: number
  ): number {
    // Calculate screen center
    const screenCenterX = 1920 / 2;
    const screenCenterY = 1080 / 2;

    for (let testZoom = maxZoom; testZoom >= minZoom; testZoom -= 0.05) {
      // Calculate visible area at this zoom level
      const visibleWidth = 1920 / testZoom;
      const visibleHeight = 1080 / testZoom;
      
      // Stronger centering bias - pull the view center more towards screen center
      const centeringStrength = 0.45; // Increased from 0.3 to 0.45 (45% pull towards center)
      const viewCenterX = point.x * (1 - centeringStrength) + screenCenterX * centeringStrength;
      const viewCenterY = point.y * (1 - centeringStrength) + screenCenterY * centeringStrength;
      
      // Calculate bounds of visible area with centered bias
      const halfWidth = visibleWidth / 2;
      const halfHeight = visibleHeight / 2;
      const bounds = {
        left: viewCenterX - halfWidth,
        right: viewCenterX + halfWidth,
        top: viewCenterY - halfHeight,
        bottom: viewCenterY + halfHeight
      };

      // Increased padding to keep mouse further from edges
      const padding = 200; // Increased from 100 to 200 pixels
      const safetyMargin = 50; // Additional margin for movement
      const mouseStaysInView = positions.every(pos => 
        pos.x >= bounds.left + padding + safetyMargin &&
        pos.x <= bounds.right - padding - safetyMargin &&
        pos.y >= bounds.top + padding + safetyMargin &&
        pos.y <= bounds.bottom - padding - safetyMargin
      );

      if (mouseStaysInView) {
        return testZoom;
      }
    }
    return minZoom;
  }

  private detectIntentionalMovement(positions: MousePosition[]): boolean {
    if (positions.length < 3) return false;
    
    // Calculate average speed and direction changes
    let directionChanges = 0;
    let totalSpeed = 0;
    
    for (let i = 1; i < positions.length - 1; i++) {
      const prevVector = {
        x: positions[i].x - positions[i-1].x,
        y: positions[i].y - positions[i-1].y
      };
      const nextVector = {
        x: positions[i+1].x - positions[i].x,
        y: positions[i+1].y - positions[i].y
      };
      
      // Check for direction change
      const dot = prevVector.x * nextVector.x + prevVector.y * nextVector.y;
      if (dot < 0) directionChanges++;
      
      // Calculate speed
      const speed = this.getDistance(positions[i], positions[i+1]) / 
        (positions[i+1].timestamp - positions[i].timestamp);
      totalSpeed += speed;
    }
    
    const avgSpeed = totalSpeed / (positions.length - 1);
    const directionChangeRate = directionChanges / (positions.length - 2);
    
    // Movement is intentional if speed is above threshold and direction changes are minimal
    return avgSpeed >= this.DEFAULT_OPTIONS.mouseSpeedThreshold! && directionChangeRate < 0.3;
  }

  private isDoubleClick(positions: MousePosition[]): boolean {
    const clicks = positions.filter(p => p.isClicked);
    if (clicks.length < 2) return false;
    
    // Check last two clicks
    const lastTwo = clicks.slice(-2);
    return lastTwo[1].timestamp - lastTwo[0].timestamp < 0.3; // 300ms threshold
  }
}

export const autoZoomGenerator = new AutoZoomGenerator(); 