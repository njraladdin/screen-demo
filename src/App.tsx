import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Pause, Video, StopCircle, Plus, Trash2, Search, Download } from "lucide-react";
import "./App.css";
import { Button } from "@/components/ui/button";
import { exportVideo } from "@/lib/video-exporter";

let lastFrameTime = performance.now();

interface ZoomEffect {
  time: number;
  duration: number;
  zoomFactor: number;
  positionX: number;
  positionY: number;
}

interface VideoSegment {
  trimStart: number;
  trimEnd: number;
  zoomEffects: ZoomEffect[];
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
  const [isAddingZoom, setIsAddingZoom] = useState(false);
  const [zoomFactor, setZoomFactor] = useState(1.5);
  const [editingZoomId, setEditingZoomId] = useState<number | null>(null);
  const [sortedZoomEffects, setSortedZoomEffects] = useState<ZoomEffect[]>([]);
  const animationFrameRef = useRef<number>();
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Add this state to track if we're currently seeking
  const [isSeeking, setIsSeeking] = useState(false);

  // Add this state to track if we're currently drawing
  const isDrawingRef = useRef(false);

  // Draw the current frame on canvas
  const drawFrame = useCallback(() => {
    if (isDrawingRef.current) return; // Skip if already drawing
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !segment) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    isDrawingRef.current = true;

    try {
      // Skip frame if we're too far behind
      const now = performance.now();
      const timeSinceLastFrame = now - lastFrameTime;
      if (timeSinceLastFrame < 16) { // Target 60fps
        animationFrameRef.current = requestAnimationFrame(drawFrame);
        return;
      }
      lastFrameTime = now;

      // Only clear and save context if we're actually going to draw
      const activeZoom = sortedZoomEffects
        .filter(effect => video.currentTime >= effect.time)
        .pop();

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (activeZoom) {
        ctx.save();

        const previousZoom = findPreviousZoom(sortedZoomEffects, activeZoom.time);
        const { currentZoom, currentPosX, currentPosY } = calculateZoomTransition(
          video.currentTime,
          activeZoom,
          previousZoom
        );

        applyZoomTransform(ctx, canvas, currentZoom, currentPosX, currentPosY);
        
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
  }, [currentTime, segment, sortedZoomEffects]);

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
        
        // Find if we're in any zoom effect's range
        const activeZoomIndex = segment.zoomEffects.findIndex(effect => 
          video.currentTime >= effect.time && 
          video.currentTime <= (effect.time + effect.duration)
        );

        // Update zoom configuration visibility
        if (activeZoomIndex !== -1) {
          setIsAddingZoom(true);
          setEditingZoomId(activeZoomIndex);
          setZoomFactor(segment.zoomEffects[activeZoomIndex].zoomFactor);
        } else {
          setIsAddingZoom(false);
          setEditingZoomId(null);
        }
      }
    };

    const handleSeeked = () => {
      debugLog('Video: seeked');
      setIsSeeking(false);
      drawFrame();
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('seeked', handleSeeked);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('seeked', handleSeeked);
    };
  }, [drawFrame, isSeeking, segment]);

  async function handleStartRecording() {
    if (isRecording) return;

    try {
      await invoke("start_recording");
      setIsRecording(true);
      setError(null);
    } catch (err) {
      console.error("Failed to start recording:", err);
      setError(err as string);
    }
  }

  async function handleStopRecording() {
    if (!isRecording) return;

    try {
      const videoData = await invoke<number[]>("stop_recording");
      setIsRecording(false);
      
      // Create a blob from the video data
      const uint8Array = new Uint8Array(videoData);
      const blob = new Blob([uint8Array], { 
        type: "video/mp4; codecs=avc1.42E01E,mp4a.40.2" 
      });
      
      // Create object URL and set video source
      const url = URL.createObjectURL(blob);
      setCurrentVideo(url);
      if (videoRef.current) {
        videoRef.current.src = url;
        videoRef.current.load();
      }
      
    } catch (err) {
      console.error("Failed to stop recording:", err);
      setError(err as string);
    }
  }

  // Initialize segment when video loads
  useEffect(() => {
    if (duration > 0 && !segment) {
      const initialSegment: VideoSegment = {
        trimStart: 0,
        trimEnd: duration,
        zoomEffects: []
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
      setIsAddingZoom(false);
      setEditingZoomId(null);
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

  const handleAddZoom = () => {
    if (!segment || !videoRef.current) return;
    
    // Find the last zoom effect before current time
    const previousZoom = findPreviousZoom(segment.zoomEffects, videoRef.current.currentTime);

    const newZoomEffect: ZoomEffect = {
      time: videoRef.current.currentTime,
      duration: 0.5,
      zoomFactor: previousZoom ? previousZoom.zoomFactor : 1.5,
      positionX: previousZoom ? previousZoom.positionX : 0.5,
      positionY: previousZoom ? previousZoom.positionY : 0.5
    };

    const newZoomEffects = [...segment.zoomEffects, newZoomEffect];
    setSegment({
      ...segment,
      zoomEffects: newZoomEffects
    });
    
    setZoomFactor(newZoomEffect.zoomFactor);
    setIsAddingZoom(true);
    setEditingZoomId(newZoomEffects.length - 1);
  };

  // Update the handleZoomChange function
  const handleZoomChange = (factor: number, posX?: number, posY?: number) => {
    if (!segment || !videoRef.current || editingZoomId === null) return;
    
    const existingZoom = segment.zoomEffects[editingZoomId];
    
    const newZoomEffect: ZoomEffect = {
      time: existingZoom.time,
      duration: existingZoom.duration,
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
  };

  const startEditingZoom = (index: number) => {
    if (!segment || !videoRef.current) return;
    const zoomEffect = segment.zoomEffects[index];
    
    // Only seek to end of zoom when explicitly editing
    if (editingZoomId !== index) {
      videoRef.current.currentTime = zoomEffect.time + zoomEffect.duration;
    }
    setZoomFactor(zoomEffect.zoomFactor);
    setEditingZoomId(index);
    setIsAddingZoom(true);
    setCurrentTime(zoomEffect.time + zoomEffect.duration);
  };

  const findPreviousZoom = (effects: ZoomEffect[], currentTime: number): ZoomEffect | null => {
    return effects
      .filter(effect => effect.time < currentTime)
      .sort((a, b) => b.time - a.time)[0] || null;
  };

  const isZoomActive = (effect: ZoomEffect, index: number) => {
    return editingZoomId === index || (
      currentTime >= effect.time && 
      currentTime <= (effect.time + effect.duration)
    );
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

  const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);

  // Add this effect to manage sorted zoom effects
  useEffect(() => {
    if (segment) {
      setSortedZoomEffects(segment.zoomEffects.sort((a, b) => a.time - b.time));
    }
  }, [segment?.zoomEffects]);

  // Update canvas initialization
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const handleResize = () => {
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 360;
      drawFrame();
    };

    handleResize(); // Initial size
    video.addEventListener('loadedmetadata', handleResize);
    
    return () => {
      video.removeEventListener('loadedmetadata', handleResize);
    };
  }, [videoRef.current]);

  // Add a function to check if we're currently in any zoom range
  const isInAnyZoomRange = useCallback(() => {
    if (!segment) return false;
    return segment.zoomEffects.some(effect => 
      currentTime >= effect.time && 
      currentTime <= (effect.time + effect.duration)
    );
  }, [segment, currentTime]);

  // Update the throttled seek function to prevent multiple seeks
  const throttledSeek = useThrottle((time: number) => {
    if (isSeeking || !videoRef.current || isDrawingRef.current) return;
    
    setIsSeeking(true);
    videoRef.current.currentTime = time;
    setCurrentTime(time);
  }, 32); // Increase throttle time slightly

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
              disabled={isProcessing}
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
              ) : (
                <>
                  <Video className="w-4 h-4 mr-2" />
                  Start Recording
                </>
              )}
            </button>
          </div>

          {/* Export Button - Now in the controls section */}
          {segment && segment.zoomEffects && segment.zoomEffects.length > 0 && (
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
          <div className="grid grid-cols-3 gap-6">
            {/* Video Preview Section - Takes up 2/3 of the space */}
            <div className="col-span-2 bg-black rounded-lg p-4">
              <div className="aspect-video relative overflow-hidden rounded-lg">
                {/* Hidden video element */}
                <video 
                  ref={videoRef}
                  className="hidden"
                  playsInline
                  preload="auto"
                  crossOrigin="anonymous"
                />
                
                {/* Canvas */}
                <canvas 
                  ref={canvasRef}
                  className="w-full h-full"
                  style={{ imageRendering: 'crisp-edges' }}
                />
                
                {/* Playback Controls */}
                <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2 bg-black/30 rounded-full p-2 backdrop-blur-sm">
                  <Button
                    onClick={togglePlayPause}
                    disabled={isProcessing}
                    variant="ghost"
                    className="text-white hover:bg-white/20 hover:text-white transition-colors"
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

            {/* Zoom Configuration Panel */}
            <div className="col-span-1">
              {(isAddingZoom || editingZoomId !== null) ? (
                <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6">
                  <div className="flex justify-between items-center mb-6">
                    <h2 className="text-lg font-semibold text-[#d7dadc]">Zoom Configuration</h2>
                    {editingZoomId !== null && (
                      <Button
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
                        variant="ghost"
                        size="icon"
                        className="text-white"
                      >
                        <Trash2 className="w-5 h-5" />
                      </Button>
                    )}
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
                            const newValue = Number(e.target.value);
                            setZoomFactor(newValue);
                            handleZoomChange(newValue);
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
                          value={segment?.zoomEffects[editingZoomId!]?.positionX ?? 0.5}
                          onChange={(e) => {
                            handleZoomChange(zoomFactor, Number(e.target.value), undefined);
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
                          value={segment?.zoomEffects[editingZoomId!]?.positionY ?? 0.5}
                          onChange={(e) => {
                            handleZoomChange(zoomFactor, undefined, Number(e.target.value));
                          }}
                          className="w-full accent-[#0079d3]"
                        />
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
                        className="absolute h-full cursor-pointer group"
                        style={{
                          left: `${(effect.time / duration) * 100}%`,
                          width: `${(effect.duration / duration) * 100}%`,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (videoRef.current) {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const clickX = e.clientX - rect.left;
                            const percent = clickX / rect.width;
                            const newTime = effect.time + (effect.duration * percent);
                            videoRef.current.currentTime = newTime;
                            setCurrentTime(newTime);
                            // Set editing state but don't seek to end
                            setEditingZoomId(index);
                            setIsAddingZoom(true);
                          }
                        }}
                      >
                        {/* Zoom effect background */}
                        <div className="absolute inset-0 bg-[#0079d3]/20 group-hover:bg-[#0079d3]/40 
                          transition-colors border-l-2 border-r-2 border-[#0079d3]" />
                        
                        {/* Zoom label - separate click handler */}
                        <div 
                          className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap"
                          onClick={(e) => {
                            e.stopPropagation();
                            startEditingZoom(index); // This will seek to the end
                          }}
                        >
                          <div className={`
                            px-2 py-1 rounded-full text-xs font-medium cursor-pointer
                            transition-all duration-200
                            ${active 
                              ? 'bg-[#0079d3] text-white scale-110' 
                              : 'bg-[#0079d3]/80 text-white/90 scale-100'
                            }
                          `}>
                            {active ? `${fromZoom}% → ${toZoom}%` : `${toZoom}%`}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* Playhead */}
                  <div 
                    className="absolute top-[-16px] bottom-0 flex flex-col items-center pointer-events-none z-50"
                    style={{ 
                      left: `${(currentTime / duration) * 100}%`,
                      transform: 'translateX(-50%)',
                    }}
                  >
                    <div className="w-4 h-3 bg-[#0079d3] rounded-t" />
                    <div className="w-0.5 flex-1 bg-[#0079d3]" />
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
