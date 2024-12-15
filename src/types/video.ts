export interface ZoomKeyframe {
  time: number;
  duration: number;
  zoomFactor: number;
  positionX: number;
  positionY: number;
  easingType: 'linear' | 'easeOut' | 'easeInOut';
}

export interface VideoSegment {
  trimStart: number;
  trimEnd: number;
  zoomKeyframes: ZoomKeyframe[];
}

export interface BackgroundConfig {
  scale: number;
  borderRadius: number;
  backgroundType: 'solid' | 'gradient1' | 'gradient2' | 'gradient3';
}

export interface MousePosition {
  x: number;
  y: number;
  timestamp: number;
} 