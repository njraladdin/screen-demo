export type ExportQuality = 'original' | 'high' | 'medium' | 'small';
export type DimensionPreset = 'original' | '1080p' | '720p' | '480p';

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
  cursorScale?: number;
  cursorSmoothness?: number;
  shadow?: number;
}

export interface MousePosition {
  x: number;
  y: number;
  timestamp: number;
  isClicked?: boolean;
}

export interface VideoMetadata {
  total_chunks: number;
  duration: number;
  width: number;
  height: number;
}

export interface ExportOptions {
  quality: ExportQuality;
  dimensions: DimensionPreset;
  video?: HTMLVideoElement;
  canvas?: HTMLCanvasElement;
  tempCanvas?: HTMLCanvasElement;
  segment?: VideoSegment;
  backgroundConfig?: BackgroundConfig;
  mousePositions?: MousePosition[];
  onProgress?: (progress: number) => void;
}

export interface ExportPreset {
  width: number;
  height: number;
  bitrate: number;
  label: string;
} 