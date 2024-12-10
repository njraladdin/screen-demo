import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Play, Pause, Plus, Search, Download, Video, StopCircle, Trash2 } from "lucide-react"
import { exportVideo } from "@/lib/video-exporter"

interface VideoSegment {
  id: string;
  trimStart: number;
  trimEnd: number;
  zoomEffects: ZoomEffect[];
}

interface ZoomEffect {
  time: number;
  duration: number;
  zoomFactor: number;
  positionX: number;
  positionY: number;
}

interface ScreenRecorderState {
  isRecording: boolean;
  mediaRecorder: MediaRecorder | null;
  recordedChunks: Blob[];
}

// Add these easing functions at the top of the file
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);

// Helper function to find the previous zoom effect before a given time
const findPreviousZoom = (effects: ZoomEffect[], currentTime: number): ZoomEffect | null => {
  return effects
    .filter(effect => effect.time < currentTime)
    .sort((a, b) => b.time - a.time)[0] || null;
};

// Add these at the top of the file after imports
const DEBUG = true;
let lastFrameTime = performance.now();
// Add this helper function
function debugLog(message: string, data?: any) {
  if (DEBUG) {
    if (data) {
      console.log(`[DEBUG] ${message}`, data);
    } else {
      console.log(`[DEBUG] ${message}`);
    }
  }
}



// Remove the separate debug variables and memory check effect
// Instead, add a simple debug utility:
const useDebugMonitor = (data: Record<string, any>) => {
  useEffect(() => {
    if (!DEBUG) return;

    debugLog('State updated', data);

    // Log performance stats every 5 seconds
    const interval = setInterval(() => {
      if ('memory' in performance) {
        // @ts-ignore
        const { usedJSHeapSize, totalJSHeapSize } = performance.memory;
        debugLog('Performance stats', {
          memory: `${Math.round(usedJSHeapSize / 1024 / 1024)}MB / ${Math.round(totalJSHeapSize / 1024 / 1024)}MB`,
          fps: Math.round(1000 / (performance.now() - lastFrameTime))
        });
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [data]);
};

// Add this custom hook near the top of the file
const useVideoCanvas = (options: {
  video: HTMLVideoElement | null,
  segment: VideoSegment | null,
  isPlaying: boolean,
  isAddingZoom: boolean,
  onTimeUpdate: (time: number) => void,
}) => {
  const { video, segment, isPlaying, isAddingZoom, onTimeUpdate } = options;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const animationFrameRef = useRef<number>();

  // Sort zoom effects once
  const sortedZoomEffects = useMemo(() => {
    return segment?.zoomEffects.sort((a, b) => a.time - b.time) || [];
  }, [segment?.zoomEffects]);

  const drawFrame = useCallback(() => {
    const ctx = canvasCtxRef.current;
    const canvas = canvasRef.current;
    if (!ctx || !video || !segment || !canvas) return;

    // Skip frame if we're too far behind
    const now = performance.now();
    const timeSinceLastFrame = now - lastFrameTime;
    if (timeSinceLastFrame < 16) { // Target 60fps
      animationFrameRef.current = requestAnimationFrame(drawFrame);
      return;
    }
    lastFrameTime = now;

    onTimeUpdate(video.currentTime);

    // Only clear and save context if we're actually going to draw
    const activeZoom = sortedZoomEffects
      .filter(effect => video.currentTime >= effect.time)
      .pop();

    if (activeZoom) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();

      const previousZoom = findPreviousZoom(sortedZoomEffects, activeZoom.time);
      const { currentZoom, currentPosX, currentPosY } = calculateZoomTransition(
        video.currentTime,
        activeZoom,
        previousZoom
      );

      applyZoomTransform(ctx, canvas, currentZoom, currentPosX, currentPosY);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    } else {
      // No zoom effect - direct draw
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }

    if (isPlaying) {
      animationFrameRef.current = requestAnimationFrame(drawFrame);
    }
  }, [video, segment, sortedZoomEffects, isPlaying, isAddingZoom, onTimeUpdate]);

  // Initialize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!video || !canvas || !segment) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvasCtxRef.current = ctx;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;

    if (isPlaying) {
      animationFrameRef.current = requestAnimationFrame(drawFrame);
    } else {
      drawFrame();
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [video, segment, drawFrame, isPlaying, isAddingZoom]);

  return { canvasRef, drawFrame };
};

// Helper functions
const calculateZoomTransition = (
  currentTime: number,
  activeZoom: ZoomEffect,
  previousZoom: ZoomEffect | null
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

export default function App() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDraggingTrimStart, setIsDraggingTrimStart] = useState(false);
  const [isDraggingTrimEnd, setIsDraggingTrimEnd] = useState(false);
  const [segment, setSegment] = useState<VideoSegment | null>(null);
  const [isAddingZoom, setIsAddingZoom] = useState(false);
  const [zoomFactor, setZoomFactor] = useState(1.5); // Default 50% zoom
  const [isPlaying, setIsPlaying] = useState(false);
  const [editingZoomId, setEditingZoomId] = useState<number | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [screenRecorder, setScreenRecorder] = useState<ScreenRecorderState>({
    isRecording: false,
    mediaRecorder: null,
    recordedChunks: []
  });
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const { canvasRef } = useVideoCanvas({
    video: videoRef.current,
    segment,
    isPlaying,
    isAddingZoom,
    onTimeUpdate: setCurrentTime
  });

  // Initialize single segment when video loads
  useEffect(() => {
    if (duration > 0 && !segment) {
      debugLog('Creating initial segment', { duration });
      const initialSegment: VideoSegment = {
        id: 'trim',
        trimStart: 0,
        trimEnd: duration,
        zoomEffects: []
      };
      setSegment(initialSegment);
    }
  }, [duration, segment]);

  // Update trim handle dragging to work with single segment
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

  // Update video playback to respect trim bounds
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !segment) return;

    const handleTimeUpdate = () => {
      if (video.currentTime >= segment.trimEnd) {
        video.pause();
        video.currentTime = segment.trimEnd;
      } else if (video.currentTime < segment.trimStart) {
        video.currentTime = segment.trimStart;
      }
    };

    if (video.currentTime < segment.trimStart || video.currentTime > segment.trimEnd) {
      video.currentTime = segment.trimStart;
    }

    video.addEventListener('timeupdate', handleTimeUpdate);
    return () => video.removeEventListener('timeupdate', handleTimeUpdate);
  }, [segment]);

  // Update timeline click to respect trim bounds
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
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setIsProcessing(true);
      const videoUrl = URL.createObjectURL(file);
      setCurrentVideo(videoUrl);
    } catch (error) {
      console.error('Error loading video:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  // Rename the function
  const handleExport = async () => {
    if (!currentVideo || !segment || !videoRef.current) return;
    
    try {
      setIsProcessing(true);
      await exportVideo({
        video: videoRef.current,
        segment,
        onProgress: setExportProgress,
        findPreviousZoom,
        calculateZoomTransition
      });
    } catch (error) {
      console.error('Error processing video:', error);
    } finally {
      setIsProcessing(false);
      setExportProgress(0);
    }
  };

  const handleZoomChange = (factor: number, posX?: number, posY?: number) => {
    if (!segment || !videoRef.current || editingZoomId === null) return;
    
    const existingZoom = segment.zoomEffects[editingZoomId];
    
    const newZoomEffect: ZoomEffect = {
      time: existingZoom.time,
      duration: 0.5,
      zoomFactor: factor,
      positionX: posX ?? existingZoom.positionX,
      positionY: posY ?? existingZoom.positionY
    };

    setSegment({
      ...segment,
      zoomEffects: segment.zoomEffects.map((effect, index) => 
        index === editingZoomId ? newZoomEffect : effect
      )
    });

    videoRef.current.currentTime = newZoomEffect.time + newZoomEffect.duration;
  };

  const startEditingZoom = (index: number) => {
    if (!segment || !videoRef.current) return;
    const zoomEffect = segment.zoomEffects[index];
    
    // Set video time to the end of the zoom effect's time range
    videoRef.current.currentTime = zoomEffect.time + zoomEffect.duration;
    
    // Update state
    setZoomFactor(zoomEffect.zoomFactor);
    setEditingZoomId(index);
    setIsAddingZoom(true);
    setCurrentTime(zoomEffect.time + zoomEffect.duration);
  };

  // Add play/pause control function
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    
    debugLog(`togglePlay called, current isPlaying: ${isPlaying}`);
    if (isPlaying) {
      debugLog('Attempting to pause video');
      video.pause();
      setIsPlaying(false);
    } else {
      debugLog('Attempting to play video');
      video.play()
        .then(() => {
          debugLog('Video started playing');
          setIsPlaying(true);
        })
        .catch(error => {
          debugLog('Error playing video:', error);
          setIsPlaying(false);
        });
    }
  }, [isPlaying]);

  // Add this single effect for play state sync
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Log video state when play state changes
    debugLog('Video element state:', {
      readyState: video.readyState,
      paused: video.paused,
      currentTime: video.currentTime,
      duration: video.duration,
      src: video.src
    });

    const handlePlayStateChange = (event: Event) => {
      debugLog(`Play state change event: ${event.type}`);
      if (event.type === 'play') {
        setIsPlaying(true);
      } else if (event.type === 'pause' || event.type === 'ended') {
        setIsPlaying(false);
      }
    };

    const handleError = (error: Event) => {
      debugLog('Video error:', error);
      setIsPlaying(false);
    };

    ['play', 'pause', 'ended', 'seeking'].forEach(event => 
      video.addEventListener(event, event === 'seeking' ? handleSeeking : handlePlayStateChange)
    );
    video.addEventListener('error', handleError);

    return () => {
      ['play', 'pause', 'ended', 'seeking'].forEach(event => 
        video.removeEventListener(event, event === 'seeking' ? handleSeeking : handlePlayStateChange)
      );
      video.removeEventListener('error', handleError);
    };
  }, []);

  // Add this effect to handle showing/hiding zoom configuration based on playhead position
  useEffect(() => {
    if (!segment) return;

    // Check if playhead is within any zoom effect
    const activeZoom = segment.zoomEffects.findIndex(effect => 
      currentTime >= effect.time && 
      currentTime <= (effect.time + effect.duration)
    );

    if (activeZoom !== -1) {
      // Show zoom configuration for the active zoom
      setIsAddingZoom(true);
      setEditingZoomId(activeZoom);
      setZoomFactor(segment.zoomEffects[activeZoom].zoomFactor);
    } else {
      // Hide zoom configuration when not in a zoom effect
      setIsAddingZoom(false);
      setEditingZoomId(null);
    }
  }, [currentTime, segment]);

  // Modify the handleAddZoom function to immediately show configuration
  const handleAddZoom = () => {
    if (!segment || !videoRef.current) return;
    
    // Find the last zoom effect before current time
    const previousZoom = findPreviousZoom(segment.zoomEffects, videoRef.current.currentTime);

    const newZoomEffect: ZoomEffect = {
      time: videoRef.current.currentTime,
      duration: 0.5,
      zoomFactor: previousZoom ? previousZoom.zoomFactor : 1.5, // Start from previous zoom or default
      positionX: previousZoom ? previousZoom.positionX : 0.5,
      positionY: previousZoom ? previousZoom.positionY : 0.5
    };

    const newZoomEffects = [...segment.zoomEffects, newZoomEffect];
    setSegment({
      ...segment,
      zoomEffects: newZoomEffects
    });
    
    // Start editing the new zoom
    setZoomFactor(newZoomEffect.zoomFactor);
    setIsAddingZoom(true);
    setEditingZoomId(newZoomEffects.length - 1);
  };

  // Add render tracking
  useEffect(() => {
    debugLog('Component rendered with props', {
      isProcessing,
      currentTime,
      isPlaying,
      zoomEffects: segment?.zoomEffects.length
    });
  }, [isProcessing, currentTime, isPlaying, segment]);

  // Use it in the component:
  useDebugMonitor({
    isPlaying,
    currentTime,
    zoomEffects: segment?.zoomEffects.length
  });

  // Debounce seeking handler
  const handleSeeking = () => {
    debugLog('Video event: seeking');
  };

  const handleScreenRecording = async () => {
    if (screenRecorder.isRecording) {
      try {
        const recordingPath = await invoke('stop_recording');
        debugLog('Recording stopped, file saved at:', recordingPath);
        
        // Load the recorded video
        if (recordingPath) {
          setCurrentVideo(`file://${recordingPath}`);
          
          // Create a video element to get metadata
          const video = document.createElement('video');
          video.src = `file://${recordingPath}`;
          video.preload = "metadata";
          
          video.onloadedmetadata = () => {
            setDuration(video.duration);
            if (videoRef.current) {
              videoRef.current.src = `file://${recordingPath}`;
              videoRef.current.load();
            }
          };
        }
        
        setScreenRecorder(prev => ({ ...prev, isRecording: false }));
      } catch (error) {
        console.error('Error stopping recording:', error);
        setScreenRecorder(prev => ({ ...prev, isRecording: false }));
      }
      return;
    }

    try {
      await invoke('start_recording');
      setScreenRecorder(prev => ({ 
        ...prev, 
        isRecording: true 
      }));

      // Listen for recording progress events
      const unlisten = await listen('recording-progress', (event) => {
        // Handle progress updates if needed
        debugLog('Recording progress:', event);
      });

      // Clean up listener when recording stops
      return () => {
        unlisten();
      };
    } catch (error) {
      console.error('Error starting recording:', error);
      setScreenRecorder(prev => ({ ...prev, isRecording: false }));
    }
  };

  // Update the duration change effect
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !segment) return;

    const handleDurationChange = () => {
      const accurateDuration = video.dataset.accurateDuration;
      debugLog('Duration change detected', {
        videoDuration: video.duration,
        accurateDuration,
        currentSegment: segment
      });

      if (accurateDuration) {
        const oldDuration = parseFloat(accurateDuration);
        const newDuration = video.duration;
        
        // Only handle significant duration changes
        if (Math.abs(newDuration - oldDuration) > 0.1) {
          debugLog('Significant duration change', {
            oldDuration,
            newDuration,
            difference: newDuration - oldDuration
          });

          // Instead of adjusting zoom times, preserve them exactly as they are
          // Only adjust the segment end if it exceeds the new duration
          setSegment(prevSegment => {
            if (!prevSegment) return null;
            
            return {
              ...prevSegment,
              trimEnd: Math.min(prevSegment.trimEnd, newDuration),
              // Keep existing zoom effects unchanged
              zoomEffects: [...prevSegment.zoomEffects]
            };
          });

          // Update the duration state
          setDuration(newDuration);
        }
      }
    };

    video.addEventListener('durationchange', handleDurationChange);
    return () => video.removeEventListener('durationchange', handleDurationChange);
  }, [videoRef.current, segment]);

  // Add the isZoomActive function here, after the state declarations
  const isZoomActive = useCallback((effect: ZoomEffect, index: number) => {
    return editingZoomId === index || (
      currentTime >= effect.time && 
      currentTime <= (effect.time + effect.duration)
    );
  }, [editingZoomId, currentTime]);

  return (
    <div className="min-h-screen bg-[#1a1a1b]">
      {/* Header */}
      <header className="bg-[#1a1a1b] border-b border-[#343536]">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-[#d7dadc]">Video Editor</h1>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Add this new section before the file upload */}
        <div className="flex gap-4 mb-6">
          <input
            type="file"
            accept="video/*"
            onChange={handleFileUpload}
            disabled={isProcessing || screenRecorder.isRecording}
            className="block flex-1 text-sm text-[#d7dadc]
              file:mr-4 file:py-2 file:px-4
              file:rounded-full file:border-0
              file:text-sm file:font-semibold
              file:bg-[#0079d3] file:text-white
              hover:file:bg-[#1484d6]"
          />
          
          <Button
            onClick={handleScreenRecording}
            disabled={isProcessing}
            className={`${
              screenRecorder.isRecording 
                ? 'bg-red-500 hover:bg-red-600' 
                : 'bg-[#0079d3] hover:bg-[#1484d6]'
            } text-white`}
          >
            {screenRecorder.isRecording ? (
              <>
                <StopCircle className="w-4 h-4 mr-2" />
                Stop Recording
              </>
            ) : (
              <>
                <Video className="w-4 h-4 mr-2" />
                Record Screen
              </>
            )}
          </Button>
        </div>

        {isProcessing && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536]">
              <p className="text-lg text-[#d7dadc]">
                {exportProgress > 0 
                  ? `Exporting video... ${exportProgress}%`
                  : 'Processing video...'}
              </p>
            </div>
          </div>
        )}

        {currentVideo && (
          <div className="space-y-6">
            {/* Video Preview and Zoom Configuration Side by Side */}
            <div className="grid grid-cols-3 gap-6">
              {/* Video Preview Section - Takes up 2/3 of the space */}
              <div className="col-span-2 bg-black rounded-lg p-4">
                <div className="aspect-video relative overflow-hidden rounded-lg">
                  <video 
                    ref={videoRef}
                    src={currentVideo}
                    className="hidden"
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(e) => {
                      const video = e.currentTarget;
                      const accurateDuration = video.dataset.accurateDuration;
                      
                      debugLog('Video loaded metadata', {
                        duration: video.duration,
                        accurateDuration,
                        width: video.videoWidth,
                        height: video.videoHeight
                      });
                      
                      // Use the stored accurate duration if available
                      if (accurateDuration) {
                        setDuration(parseFloat(accurateDuration));
                      } else if (video.duration !== Infinity) {
                        setDuration(video.duration);
                      }
                    }}
                    onError={(e) => {
                      debugLog('Video error:', e.currentTarget.error);
                    }}
                    onDurationChange={(e) => {
                      const newDuration = e.currentTarget.duration;
                      debugLog('Duration changed:', newDuration);
                      if (newDuration !== Infinity) {
                        setDuration(newDuration);
                      }
                    }}
                  />
                  <canvas 
                    ref={canvasRef}
                    className="w-full h-full"
                  />
                  
                  {/* Playback Controls */}
                  <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2 bg-[#1a1a1b]/90 rounded-full p-2 backdrop-blur-sm">
                    <Button
                      onClick={togglePlay}
                      disabled={isProcessing}
                      variant="ghost"
                      className="text-[#d7dadc] hover:bg-[#343536]"
                    >
                      {isPlaying ? (
                        <Pause className="w-6 h-6" />
                      ) : (
                        <Play className="w-6 h-6" />
                      )}
                    </Button>
                    <div className="text-[#d7dadc] px-2 flex items-center">
                      {formatTime(currentTime)} / {formatTime(duration)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Zoom Configuration Panel - Takes up 1/3 of the space */}
              <div className="col-span-1">
                {isAddingZoom ? (
                  <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6 h-full">
                    <div className="flex justify-between items-center mb-6">
                      <h2 className="text-lg font-semibold text-[#d7dadc]">Zoom Configuration</h2>
                      <div className="flex items-center gap-4">
                        <span className="text-[#818384]">
                          At {formatTime(currentTime)}
                        </span>
                        <button
                          onClick={() => {
                            if (segment && editingZoomId !== null) {
                              setSegment({
                                ...segment,
                                zoomEffects: segment.zoomEffects.filter((_, i) => i !== editingZoomId)
                              });
                              setIsAddingZoom(false);
                              setEditingZoomId(null);
                            }
                          }}
                          className="text-red-500 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-6">
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
                              setZoomFactor(Number(e.target.value));
                              handleZoomChange(Number(e.target.value));
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
                          <div className="space-y-2">
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.01"
                              value={segment?.zoomEffects[editingZoomId!]?.positionX ?? 0.5}
                              onChange={(e) => {
                                handleZoomChange(zoomFactor, Number(e.target.value), undefined);
                              }}
                              className="w-full accent-[#0079d3]"
                            />
                            <div className="flex justify-between text-sm text-[#818384]">
                              <span>Left</span>
                              <span>Center</span>
                              <span>Right</span>
                            </div>
                          </div>
                        </div>
                        
                        <div>
                          <label className="block text-sm font-medium text-[#d7dadc] mb-2">
                            Vertical Position
                          </label>
                          <div className="space-y-2">
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.01"
                              value={segment?.zoomEffects[editingZoomId!]?.positionY ?? 0.5}
                              onChange={(e) => {
                                handleZoomChange(zoomFactor, undefined, Number(e.target.value));
                              }}
                              className="w-full accent-[#0079d3]"
                            />
                            <div className="flex justify-between text-sm text-[#818384]">
                              <span>Top</span>
                              <span>Center</span>
                              <span>Bottom</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-8 h-full flex flex-col items-center justify-center text-center">
                    <div className="bg-[#272729] rounded-full p-3 mb-3">
                      <Search className="w-6 h-6 text-[#818384]" />
                    </div>
                    <p className="text-[#d7dadc] font-medium">No Zoom Effect Selected</p>
                    <p className="text-[#818384] text-sm mt-1">
                      Select a zoom effect on the timeline or add a new one to configure
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Timeline Section */}
            <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6">
              <div className="flex justify-between items-center mb-8">
                <h2 className="text-lg font-semibold text-[#d7dadc]">Timeline</h2>
                <Button 
                  onClick={handleAddZoom}
                  disabled={isProcessing}
                  className="bg-[#0079d3] hover:bg-[#1484d6] text-white"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Zoom at Playhead
                </Button>
              </div>

              <div className="relative h-32">
                {/* Timeline markers - highest z-index except for playhead */}
                <div className="absolute w-full flex justify-between text-xs text-white z-40 pointer-events-none">
                  {Array.from({ length: 11 }).map((_, i) => {
                    const time = (duration * i) / 10;
                    return (
                      <div key={i} className="flex flex-col items-center">
                        <span className="mb-1">{formatTime(time)}</span>
                        <div className="h-2 w-0.5 bg-white/20" />
                      </div>
                    );
                  })}
                </div>
                
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
                  {/* Zoom effects - should be above the black overlay */}
                  {segment?.zoomEffects.map((effect, index) => {
                    const previousZoom = findPreviousZoom(segment.zoomEffects, effect.time);
                    const fromZoom = previousZoom ? 
                      Math.round((previousZoom.zoomFactor - 1) * 100) : 
                      0;
                    const toZoom = Math.round((effect.zoomFactor - 1) * 100);
                    const active = isZoomActive(effect, index);

                    return (
                      <div
                        key={index}
                        className="absolute h-full cursor-pointer group 
                          bg-[#0079d3]/20 hover:bg-[#0079d3]/40 
                          transition-colors border-l-2 border-r-2 border-[#0079d3] z-50"
                        style={{
                          left: `${(effect.time / duration) * 100}%`,
                          width: `${(effect.duration / duration) * 100}%`,
                        }}
                      >
                        <div className="absolute -top-6 left-1/2 -translate-x-1/2 group/title">
                          <div 
                            className={`relative text-xs whitespace-nowrap
                              transition-all duration-300 ease-in-out transform
                              ${active 
                                ? 'px-3 py-1 bg-[#0079d3] text-white ring-2 ring-[#0079d3] ring-offset-2 ring-offset-[#1a1a1b] rounded-full' 
                                : 'px-2 py-0.5 bg-[#0079d3]/80 text-white/90 hover:bg-[#0079d3] rounded-full'
                              }
                              ${active ? 'scale-100 opacity-100' : 'scale-90 opacity-85'}
                            `}
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditingZoom(index);
                            }}
                          >
                            <div className="flex items-center">
                              {active ? (
                                <span className="transition-all duration-300 ease-in-out origin-left">
                                  {fromZoom}% → {toZoom}%
                                </span>
                              ) : (
                                <span className="transition-all duration-300 ease-in-out">
                                  {toZoom}%
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* Black overlay for trimmed areas */}
                  {segment && (
                    <div className="absolute top-0 bottom-0 w-full bg-[#272729] z-20">
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
                    </div>
                  )}

                  {/* Trim handles */}
                  {segment && (
                    <>
                      <div
                        className="absolute top-0 bottom-0 w-1 bg-white cursor-col-resize z-30 hover:bg-blue-500"
                        style={{
                          left: `${(segment.trimStart / duration) * 100}%`,
                        }}
                        onMouseDown={() => setIsDraggingTrimStart(true)}
                      />
                      <div
                        className="absolute top-0 bottom-0 w-1 bg-white cursor-col-resize z-30 hover:bg-blue-500"
                        style={{
                          left: `${(segment.trimEnd / duration) * 100}%`,
                        }}
                        onMouseDown={() => setIsDraggingTrimEnd(true)}
                      />
                    </>
                  )}

                  {/* Playhead - highest z-index */}
                  <div 
                    className="absolute top-[-8px] bottom-0 flex flex-col items-center pointer-events-none z-50"
                    style={{ 
                      left: `${(currentTime / duration) * 100}%`,
                      transform: 'translateX(-50%)',
                    }}
                  >
                    <div className="w-4 h-2 bg-red-500 rounded-t" />
                    <div className="w-0.5 flex-1 bg-red-500" />
                  </div>
                </div>
              </div>
            </div>

            {/* Export Button */}
            {segment && segment.zoomEffects && segment.zoomEffects.length > 0 && (
              <div className="flex justify-end">
                <Button
                  onClick={handleExport}
                  disabled={isProcessing}
                  className="bg-[#0079d3] hover:bg-[#1484d6] text-white px-6"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Export Video with Effects
                </Button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// Helper function to format time in MM:SS format
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) {
    return '0:00';
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}
