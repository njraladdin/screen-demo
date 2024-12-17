import { videoRenderer } from './videoRenderer';
import type { VideoSegment, BackgroundConfig, MousePosition } from '@/types/video';

interface VideoControllerOptions {
  videoRef: HTMLVideoElement;
  canvasRef: HTMLCanvasElement;
  tempCanvasRef: HTMLCanvasElement;
  onTimeUpdate?: (time: number) => void;
  onPlayingChange?: (isPlaying: boolean) => void;
  onVideoReady?: (ready: boolean) => void;
  onError?: (error: string) => void;
  onDurationChange?: (duration: number) => void;
}

interface VideoState {
  isPlaying: boolean;
  isReady: boolean;
  isSeeking: boolean;
  currentTime: number;
  duration: number;
}

interface RenderOptions {
  segment: VideoSegment;
  backgroundConfig: BackgroundConfig;
  mousePositions: MousePosition[];
}

export class VideoController {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private tempCanvas: HTMLCanvasElement;
  private options: VideoControllerOptions;
  private state: VideoState;
  private renderOptions?: RenderOptions;

  constructor(options: VideoControllerOptions) {
    this.video = options.videoRef;
    this.canvas = options.canvasRef;
    this.tempCanvas = options.tempCanvasRef;
    this.options = options;
    
    this.state = {
      isPlaying: false,
      isReady: false,
      isSeeking: false,
      currentTime: 0,
      duration: 0
    };

    this.initializeEventListeners();
  }

  private initializeEventListeners() {
    this.video.addEventListener('loadeddata', this.handleLoadedData);
    this.video.addEventListener('play', this.handlePlay);
    this.video.addEventListener('pause', this.handlePause);
    this.video.addEventListener('timeupdate', this.handleTimeUpdate);
    this.video.addEventListener('seeked', this.handleSeeked);
    this.video.addEventListener('loadedmetadata', this.handleLoadedMetadata);
    this.video.addEventListener('durationchange', this.handleDurationChange);
    this.video.addEventListener('error', this.handleError);
    
    // Add these new event listeners
    this.video.addEventListener('waiting', () => console.log('[VideoController] Video waiting'));
    this.video.addEventListener('stalled', () => console.log('[VideoController] Video stalled'));
    this.video.addEventListener('suspend', () => console.log('[VideoController] Video suspended'));
  }

  private handleLoadedData = () => {
    console.log('[VideoController] Video loaded data');
    
    // Start the renderer immediately when data is loaded
    videoRenderer.startAnimation({
      video: this.video,
      canvas: this.canvas,
      tempCanvas: this.tempCanvas,
      segment: this.renderOptions?.segment!,
      backgroundConfig: this.renderOptions?.backgroundConfig!,
      mousePositions: this.renderOptions?.mousePositions || [],
      currentTime: this.video.currentTime
    });
    
    this.setReady(true);
  };

  private handlePlay = () => {
    if (!this.state.isReady) {
      console.log('[VideoController] Play blocked - video not ready');
      this.video.pause();
      return;
    }
    
    console.log('[VideoController] Play event', {
      currentTime: this.video.currentTime,
      readyState: this.video.readyState,
      duration: this.video.duration,
      buffered: this.video.buffered.length > 0 ? {
        start: this.video.buffered.start(0),
        end: this.video.buffered.end(0)
      } : 'none'
    });

    // Ensure we have a render context when playing
    if (this.renderOptions) {
      videoRenderer.startAnimation({
        video: this.video,
        canvas: this.canvas,
        tempCanvas: this.tempCanvas,
        segment: this.renderOptions.segment,
        backgroundConfig: this.renderOptions.backgroundConfig,
        mousePositions: this.renderOptions.mousePositions,
        currentTime: this.video.currentTime
      });
    }

    this.setPlaying(true);
  };

  private handlePause = () => {
    console.log('[VideoController] Pause event', {
      currentTime: this.video.currentTime,
      readyState: this.video.readyState
    });
    this.setPlaying(false);
    this.renderFrame(); // Draw one last frame when paused
  };

  private handleTimeUpdate = () => {
    if (!this.state.isSeeking) {
      console.log('[VideoController] Time update', {
        time: this.video.currentTime,
        playing: !this.video.paused,
        readyState: this.video.readyState
      });
      this.setCurrentTime(this.video.currentTime);
      this.renderFrame();
    }
  };

  private handleSeeked = () => {
    console.log('Video seeked');
    this.setSeeking(false);
    this.renderFrame();
  };

  private handleLoadedMetadata = () => {
    console.log('Video metadata loaded:', {
      duration: this.video.duration,
      width: this.video.videoWidth,
      height: this.video.videoHeight
    });
    
    if (this.video.duration !== Infinity) {
      this.setDuration(this.video.duration);
    }
  };

  private handleDurationChange = () => {
    console.log('Duration changed:', this.video.duration);
    if (this.video.duration !== Infinity) {
      this.setDuration(this.video.duration);
    }
  };

  private handleError = (error: ErrorEvent) => {
    console.error('Video error:', error);
    this.options.onError?.(error.message);
  };

  private setPlaying(playing: boolean) {
    this.state.isPlaying = playing;
    this.options.onPlayingChange?.(playing);
  }

  private setReady(ready: boolean) {
    this.state.isReady = ready;
    this.options.onVideoReady?.(ready);
  }

  private setSeeking(seeking: boolean) {
    this.state.isSeeking = seeking;
  }

  private setCurrentTime(time: number) {
    this.state.currentTime = time;
    this.options.onTimeUpdate?.(time);
  }

  private setDuration(duration: number) {
    this.state.duration = duration;
    this.options.onDurationChange?.(duration);
  }

  private renderFrame() {
    if (!this.renderOptions) return;

    const renderContext = {
      video: this.video,
      canvas: this.canvas,
      tempCanvas: this.tempCanvas,
      segment: this.renderOptions.segment,
      backgroundConfig: this.renderOptions.backgroundConfig,
      mousePositions: this.renderOptions.mousePositions,
      currentTime: this.video.currentTime
    };

    // Only draw if video is ready
    if (this.video.readyState >= 2) {
      videoRenderer.drawFrame(renderContext);
    } else {
      console.log('[VideoController] Skipping frame - video not ready');
    }
  }

  // Public API
  public updateRenderOptions(options: RenderOptions) {
    this.renderOptions = options;
    this.renderFrame();
  }

  public play() {
    if (this.state.isReady) {
      this.video.play();
    }
  }

  public pause() {
    this.video.pause();
  }

  public seek(time: number) {
    this.setSeeking(true);
    this.video.currentTime = time;
  }

  public togglePlayPause() {
    if (this.state.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public destroy() {
    this.video.removeEventListener('loadeddata', this.handleLoadedData);
    this.video.removeEventListener('play', this.handlePlay);
    this.video.removeEventListener('pause', this.handlePause);
    this.video.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.video.removeEventListener('seeked', this.handleSeeked);
    this.video.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
    this.video.removeEventListener('durationchange', this.handleDurationChange);
    this.video.removeEventListener('error', this.handleError);
  }

  // Getters
  public get isPlaying() { return this.state.isPlaying; }
  public get isReady() { return this.state.isReady; }
  public get isSeeking() { return this.state.isSeeking; }
  public get currentTime() { return this.state.currentTime; }
  public get duration() { return this.state.duration; }

  // Add this new method
  public handleVideoSourceChange = (videoUrl: string) => {
    if (!this.video || !this.canvas) return;
    
    // Actually use the videoUrl
    this.video.src = videoUrl;
    
    const handleMetadata = () => {
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
        
        const ctx = this.canvas.getContext('2d');
        if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
        }
        
        this.video.removeEventListener('loadedmetadata', handleMetadata);
    };

    this.video.addEventListener('loadedmetadata', handleMetadata);
  };
}

export const createVideoController = (options: VideoControllerOptions) => {
  return new VideoController(options);
}; 