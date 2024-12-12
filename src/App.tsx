import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Pause, Video, StopCircle, Plus, Trash2, Search, Download } from "lucide-react";
import "./App.css";
import { Button } from "@/components/ui/button";
import { exportVideo } from "@/lib/video-exporter";

let lastFrameTime = performance.now();

interface ZoomKeyframe {
  time: number;
  duration: number;
  zoomFactor: number;
  positionX: number;
  positionY: number;
  easingType: 'linear' | 'easeOut' | 'easeInOut';
}

interface VideoSegment {
  trimStart: number;
  trimEnd: number;
  zoomKeyframes: ZoomKeyframe[];
}

interface BackgroundConfig {
  scale: number;
  borderRadius: number;
  backgroundType: 'solid' | 'gradient1' | 'gradient2' | 'gradient3';
}

// Replace the debounce utility with throttle
const useThrottle = (callback: Function, limit: number) => {
  const lastRunRef = useRef<number>(0);
  
  return useCallback((...args: any[]) => {
    const now = Date.now();
    if (now - lastRunRef.current >= limit) {
      callback(...args);
      lastRunRef.current = now;
    }
  }, [callback, limit]);
};

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDraggingTrimStart, setIsDraggingTrimStart] = useState(false);
  const [isDraggingTrimEnd, setIsDraggingTrimEnd] = useState(false);
  const [segment, setSegment] = useState<VideoSegment | null>(null);
  const [editingKeyframeId, setEditingKeyframeId] = useState<number | null>(null);
  const [zoomFactor, setZoomFactor] = useState(1.5);
  const animationFrameRef = useRef<number>();
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Add this state to track if we're currently seeking
  const [isSeeking, setIsSeeking] = useState(false);

  // Add this state to track if we're currently drawing
  const isDrawingRef = useRef(false);

  // Add new state for the confirmation modal
  const [showConfirmNewRecording, setShowConfirmNewRecording] = useState(false);

  // Add this to your App component state
  const [backgroundConfig, setBackgroundConfig] = useState<BackgroundConfig>({
    scale: 100,
    borderRadius: 8,
    backgroundType: 'solid'
  });

  // Add this state to toggle between panels
  const [activePanel, setActivePanel] = useState<'zoom' | 'background'>('zoom');

  // Add these gradient constants
  const GRADIENT_PRESETS = {
    solid: 'bg-black',
    gradient1: 'bg-gradient-to-r from-blue-600 to-violet-600',
    gradient2: 'bg-gradient-to-r from-rose-400 to-orange-300',
    gradient3: 'bg-gradient-to-r from-emerald-500 to-teal-400'
  };

  // Draw the current frame on canvas
  const drawFrame = useCallback(() => {
    if (isDrawingRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !segment) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    isDrawingRef.current = true;

    try {
      const now = performance.now();
      const timeSinceLastFrame = now - lastFrameTime;
      if (timeSinceLastFrame < 16) {
        animationFrameRef.current = requestAnimationFrame(drawFrame);
        return;
      }
      lastFrameTime = now;

      // Update canvas dimensions to match video
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      // Get interpolated zoom state for current time
      const zoomState = calculateCurrentZoomState(video.currentTime);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (zoomState && zoomState.zoomFactor !== 1) {
        ctx.save();
        
        applyZoomTransform(
          ctx, 
          canvas, 
          zoomState.zoomFactor,
          zoomState.positionX,
          zoomState.positionY
        );
        
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      } else {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }

      if (!video.paused) {
        animationFrameRef.current = requestAnimationFrame(drawFrame);
      }
    } finally {
      isDrawingRef.current = false;
    }
  }, [currentTime, segment]);

  // Separate animation frame management into its own effect
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const animate = () => {
      drawFrame();
      if (!video.paused) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    if (!video.paused) {
      animationFrameRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [drawFrame, isPlaying]);

  // Simplify video event handlers
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadedData = () => {
      debugLog('Video loaded data');
      // Ensure we're at the start
      video.currentTime = 0;
      // Draw the first frame
      drawFrame();
    };

    const handlePlay = () => {
      debugLog('Video event: play');
      setIsPlaying(true);
    };

    const handlePause = () => {
      debugLog('Video event: pause');
      setIsPlaying(false);
      // Draw one last frame when paused
      drawFrame();
    };

    const handleTimeUpdate = () => {
      if (!isSeeking && segment) {
        setCurrentTime(video.currentTime);
        
        // Find if we're at a keyframe
        const keyframeIndex = segment.zoomKeyframes.findIndex(keyframe => 
          Math.abs(video.currentTime - keyframe.time) < 0.1 // Small threshold
        );

        if (keyframeIndex !== -1) {
          setEditingKeyframeId(keyframeIndex);
          setZoomFactor(segment.zoomKeyframes[keyframeIndex].zoomFactor);
        } else {
          setEditingKeyframeId(null);
        }
      }
    };

    const handleSeeked = () => {
      debugLog('Video: seeked');
      setIsSeeking(false);
      drawFrame();
    };

    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('seeked', handleSeeked);

    return () => {
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('seeked', handleSeeked);
    };
  }, [drawFrame, isSeeking, segment]);

  // Update handleStartRecording to show confirmation when needed
  async function handleStartRecording() {
    if (isRecording) return;

    // If we already have a video, show confirmation first
    if (currentVideo) {
      setShowConfirmNewRecording(true);
      return;
    }

    // Otherwise start recording directly
    await startNewRecording();
  }

  // Separate the actual recording logic
  async function startNewRecording() {
    try {
      await invoke("start_recording");
      setIsRecording(true);
      setError(null);
      
      // Clear previous video
      if (currentVideo) {
        URL.revokeObjectURL(currentVideo);
        setCurrentVideo(null);
      }
      
      // Reset all state
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      setSegment(null);
      setZoomFactor(1.5);
      setEditingKeyframeId(null);
      setIsDraggingTrimStart(false);
      setIsDraggingTrimEnd(false);
      
      // Reset video element
      if (videoRef.current) {
        videoRef.current.src = '';
        videoRef.current.currentTime = 0;
      }
      
      // Clear canvas
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }
    } catch (err) {
      console.error("Failed to start recording:", err);
      setError(err as string);
    }
  }

  async function handleStopRecording() {
    if (!isRecording) return;

    try {
      setIsRecording(false);
      setIsLoadingVideo(true);
      
      const videoData = await invoke<number[]>("stop_recording");
      
      const uint8Array = new Uint8Array(videoData);
      const blob = new Blob([uint8Array], { 
        type: "video/mp4; codecs=avc1.42E01E,mp4a.40.2" 
      });
      
      const url = URL.createObjectURL(blob);
      setCurrentVideo(url);

      if (videoRef.current) {
        videoRef.current.src = url;
        videoRef.current.load();
        // Just play the video - no need to pause
        await videoRef.current.play();
        setIsPlaying(true); // Update playing state
      }
      
    } catch (err) {
      console.error("Failed to stop recording:", err);
      setError(err as string);
    } finally {
      setIsLoadingVideo(false);
    }
  }

  // Initialize segment when video loads
  useEffect(() => {
    if (duration > 0 && !segment) {
      const initialSegment: VideoSegment = {
        trimStart: 0,
        trimEnd: duration,
        zoomKeyframes: []
      };
      setSegment(initialSegment);
    }
  }, [duration, segment]);

  // Handle trim dragging
  const handleTrimDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDraggingTrimStart || isDraggingTrimEnd) {
      const timeline = timelineRef.current;
      if (!timeline || !segment) return;

      const rect = timeline.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const percent = x / rect.width;
      const newTime = percent * duration;

      if (isDraggingTrimStart) {
        const newTrimStart = Math.min(newTime, segment.trimEnd - 0.1);
        setSegment({
          ...segment,
          trimStart: Math.max(0, newTrimStart)
        });
      }
      if (isDraggingTrimEnd) {
        const newTrimEnd = Math.max(newTime, segment.trimStart + 0.1);
        setSegment({
          ...segment,
          trimEnd: Math.min(duration, newTrimEnd)
        });
      }

      if (videoRef.current) {
        videoRef.current.currentTime = newTime;
      }
    }
  };

  // Update video playback to respect trim bounds and handle looping
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !segment) return;

    const handleTimeUpdate = () => {
      if (video.currentTime >= segment.trimEnd) {
        // Instead of pausing, loop back to trim start
        video.currentTime = segment.trimStart;
        // Don't stop playback
      } else if (video.currentTime < segment.trimStart) {
        video.currentTime = segment.trimStart;
      }
    };

    // Also handle the 'ended' event to loop
    const handleEnded = () => {
      if (isPlaying) {
        video.currentTime = segment.trimStart;
        video.play().catch(error => {
          debugLog('Error restarting video:', error);
          setIsPlaying(false);
        });
      }
    };

    if (video.currentTime < segment.trimStart || video.currentTime > segment.trimEnd) {
      video.currentTime = segment.trimStart;
    }

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('ended', handleEnded);
    
    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('ended', handleEnded);
    };
  }, [segment, isPlaying]);

  // Modify existing handleTimelineClick
  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDraggingTrimStart || isDraggingTrimEnd) return;
    
    const timeline = timelineRef.current;
    const video = videoRef.current;
    if (!timeline || !video || !segment) return;

    const rect = timeline.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = x / rect.width;
    const newTime = percent * duration;
    
    if (newTime >= segment.trimStart && newTime <= segment.trimEnd) {
      video.currentTime = newTime;
      setCurrentTime(newTime);
      // Don't automatically set editing state when clicking timeline
      setEditingKeyframeId(null);
    }
  };

  // Toggle play/pause
  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      debugLog('togglePlayPause: No video element');
      return;
    }
    
    debugLog('togglePlayPause called', {
      readyState: video.readyState,
      currentTime: video.currentTime,
      paused: video.paused,
      networkState: video.networkState,
      buffered: video.buffered.length > 0,
      seeking: video.seeking
    });

    if (isPlaying) {
      debugLog('Attempting to pause video');
      video.pause();
    } else {
      debugLog('Attempting to play video');
      // Ensure video is ready before playing
      if (video.readyState >= 2) { // HAVE_CURRENT_DATA
        video.play()
          .then(() => {
            debugLog('Video started playing successfully');
          })
          .catch(error => {
            debugLog('Error playing video:', error);
            setIsPlaying(false);
          });
      } else {
        debugLog('Video not ready to play', { readyState: video.readyState });
      }
    }
  }, [isPlaying]);

  // Add this effect to handle metadata loading
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadedMetadata = () => {
      debugLog('Video loaded metadata', {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight
      });
      
      if (video.duration !== Infinity) {
        setDuration(video.duration);
      }
    };

    const handleDurationChange = () => {
      debugLog('Duration changed:', video.duration);
      if (video.duration !== Infinity) {
        setDuration(video.duration);
      }
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('durationchange', handleDurationChange);

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('durationchange', handleDurationChange);
    };
  }, []);

  // Add debug logging utility
  const debugLog = (message: string, data?: any) => {
    if (process.env.NODE_ENV === 'development') {
      if (data) {
        console.log(`[DEBUG] ${message}`, data);
      } else {
        console.log(`[DEBUG] ${message}`);
      }
    }
  };

  // Add these helper functions for zoom transitions
  const applyZoomTransform = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    zoom: number,
    posX: number,
    posY: number
  ) => {
    const scaledWidth = canvas.width * zoom;
    const scaledHeight = canvas.height * zoom;
    const offsetX = (canvas.width - scaledWidth) * posX;
    const offsetY = (canvas.height - scaledHeight) * posY;
    
    ctx.translate(offsetX, offsetY);
    ctx.scale(zoom, zoom);
  };

  const calculateZoomTransition = (
    currentTime: number,
    activeZoom: ZoomKeyframe,
    previousZoom: ZoomKeyframe | null
  ) => {
    const TRANSITION_DURATION = 1.0;
    const transitionProgress = Math.min(
      (currentTime - activeZoom.time) / TRANSITION_DURATION,
      1
    );
    const easedProgress = easeOutCubic(transitionProgress);

    if (previousZoom) {
      return {
        currentZoom: previousZoom.zoomFactor + (activeZoom.zoomFactor - previousZoom.zoomFactor) * easedProgress,
        currentPosX: previousZoom.positionX + (activeZoom.positionX - previousZoom.positionX) * easedProgress,
        currentPosY: previousZoom.positionY + (activeZoom.positionY - previousZoom.positionY) * easedProgress
      };
    }

    return {
      currentZoom: 1 + (activeZoom.zoomFactor - 1) * easedProgress,
      currentPosX: activeZoom.positionX,
      currentPosY: activeZoom.positionY
    };
  };

  const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);

  // Update calculateCurrentZoomState to handle smooth transitions
  const calculateCurrentZoomState = (time: number) => {
    if (!segment) return null;

    const sortedKeyframes = [...segment.zoomKeyframes].sort((a, b) => a.time - b.time);
    
    if (sortedKeyframes.length === 0) {
      return { zoomFactor: 1, positionX: 0.5, positionY: 0.5 };
    }

    const ANIMATION_DURATION = 1.0; // Standard 1 second animation

    // Special handling for the first keyframe
      const firstKeyframe = sortedKeyframes[0];
    
    // If we're before or at the first keyframe
    if (time <= firstKeyframe.time) {
      const timeToKeyframe = firstKeyframe.time - time;
      
      // If we're within the animation period
      if (timeToKeyframe <= ANIMATION_DURATION) {
        const progress = 1 - (timeToKeyframe / ANIMATION_DURATION);
        const easedProgress = getEasingFunction('easeOut')(progress);
        
        return {
          zoomFactor: 1 + (firstKeyframe.zoomFactor - 1) * easedProgress,
          positionX: 0.5 + (firstKeyframe.positionX - 0.5) * easedProgress,
          positionY: 0.5 + (firstKeyframe.positionY - 0.5) * easedProgress
        };
      }
      
      return { zoomFactor: 1, positionX: 0.5, positionY: 0.5 };
    }

    // Find the surrounding keyframes for current time
    const currentKeyframeIndex = sortedKeyframes.findIndex(k => k.time > time) - 1;
    
    // If we're after the last keyframe
    if (currentKeyframeIndex === sortedKeyframes.length - 1) {
      return sortedKeyframes[currentKeyframeIndex];
    }

    // We're between two keyframes
    const currentKeyframe = sortedKeyframes[currentKeyframeIndex];
    const nextKeyframe = sortedKeyframes[currentKeyframeIndex + 1];
    
    const timeBetweenKeyframes = nextKeyframe.time - currentKeyframe.time;
    
    // If keyframes are more than 1 second apart
    if (timeBetweenKeyframes > ANIMATION_DURATION) {
      const timeToNextKeyframe = nextKeyframe.time - time;
      
      // Only start animation 1 second before next keyframe
      if (timeToNextKeyframe <= ANIMATION_DURATION) {
        const progress = 1 - (timeToNextKeyframe / ANIMATION_DURATION);
        const easedProgress = getEasingFunction(currentKeyframe.easingType)(progress);
        
        return {
          zoomFactor: currentKeyframe.zoomFactor + (nextKeyframe.zoomFactor - currentKeyframe.zoomFactor) * easedProgress,
          positionX: currentKeyframe.positionX + (nextKeyframe.positionX - currentKeyframe.positionX) * easedProgress,
          positionY: currentKeyframe.positionY + (nextKeyframe.positionY - currentKeyframe.positionY) * easedProgress
        };
      }
      
      return currentKeyframe;
    }
    
    // If keyframes are less than 1 second apart, animate over the entire duration
    const progress = (time - currentKeyframe.time) / timeBetweenKeyframes;
    const easedProgress = getEasingFunction(currentKeyframe.easingType)(progress);

    return {
      zoomFactor: currentKeyframe.zoomFactor + (nextKeyframe.zoomFactor - currentKeyframe.zoomFactor) * easedProgress,
      positionX: currentKeyframe.positionX + (nextKeyframe.positionX - currentKeyframe.positionX) * easedProgress,
      positionY: currentKeyframe.positionY + (nextKeyframe.positionY - currentKeyframe.positionY) * easedProgress
    };
  };

  // First, let's add a type for easing functions
  type EasingType = 'linear' | 'easeOut' | 'easeInOut';

  // Add a helper function to get easing function
  const getEasingFunction = (type: EasingType) => {
    switch (type) {
      case 'linear':
        return (x: number) => x;
      case 'easeOut':
        return (x: number) => 1 - Math.pow(1 - x, 3);
      case 'easeInOut':
        return (x: number) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    }
  };

  // Update findPreviousZoom to match the expected signature
  const findPreviousZoom = (effects: ZoomKeyframe[], currentTime: number) => {
    return [...effects]
      .sort((a, b) => b.time - a.time)
      .find(k => k.time < currentTime);
  };

  const handleExport = async () => {
    if (!currentVideo || !segment || !videoRef.current) return;
    
    try {
      setIsProcessing(true);
      await exportVideo({
        video: videoRef.current,
        segment: {
          ...segment,
          zoomEffects: segment.zoomKeyframes
        },
        onProgress: setExportProgress,
        findPreviousZoom: findPreviousZoom,  // This should now match the expected type
        calculateZoomTransition
      });
    } catch (error) {
      console.error('Error processing video:', error);
    } finally {
      setIsProcessing(false);
      setExportProgress(0);
    }
  };

  // Update handleAddKeyframe to include duration
  const handleAddKeyframe = () => {
    if (!segment || !videoRef.current) return;
    
    const currentTime = videoRef.current.currentTime;
    
    // Find the previous keyframe to inherit its values
    const previousKeyframe = [...segment.zoomKeyframes]
      .sort((a, b) => b.time - a.time) // Sort in reverse order
      .find(k => k.time < currentTime);

    const newKeyframe: ZoomKeyframe = {
      time: currentTime,
      duration: 0.5,
      // Inherit values from previous keyframe if it exists, otherwise use defaults
      zoomFactor: previousKeyframe ? previousKeyframe.zoomFactor : 1.5,
      positionX: previousKeyframe ? previousKeyframe.positionX : 0.5,
      positionY: previousKeyframe ? previousKeyframe.positionY : 0.5,
      easingType: 'easeOut'
    };

    const newKeyframes = [...segment.zoomKeyframes, newKeyframe].sort((a, b) => a.time - b.time);
    setSegment({
      ...segment,
      zoomKeyframes: newKeyframes
    });
    
    setZoomFactor(newKeyframe.zoomFactor);
    setEditingKeyframeId(newKeyframes.indexOf(newKeyframe));
  };

  // Update handleKeyframeChange to preview changes
  const handleKeyframeChange = (
    keyframeId: number,
    updates: Partial<ZoomKeyframe>
  ) => {
    if (!segment || !videoRef.current) return;
    
    const updatedKeyframes = segment.zoomKeyframes.map((keyframe, index) =>
      index === keyframeId
        ? { ...keyframe, ...updates }
        : keyframe
    );

    setSegment({
      ...segment,
      zoomKeyframes: updatedKeyframes
    });

    // Force a redraw to show the changes immediately
    requestAnimationFrame(() => {
      drawFrame();
    });
  };

  // Add throttled update function for zoom configuration
  const throttledUpdateZoom = useThrottle((updates: Partial<ZoomKeyframe>) => {
    if (!segment || editingKeyframeId === null) return;
    
    const updatedKeyframes = segment.zoomKeyframes.map((keyframe, index) =>
      index === editingKeyframeId
        ? { ...keyframe, ...updates }
        : keyframe
    );

    setSegment({
      ...segment,
      zoomKeyframes: updatedKeyframes
    });

    // Force a redraw to show the changes
    requestAnimationFrame(() => {
      drawFrame();
    });
  }, 32); // 32ms throttle

  return (
    <div className="min-h-screen bg-[#1a1a1b]">
      {/* Header */}
      <header className="bg-[#1a1a1b] border-b border-[#343536]">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-[#d7dadc]">Video Editor</h1>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Controls */}
        <div className="flex justify-between items-center gap-4 mb-6">
          <div className="flex gap-4">
            <button
              onClick={isRecording ? handleStopRecording : handleStartRecording}
              disabled={isProcessing || isLoadingVideo}
              className={`flex items-center px-4 py-2 rounded-md text-white transition-colors
                ${isRecording 
                  ? 'bg-red-500 hover:bg-red-600' 
                  : 'bg-[#0079d3] hover:bg-[#1484d6]'
                }`}
            >
              {isRecording ? (
                <>
                  <StopCircle className="w-4 h-4 mr-2" />
                  Stop Recording
                </>
              ) : isLoadingVideo ? (
                <>
                  <span className="animate-spin mr-2">⏳</span>
                  Loading Video...
                </>
              ) : (
                <>
                  <Video className="w-4 h-4 mr-2" />
                  {currentVideo ? 'Start New Recording' : 'Start Recording'}
                </>
              )}
            </button>
          </div>

          {/* Export Button - Now in the controls section */}
          {segment && segment.zoomKeyframes && segment.zoomKeyframes.length > 0 && (
          <Button
              onClick={handleExport}
              disabled={isProcessing}
              className="bg-[#0079d3] hover:bg-[#1484d6] text-white px-6"
            >
              <Download className="w-4 h-4 mr-2" />
              Export Video with Effects
          </Button>
          )}
        </div>

        {error && (
          <p className="text-red-500 mb-4">{error}</p>
        )}
        
        {isRecording && (
          <p className="text-[#0079d3] mb-4">Recording in progress...</p>
        )}

        <div className="space-y-6">
          {/* Video Preview and Zoom Configuration Side by Side */}
          <div className="grid grid-cols-3 gap-6 items-start">
            {/* Video Preview Section - Takes up 2/3 of the space */}
            <div className={`col-span-2 rounded-lg ${GRADIENT_PRESETS[backgroundConfig.backgroundType]}`}>
              {/* Fixed size container */}
              <div className="aspect-video relative">
                {/* Centered scaling container - removed extra padding */}
                <div 
                  className="absolute inset-0 flex items-center justify-center"
                >
                  <div 
                    className="relative w-full h-full"
              style={{
                      maxWidth: `${backgroundConfig.scale}%`,
                      maxHeight: `${backgroundConfig.scale}%`
              }}
                  >
                <div
                      className="w-full h-full overflow-hidden"
                  style={{
                        borderRadius: `${backgroundConfig.borderRadius}px`
                      }}
                    >
                      {/* Video and canvas elements */}
                      <video 
                        ref={videoRef}
                        className="hidden"
                        playsInline
                        preload="auto"
                        crossOrigin="anonymous"
                      />
                      
                      <canvas 
                        ref={canvasRef}
                        className="w-full h-full object-contain"
                  style={{
                          imageRendering: 'pixelated'
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Playback Controls - Now positioned relative to the container */}
                <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2 bg-black/30 rounded-full p-2 backdrop-blur-sm z-10">
                  <Button
                    onClick={togglePlayPause}
                    disabled={isProcessing || !currentVideo}
                    variant="ghost"
                    className={`transition-colors ${
                      !currentVideo || isProcessing
                        ? 'text-gray-500 bg-gray-600/50 hover:bg-gray-600/50 cursor-not-allowed' 
                        : 'text-white hover:bg-white/20 hover:text-white'
                    }`}
                  >
                    {isPlaying ? (
                      <Pause className="w-6 h-6" />
                    ) : (
                      <Play className="w-6 h-6" />
                    )}
                  </Button>
                  <div className="text-white/90 px-2 flex items-center">
                    {formatTime(currentTime)} / {formatTime(duration)}
          </div>
                </div>
              </div>
        </div>

            {/* Side Panel - More compact layout */}
            <div className="col-span-1 space-y-3">
              {/* Panel Toggle Buttons - Made more compact */}
              <div className="flex gap-1.5">
          <Button
            onClick={() => setActivePanel('zoom')}
                  variant={activePanel === 'zoom' ? 'default' : 'outline'}
                  size="sm"
                  className={`flex-1 ${
                    activePanel === 'zoom' 
                      ? 'bg-[#0079d3] text-white' 
                      : 'text-[#d7dadc] border-[#343536]'
                  }`}
                >
                  Zoom
          </Button>
          <Button
            onClick={() => setActivePanel('background')}
                  variant={activePanel === 'background' ? 'default' : 'outline'}
                  size="sm"
                  className={`flex-1 ${
                    activePanel === 'background' 
                      ? 'bg-[#0079d3] text-white' 
                      : 'text-[#d7dadc] border-[#343536]'
                  }`}
                >
                  Background
          </Button>
        </div>

              {activePanel === 'zoom' ? (
                <>
                  {(editingKeyframeId !== null) ? (
                    <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-4">
                      <div className="flex justify-between items-center mb-4">
                        <h2 className="text-base font-semibold text-[#d7dadc]">Zoom Configuration</h2>
                        {editingKeyframeId !== null && (
                          <Button
                            onClick={() => {
                              if (segment && editingKeyframeId !== null) {
                                setSegment({
                                  ...segment,
                                  zoomKeyframes: segment.zoomKeyframes.filter((_, i) => i !== editingKeyframeId)
                                });
                                setEditingKeyframeId(null);
                              }
                            }}
                            variant="ghost"
                            size="icon"
                            className="text-white"
                          >
                            <Trash2 className="w-5 h-5" />
                          </Button>
                        )}
                      </div>

                      <div className="space-y-4">
                        {/* Zoom Factor Control */}
                        <div>
                          <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                            Zoom Factor
                          </label>
            <div className="space-y-2">
              <input
                type="range"
                min="1"
                max="3"
                              step="0.1"
                value={zoomFactor}
                              onChange={(e) => {
                                const newValue = Number(e.target.value);
                                setZoomFactor(newValue);
                                throttledUpdateZoom({ zoomFactor: newValue });
                              }}
                              className="w-full accent-[#0079d3]"
                            />
                            <div className="flex justify-between text-sm text-[#818384]">
                              <span>No zoom</span>
                              <span>{Math.round((zoomFactor - 1) * 100)}%</span>
                              <span>200%</span>
            </div>
              </div>
            </div>

                        {/* Position Controls */}
                        <div className="space-y-4">
                          <div>
                            <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                              Horizontal Position
                            </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                              value={segment?.zoomKeyframes[editingKeyframeId!]?.positionX ?? 0.5}
                              onChange={(e) => {
                                throttledUpdateZoom({ positionX: Number(e.target.value) });
                              }}
                              className="w-full accent-[#0079d3]"
              />
            </div>

                          <div>
                            <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                              Vertical Position
                            </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                              value={segment?.zoomKeyframes[editingKeyframeId!]?.positionY ?? 0.5}
                              onChange={(e) => {
                                throttledUpdateZoom({ positionY: Number(e.target.value) });
                              }}
                              className="w-full accent-[#0079d3]"
              />
            </div>
              </div>
            </div>
            </div>
                  ) : (
                    <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-4 flex flex-col items-center justify-center text-center">
                      <div className="bg-[#272729] rounded-full p-2 mb-2">
                        <Search className="w-5 h-5 text-[#818384]" />
                      </div>
                      <p className="text-[#d7dadc] font-medium text-sm">No Zoom Effect Selected</p>
                      <p className="text-[#818384] text-xs mt-1">
                        Select a zoom effect on the timeline or add a new one
                      </p>
          </div>
        )}
                </>
              ) : (
                <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-4">
                  <h2 className="text-base font-semibold text-[#d7dadc] mb-4">Background & Layout</h2>
                  
                  <div className="space-y-4">
                    {/* Padding Control - More compact */}
                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-1.5">
                        Video Size
                      </label>
                      <div className="space-y-1">
              <input
                type="range"
                min="50"
                max="100"
                value={backgroundConfig.scale}
                          onChange={(e) => {
                            setBackgroundConfig(prev => ({
                              ...prev,
                              scale: Number(e.target.value)
                            }));
                          }}
                          className="w-full accent-[#0079d3]"
                        />
                        <div className="flex justify-between text-xs text-[#818384]">
                          <span>50%</span>
                          <span>{backgroundConfig.scale}%</span>
                          <span>100%</span>
                        </div>
                      </div>
            </div>

                    {/* Border Radius Control - More compact */}
                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-1.5">
                        Border Radius
                      </label>
                      <div className="space-y-1">
              <input
                type="range"
                min="0"
                max="64"
                value={backgroundConfig.borderRadius}
                          onChange={(e) => {
                            setBackgroundConfig(prev => ({
                              ...prev,
                              borderRadius: Number(e.target.value)
                            }));
                          }}
                          className="w-full accent-[#0079d3]"
                        />
                        <div className="flex justify-between text-xs text-[#818384]">
                          <span>0px</span>
                          <span>{backgroundConfig.borderRadius}px</span>
                          <span>64px</span>
                        </div>
                      </div>
            </div>

                    {/* Background Type Selection - More compact */}
                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                        Background Style
                      </label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {Object.entries(GRADIENT_PRESETS).map(([key, gradient]) => (
                          <button
                    key={key}
                            onClick={() => setBackgroundConfig(prev => ({
                              ...prev,
                              backgroundType: key as BackgroundConfig['backgroundType']
                            }))}
                            className={`
                              h-12 rounded-lg
                              ${gradient}
                              ${backgroundConfig.backgroundType === key 
                                ? 'ring-2 ring-[#0079d3] ring-offset-1 ring-offset-[#1a1a1b]' 
                                : 'ring-1 ring-[#343536]'
                              }
                            `}
                  />
                ))}
                      </div>
              </div>
            </div>
          </div>
        )}
            </div>
      </div>

          {/* Timeline Section */}
          <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6">
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-lg font-semibold text-[#d7dadc]">Timeline</h2>
              <Button 
                onClick={handleAddKeyframe}
                disabled={isProcessing || !currentVideo}
                className={`${
                  !currentVideo || isProcessing
                    ? 'bg-gray-600 text-gray-400 hover:bg-gray-600 cursor-not-allowed'
                    : 'bg-[#0079d3] hover:bg-[#1484d6] text-white'
                }`}
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Zoom at Playhead
              </Button>
            </div>

              <div className="relative h-32">
                {/* Timeline markers */}
                <div className="absolute w-full flex justify-between text-xs text-[#d7dadc] z-40 pointer-events-none">
                  {Array.from({ length: 11 }).map((_, i) => {
                    const time = (duration * i) / 10;
                    return (
                      <div key={i} className="flex flex-col items-center">
                        <span className="mb-1">{formatTime(time)}</span>
                        <div className="h-2 w-0.5 bg-[#d7dadc]/20" />
                      </div>
                    );
                  })}
                </div>

                {/* Timeline base */}
                <div
                  ref={timelineRef}
                  className="h-12 bg-[#272729] rounded-lg cursor-pointer relative mt-8"
                  onClick={handleTimelineClick}
                  onMouseMove={handleTrimDrag}
                  onMouseUp={() => {
                    setIsDraggingTrimStart(false);
                    setIsDraggingTrimEnd(false);
                  }}
                  onMouseLeave={() => {
                    setIsDraggingTrimStart(false);
                    setIsDraggingTrimEnd(false);
                  }}
                >
                  {/* Trimmed areas overlay */}
                  {segment && (
                    <>
                      <div
                        className="absolute top-0 bottom-0 bg-black/50"
                        style={{
                          left: 0,
                          width: `${(segment.trimStart / duration) * 100}%`,
                        }}
            />
            <div
                        className="absolute top-0 bottom-0 bg-black/50"
              style={{
                          right: 0,
                          width: `${((duration - segment.trimEnd) / duration) * 100}%`,
                        }}
                      />
                    </>
                  )}

                  {/* Trim handles */}
                  {segment && (
                    <>
                      <div
                        className="absolute top-0 bottom-0 w-1 bg-[#d7dadc] cursor-col-resize z-30 hover:bg-[#0079d3]"
                        style={{
                          left: `${(segment.trimStart / duration) * 100}%`,
                        }}
                        onMouseDown={() => setIsDraggingTrimStart(true)}
                      />
                      <div
                        className="absolute top-0 bottom-0 w-1 bg-[#d7dadc] cursor-col-resize z-30 hover:bg-[#0079d3]"
                        style={{
                          left: `${(segment.trimEnd / duration) * 100}%`,
                        }}
                        onMouseDown={() => setIsDraggingTrimEnd(true)}
                      />
                    </>
                  )}

                  {/* Zoom effects */}
                  {segment?.zoomKeyframes.map((keyframe, index) => {
                    const active = editingKeyframeId === index;
                    
                    return (
                      <div
                        key={index}
                        className="absolute cursor-pointer group"
                        style={{
                          left: `${(keyframe.time / duration) * 100}%`,
                          transform: 'translateX(-50%)', // Center the entire marker
                          top: '-32px', // Move up to avoid playhead
                          height: '56px', // Fixed height for consistent alignment
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (videoRef.current) {
                            videoRef.current.currentTime = keyframe.time;
                            setCurrentTime(keyframe.time);
                            setEditingKeyframeId(index);
                          }
                        }}
                      >
                        {/* Container for vertical alignment */}
                        <div className="relative flex flex-col items-center">
                          {/* Zoom value label */}
                          <div className={`
                            px-2 py-1 mb-1 rounded-full text-xs font-medium whitespace-nowrap
                            ${active ? 'bg-[#0079d3] text-white' : 'bg-[#0079d3]/20 text-[#0079d3]'}
                          `}>
                            {Math.round((keyframe.zoomFactor - 1) * 100)}%
                          </div>

                          {/* Keyframe dot */}
                          <div className={`
                            w-3 h-3 bg-[#0079d3] rounded-full 
                            hover:scale-125 transition-transform
                            ${active ? 'ring-2 ring-white' : ''}
                          `} />

                          {/* Vertical line - adjusted height to match timeline */}
                          <div className="w-[1px] h-10 bg-[#0079d3]/30 group-hover:bg-[#0079d3]/50" />
                        </div>
                      </div>
                    );
                  })}

                  {/* Playhead - Keep it in front with red color */}
                  <div 
                    className="absolute top-[-16px] bottom-0 flex flex-col items-center pointer-events-none z-30"
                    style={{ 
                      left: `${(currentTime / duration) * 100}%`,
                      transform: 'translateX(-50%)',
                    }}
                  >
                    <div className={`w-4 h-3 ${!currentVideo ? 'bg-gray-600' : 'bg-red-500'} rounded-t`} />
                    <div className={`w-0.5 flex-1 ${!currentVideo ? 'bg-gray-600' : 'bg-red-500'}`} />
                  </div>
                </div>

                {/* Time display */}
                <div className="text-center font-mono text-sm text-[#818384] mt-4">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </div>
              </div>
            </div>
         
        </div>
      </main>

      {isProcessing && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536]">
            <p className="text-lg text-[#d7dadc]">
              {exportProgress > 0 
                ? `Exporting video... ${Math.round(exportProgress)}%`
                : 'Processing video...'}
            </p>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {showConfirmNewRecording && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536] max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-[#d7dadc] mb-4">
              Start New Recording?
            </h3>
            <p className="text-[#818384] mb-6">
              Starting a new recording will discard your current video. Are you sure you want to continue?
            </p>
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setShowConfirmNewRecording(false)}
                className="bg-transparent border-[#343536] text-[#d7dadc] hover:bg-[#272729] hover:text-[#d7dadc]"
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setShowConfirmNewRecording(false);
                  startNewRecording();
                }}
                className="bg-[#0079d3] hover:bg-[#1484d6] text-white"
              >
                Start New Recording
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper function to format time
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

export default App;

