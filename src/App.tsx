import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Pause, Video, StopCircle, Plus, Trash2, Search, Download } from "lucide-react";
import "./App.css";
import { Button } from "@/components/ui/button";


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

  // Add at the top of your component
  const tempCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));

  // First, update the drawFrame signature to handle export mode
  const drawFrame = useCallback(async (exportMode = false, onExportProgress?: (progress: number) => void) => {
    if (isDrawingRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !segment) return;

    // Make sure video is ready
    if (video.readyState < 2) {  // HAVE_CURRENT_DATA
      if (!exportMode) {
        requestAnimationFrame(drawFrame);
      }
      return;
    }

    const ctx = canvas.getContext('2d');
    
    if (!ctx) return;

    isDrawingRef.current = true;

    try {
      // Skip frame rate limiting during export
      if (!exportMode) {
        const now = performance.now();
        const timeSinceLastFrame = now - lastFrameTime;
        if (timeSinceLastFrame < 8) {
          animationFrameRef.current = requestAnimationFrame(drawFrame);
          return;
        }
        lastFrameTime = now;
      }

      // Set canvas size to match video
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      // Draw background
      ctx.fillStyle = getBackgroundStyle(ctx, backgroundConfig.backgroundType);
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Calculate scaled dimensions
      const scale = backgroundConfig.scale / 100;
      const scaledWidth = canvas.width * scale;
      const scaledHeight = canvas.height * scale;
      const x = (canvas.width - scaledWidth) / 2;
      const y = (canvas.height - scaledHeight) / 2;

      // Create temporary canvas for rounded corners
      const tempCanvas = tempCanvasRef.current;
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
      const zoomState = calculateCurrentZoomState(video.currentTime);

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

      if (!exportMode && !video.paused) {
        animationFrameRef.current = requestAnimationFrame(drawFrame);
      }
    } finally {
      isDrawingRef.current = false;
    }
  }, [currentTime, segment, backgroundConfig]);

  // Add this wrapper function
  const animationFrameWrapper = useCallback(() => {
    drawFrame(false);
  }, [drawFrame]);

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

  // Update calculateCurrentZoomState to properly handle transitions between keyframes
  const calculateCurrentZoomState = (time: number) => {
    if (!segment) return { zoomFactor: 1, positionX: 0.5, positionY: 0.5 };

    const sortedKeyframes = [...segment.zoomKeyframes].sort((a, b) => a.time - b.time);
    if (sortedKeyframes.length === 0) {
      return { zoomFactor: 1, positionX: 0.5, positionY: 0.5 };
    }

    const ANIMATION_DURATION = 1.0;

    // Find the next keyframe (if any)
    const nextKeyframe = sortedKeyframes.find(k => k.time > time);
    // Find the previous keyframe (if any)
    const prevKeyframe = [...sortedKeyframes].reverse().find(k => k.time <= time);

    // If we're before all keyframes
    if (!prevKeyframe && !nextKeyframe) {
      return { zoomFactor: 1, positionX: 0.5, positionY: 0.5 };
    }

    // If we're after all keyframes, maintain last keyframe state
    if (prevKeyframe && !nextKeyframe) {
      return prevKeyframe;
    }

    // If we're approaching the next keyframe
    if (nextKeyframe && time >= nextKeyframe.time - ANIMATION_DURATION) {
      const progress = (time - (nextKeyframe.time - ANIMATION_DURATION)) / ANIMATION_DURATION;
      const easedProgress = easeOutCubic(Math.min(1, Math.max(0, progress)));

      const startState = prevKeyframe || { zoomFactor: 1, positionX: 0.5, positionY: 0.5 };

      return {
        zoomFactor: startState.zoomFactor + (nextKeyframe.zoomFactor - startState.zoomFactor) * easedProgress,
        positionX: startState.positionX + (nextKeyframe.positionX - startState.positionX) * easedProgress,
        positionY: startState.positionY + (nextKeyframe.positionY - startState.positionY) * easedProgress
      };
    }

    // If we're between keyframes but not in a transition
    if (prevKeyframe) {
      return prevKeyframe;
    }

    // Default state
    return { zoomFactor: 1, positionX: 0.5, positionY: 0.5 };
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

  // Add new export function to replace video-exporter.ts
  const handleExport = async () => {
    if (!currentVideo || !segment || !videoRef.current) return;
    
    // Store original loop value before we start
    const originalLoop = videoRef.current.loop;
    
    try {
      console.log('Starting export process...');
      setIsProcessing(true);
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Disable loop
      video.loop = false;

      const stream = canvas.captureStream(60);
      const supportedMimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') 
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm;codecs=vp8,opus';
      console.log('Using codec:', supportedMimeType);

      const chunks: Blob[] = [];
      let recorderStopped = false;
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: supportedMimeType,
        videoBitsPerSecond: 8000000
      });

      mediaRecorder.ondataavailable = (e) => {
        console.log('Data chunk received:', e.data.size);
        if (e.data.size > 0) chunks.push(e.data);
      };

      console.log('Starting recording...');
      mediaRecorder.start(1000);

      console.log('Setting video position and playing...');
      video.currentTime = segment.trimStart;
      await video.play();

      console.log('Waiting for video completion...');
      await new Promise<void>((resolve) => {
        const handleTimeUpdate = () => {
          const progress = (video.currentTime - segment.trimStart) / (segment.trimEnd - segment.trimStart) * 100;
          console.log(`Progress: ${progress.toFixed(1)}%, Time: ${video.currentTime.toFixed(2)}/${segment.trimEnd.toFixed(2)}`);
          setExportProgress(Math.min(progress, 100));

          if (video.currentTime >= segment.trimEnd && !recorderStopped) {
            console.log('Reached end, stopping recorder...');
            recorderStopped = true;
            video.removeEventListener('timeupdate', handleTimeUpdate);
            video.pause();
            mediaRecorder.stop();
            resolve();
          }
        };

        // Handle if video tries to loop
        const handleEnded = () => {
          if (!recorderStopped) {
            console.log('Video ended, stopping recorder...');
            recorderStopped = true;
            video.removeEventListener('timeupdate', handleTimeUpdate);
            video.removeEventListener('ended', handleEnded);
            mediaRecorder.stop();
            resolve();
          }
        };

        video.addEventListener('timeupdate', handleTimeUpdate);
        video.addEventListener('ended', handleEnded);
      });

      console.log('Waiting for recorder to finish...');
      await new Promise<void>(resolve => {
        mediaRecorder.onstop = () => {
          console.log('Creating final video file...');
          const blob = new Blob(chunks, { type: supportedMimeType });
          console.log('Blob created, size:', blob.size);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `processed_video_${Date.now()}.webm`;
          a.click();
          console.log('Download triggered');
          URL.revokeObjectURL(url);
          stream.getTracks().forEach(track => track.stop());
          resolve();
        };
      });

      console.log('Export complete!');

    } catch (error) {
      console.error('Export error:', error);
    } finally {
      // Restore original loop setting
      if (videoRef.current) {
        videoRef.current.loop = originalLoop;
      }
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

  // Add this effect to redraw when background config changes
  useEffect(() => {
    if (videoRef.current && !videoRef.current.paused) return; // Don't interrupt if playing
    requestAnimationFrame(drawFrame);
  }, [backgroundConfig, drawFrame]);

  // Add this helper function to generate background styles
  const getBackgroundStyle = (ctx: CanvasRenderingContext2D, type: BackgroundConfig['backgroundType']) => {
    switch (type) {
      case 'gradient1':
        const gradient1 = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient1.addColorStop(0, '#2563eb'); // blue-600
        gradient1.addColorStop(1, '#7c3aed'); // violet-600
        return gradient1;
      case 'gradient2':
        const gradient2 = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient2.addColorStop(0, '#fb7185'); // rose-400
        gradient2.addColorStop(1, '#fdba74'); // orange-300
        return gradient2;
      case 'gradient3':
        const gradient3 = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient3.addColorStop(0, '#10b981'); // emerald-500
        gradient3.addColorStop(1, '#2dd4bf'); // teal-400
        return gradient3;
      case 'solid':
      default:
        return '#000000';
    }
  };

  // Add this state near the top of the App component
  const [recordingDuration, setRecordingDuration] = useState(0);

  // Add this effect to track recording duration
  useEffect(() => {
    let interval: number;
    
    if (isRecording) {
      const startTime = Date.now();
      interval = window.setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } else {
      setRecordingDuration(0);
    }

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [isRecording]);

  return (
    <div className="min-h-screen bg-[#1a1a1b]">
      {/* Header */}
      <header className="bg-[#1a1a1b] border-b border-[#343536]">
        <div className="max-w-6xl mx-auto px-4 py-3 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-[#d7dadc]">Video Editor</h1>
          
          {/* Move export button to header right */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Button
                onClick={isRecording ? handleStopRecording : handleStartRecording}
                disabled={isProcessing || isLoadingVideo}
                className={`flex items-center px-4 py-2 h-9 text-sm font-medium transition-colors
                  ${isRecording 
                    ? 'bg-red-500 hover:bg-red-600 text-white' 
                    : 'bg-emerald-500 hover:bg-emerald-600 text-white'
                  }
                `}
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
                    {currentVideo ? 'New Recording' : 'Start Recording'}
                  </>
                )}
              </Button>
              {isRecording && (
                <span className="text-red-500 font-medium">
                  {formatTime(recordingDuration)}
                </span>
              )}
            </div>

            {currentVideo && (
              <Button
                onClick={handleExport}
                disabled={isProcessing}
                className={`flex items-center px-4 py-2 h-9 text-sm font-medium
                  ${isProcessing 
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed' 
                    : 'bg-[#0079d3] hover:bg-[#1484d6] text-white'
                  }
                `}
              >
                <Download className="w-4 h-4 mr-2" />
                Export Video
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
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
                  <canvas 
                    ref={canvasRef}
                    className="w-full h-full object-contain"
                  />
                  <video 
                    ref={videoRef}
                    className="hidden"
                    playsInline
                    preload="auto"
                    crossOrigin="anonymous"
                  />
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
              {/* Panel Toggle Buttons - Professional dark theme style */}
              <div className="flex bg-[#272729] p-0.5 rounded-md">
                <Button
                  onClick={() => setActivePanel('zoom')}
                  variant={activePanel === 'zoom' ? 'default' : 'outline'}
                  size="sm"
                  className={`flex-1 ${
                    activePanel === 'zoom' 
                      ? 'bg-[#1a1a1b] text-[#d7dadc] shadow-sm border-0' 
                      : 'bg-transparent text-[#818384] border-0 hover:bg-[#1a1a1b]/50 hover:text-[#d7dadc]'
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
                      ? 'bg-[#1a1a1b] text-[#d7dadc] shadow-sm border-0' 
                      : 'bg-transparent text-[#818384] border-0 hover:bg-[#1a1a1b]/50 hover:text-[#d7dadc]'
                  }`}
                >
                  Background
                </Button>
              </div>

              {/* Update the panel content styling */}
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
                            className="text-[#d7dadc] hover:text-red-400 hover:bg-red-400/10 transition-colors"
                          >
                            <Trash2 className="w-5 h-5" />
                          </Button>
                        )}
                      </div>

                      {/* Update slider styling */}
                      <div className="space-y-4">
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
                            <div className="flex justify-between text-xs text-[#818384] font-medium">
                              <span>1x</span>
                              <span>{zoomFactor.toFixed(1)}x</span>
                              <span>3x</span>
                            </div>
                          </div>
                        </div>

                        {/* Position Controls with improved styling */}
                        <div className="space-y-4">
                          <div>
                            <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                              <span>Horizontal Position</span>
                              <span className="text-[#818384]">
                                {Math.round(segment?.zoomKeyframes[editingKeyframeId!]?.positionX * 100)}%
                              </span>
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
                            <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                              <span>Vertical Position</span>
                              <span className="text-[#818384]">
                                {Math.round(segment?.zoomKeyframes[editingKeyframeId!]?.positionY * 100)}%
                              </span>
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
                    <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6 flex flex-col items-center justify-center text-center">
                      <div className="bg-[#272729] rounded-full p-3 mb-3">
                        <Search className="w-6 h-6 text-[#818384]" />
                      </div>
                      <p className="text-[#d7dadc] font-medium">No Zoom Effect Selected</p>
                      <p className="text-[#818384] text-sm mt-1 max-w-[200px]">
                        Select a zoom effect on the timeline or add a new one
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-4">
                  <h2 className="text-base font-semibold text-[#d7dadc] mb-4">Background & Layout</h2>
                  
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                        <span>Video Size</span>
                        <span className="text-[#818384]">{backgroundConfig.scale}%</span>
                      </label>
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
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                        <span>Border Radius</span>
                        <span className="text-[#818384]">{backgroundConfig.borderRadius}px</span>
                      </label>
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
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-3">
                        Background Style
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {Object.entries(GRADIENT_PRESETS).map(([key, gradient]) => (
                          <button
                            key={key}
                            onClick={() => setBackgroundConfig(prev => ({
                              ...prev,
                              backgroundType: key as BackgroundConfig['backgroundType']
                            }))}
                            className={`
                              h-14 rounded-lg transition-all
                              ${gradient}
                              ${backgroundConfig.backgroundType === key 
                                ? 'ring-2 ring-[#0079d3] ring-offset-2 ring-offset-[#1a1a1b] scale-105' 
                                : 'ring-1 ring-[#343536] hover:ring-[#0079d3]/50'
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
                onClick={() => {
                  handleAddKeyframe();
                  setActivePanel('zoom');  // Switch to zoom panel when adding keyframe
                }}
                disabled={isProcessing || !currentVideo}
                className={`flex items-center px-4 py-2 h-9 text-sm font-medium transition-colors
                  ${!currentVideo || isProcessing
                    ? 'bg-gray-600/50 text-gray-400 cursor-not-allowed'
                    : 'bg-[#0079d3] hover:bg-[#1484d6] text-white shadow-sm'
                  }
                `}
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
                    const prevKeyframe = index > 0 ? segment.zoomKeyframes[index - 1] : null;
                    
                    // Use exact 1.0 second duration for animation range
                    const ANIMATION_DURATION = 1.0;
                    const animationStartTime = Math.max(0, keyframe.time - ANIMATION_DURATION);
                    
                    return (
                      <div key={index}>
                        {/* Animation range on timeline */}
                        <div
                          className={`
                            absolute h-full cursor-pointer
                            transition-colors border-r border-[#0079d3]
                            ${active ? 'opacity-100' : 'opacity-80'}
                          `}
                          style={{
                            left: `${(animationStartTime / duration) * 100}%`,
                            width: `${(ANIMATION_DURATION / duration) * 100}%`,  // Use exact duration
                            zIndex: 20,
                            background: `linear-gradient(90deg, 
                              rgba(0, 121, 211, 0.1) 0%,
                              rgba(0, 121, 211, ${0.1 + (keyframe.zoomFactor - 1) * 0.3}) 100%
                            )`
                          }}
                        />

                        {/* Keyframe marker */}
                        <div
                          className="absolute cursor-pointer group"
                          style={{
                            left: `${(keyframe.time / duration) * 100}%`,
                            transform: 'translateX(-50%)',
                            top: '-32px',
                            height: '56px',
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (videoRef.current) {
                              videoRef.current.currentTime = keyframe.time;
                              setCurrentTime(keyframe.time);
                              setEditingKeyframeId(index);
                              setActivePanel('zoom');  // Switch to zoom panel when clicking keyframe
                            }
                          }}
                        >
                          <div className="relative flex flex-col items-center">
                            <div className={`
                              px-2 py-1 mb-1 rounded-full text-xs font-medium whitespace-nowrap
                              ${active ? 'bg-[#0079d3] text-white' : 'bg-[#0079d3]/20 text-[#0079d3]'}
                            `}>
                              {Math.round((keyframe.zoomFactor - 1) * 100)}%
                            </div>

                            <div className={`
                              w-3 h-3 bg-[#0079d3] rounded-full 
                              hover:scale-125 transition-transform
                              ${active ? 'ring-2 ring-white' : ''}
                            `} />

                            <div className="w-[1px] h-10 bg-[#0079d3]/30 group-hover:bg-[#0079d3]/50" />
                          </div>
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

