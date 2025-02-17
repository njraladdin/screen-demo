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

interface LoadVideoOptions {
  videoUrl: string;
  onLoadingProgress?: (progress: number) => void;
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
      const currentTime = this.video.currentTime;
      
      // Add trim bounds handling
      if (this.renderOptions?.segment) {
        const { trimStart, trimEnd } = this.renderOptions.segment;
        
        // If we've reached the end of the trimmed section, pause and emit a custom event
        if (currentTime >= trimEnd) {
          this.video.pause();
          this.video.currentTime = trimEnd;
          this.setPlaying(false);
          // Dispatch a custom event to signal end of playback
          this.video.dispatchEvent(new Event('playbackcomplete'));
        }
        // If we're before the trim start, jump to trim start
        else if (currentTime < trimStart) {
          this.video.currentTime = trimStart;
        }
      }

      this.setCurrentTime(currentTime);
      this.renderFrame();
    }
  };

  private handleSeeked = () => {
    console.log('[VideoController] Seeked event fired', {
      currentTime: this.video.currentTime,
      readyState: this.video.readyState
    });
    this.setSeeking(false);
    this.setCurrentTime(this.video.currentTime);
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
      // Initialize segment if none exists
      if (!this.renderOptions?.segment) {
        this.renderOptions = {
          segment: this.initializeSegment(),
          backgroundConfig: {
            scale: 100,
            borderRadius: 8,
            backgroundType: 'solid'
          },
          mousePositions: []
        };
      }
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
      currentTime: this.getAdjustedTime(this.video.currentTime)
    };

    // Only draw if video is ready
    if (this.video.readyState >= 2) {
      videoRenderer.drawFrame(renderContext);
    } else {
     // console.log('[VideoController] Skipping frame - video not ready');
    }
  }

  // Public API
  public updateRenderOptions(options: RenderOptions) {
    this.renderOptions = options;
    this.renderFrame();
  }

  public play() {
    if (!this.state.isReady) return;
    
    // If we're at the trim end, jump back to trim start before playing
    if (this.renderOptions?.segment) {
      const { trimStart, trimEnd } = this.renderOptions.segment;
      if (this.video.currentTime >= trimEnd) {
        this.video.currentTime = trimStart;
      }
    }
    
    this.video.play();
  }

  public pause() {
    this.video.pause();
  }

  public seek(time: number) {
    console.log('[VideoController] Seeking to:', time);
    
    if (this.renderOptions?.segment) {
      const { trimStart, trimEnd } = this.renderOptions.segment;
      const trimDuration = trimEnd - trimStart;
      
      // Normalize the seek time to be within the trimmed section
      const normalizedTime = trimStart + ((time - trimStart) % trimDuration);
      time = normalizedTime;
    }
    
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
  public async loadVideo({ videoUrl, onLoadingProgress }: LoadVideoOptions): Promise<string> {
    try {
      // Reset states
      this.setReady(false);
      this.setSeeking(false);
      this.setPlaying(false);
      
      // Clear previous video
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();

      // Fetch the video data
      console.log('[VideoController] Fetching video data from:', videoUrl);
      const response = await fetch(videoUrl);
      if (!response.ok) throw new Error('Failed to fetch video');
      
      // Show download progress
      const reader = response.body!.getReader();
      const contentLength = +(response.headers.get('Content-Length') ?? 0);
      let receivedLength = 0;
      const chunks = [];

      while(true) {
        const {done, value} = await reader.read();
        if (done) break;
        
        chunks.push(value);
        receivedLength += value.length;
        const progress = Math.min(((receivedLength / contentLength) * 100), 100);
        onLoadingProgress?.(progress);
      }

      // Combine chunks into a single Uint8Array
      const videoData = new Uint8Array(receivedLength);
      let position = 0;
      for(const chunk of chunks) {
        videoData.set(chunk, position);
        position += chunk.length;
      }

      // Create blob and object URL
      const blob = new Blob([videoData], { type: 'video/mp4' });
      const objectUrl = URL.createObjectURL(blob);

      // Load the video
      await this.handleVideoSourceChange(objectUrl);
      
      return objectUrl;
    } catch (error) {
      console.error('[VideoController] Failed to load video:', error);
      throw error;
    }
  }

  // Update existing method to be private
  private async handleVideoSourceChange(videoUrl: string): Promise<void> {
    if (!this.video || !this.canvas) return;
    
    // Reset states
    this.setReady(false);
    this.setSeeking(false);
    this.setPlaying(false);
    
    // Reset video element
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    
    return new Promise<void>((resolve) => {
      const handleCanPlayThrough = () => {
        console.log('[VideoController] Video can play through');
        this.video.removeEventListener('canplaythrough', handleCanPlayThrough);
        
        // Set up canvas
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
        
        const ctx = this.canvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
        }
        
        this.setReady(true);
        resolve();
      };

      // Set up video
      this.video.addEventListener('canplaythrough', handleCanPlayThrough);
      this.video.preload = 'auto';
      this.video.src = videoUrl;
      this.video.load(); // Explicitly load the video
    });
  }

  // Add this new method to handle time adjustment
  private getAdjustedTime(time: number): number {
    if (!this.renderOptions?.segment) return time;
    
    const { trimStart, trimEnd } = this.renderOptions.segment;
    const trimDuration = trimEnd - trimStart;
    
    // Calculate the relative position within the trimmed section
    const relativeTime = ((time - trimStart) % trimDuration);
    
    // If time is negative, adjust it to wrap from the end
    const adjustedTime = relativeTime < 0 
      ? trimEnd + relativeTime 
      : trimStart + relativeTime;
      
    return adjustedTime;
  }

  // Add new method
  public initializeSegment(): VideoSegment {
    const initialSegment: VideoSegment = {
      trimStart: 0,
      trimEnd: this.duration,
      zoomKeyframes: [],
      textSegments: []
    };
    return initialSegment;
  }

  // Add this new method
  public isAtEnd(): boolean {
    if (!this.renderOptions?.segment) return false;
    const { trimEnd } = this.renderOptions.segment;
    return Math.abs(this.video.currentTime - trimEnd) < 0.1; // Allow 0.1s tolerance
  }
}

export const createVideoController = (options: VideoControllerOptions) => {
  return new VideoController(options);
}; 