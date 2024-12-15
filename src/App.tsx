import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Pause, Video, StopCircle, Plus, Trash2, Search, Download } from "lucide-react";
import "./App.css";
import { Button } from "@/components/ui/button";
import { videoRenderer } from '@/lib/videoRenderer';
import { BackgroundConfig, VideoSegment, ZoomKeyframe, MousePosition } from '@/types/video';
import { videoExporter } from '@/lib/videoExporter';
import { createVideoController } from '@/lib/videoController';

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
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Add new state for the confirmation modal
  const [showConfirmNewRecording, setShowConfirmNewRecording] = useState(false);

  // Add this to your App component state
  const [backgroundConfig, setBackgroundConfig] = useState<BackgroundConfig>({
    scale: 100,
    borderRadius: 8,
    backgroundType: 'solid'
  });

  // Add this state to toggle between panels
  const [activePanel, setActivePanel] = useState<'zoom' | 'background' | 'cursor'>('zoom');

  // Add these gradient constants
  const GRADIENT_PRESETS = {
    solid: 'bg-black',
    gradient1: 'bg-gradient-to-r from-blue-600 to-violet-600',
    gradient2: 'bg-gradient-to-r from-rose-400 to-orange-300',
    gradient3: 'bg-gradient-to-r from-emerald-500 to-teal-400'
  };

  // Add at the top of your component
  const tempCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));

  // Add to your App component state
  const [mousePositions, setMousePositions] = useState<MousePosition[]>([]);

  // Add new state at the top of App component
  const [isVideoReady, setIsVideoReady] = useState(false);

  // Create video controller ref
  const videoControllerRef = useRef<ReturnType<typeof createVideoController>>();

  // Initialize controller
  useEffect(() => {
    if (!videoRef.current || !canvasRef.current) return;

    videoControllerRef.current = createVideoController({
      videoRef: videoRef.current,
      canvasRef: canvasRef.current,
      tempCanvasRef: tempCanvasRef.current,
      onTimeUpdate: (time) => setCurrentTime(time),
      onPlayingChange: (playing) => setIsPlaying(playing),
      onVideoReady: (ready) => setIsVideoReady(ready),
      onDurationChange: (duration) => setDuration(duration),
      onError: (error) => setError(error)
    });

    return () => {
      videoControllerRef.current?.destroy();
    };
  }, []);

  // Helper function to render a frame
  const renderFrame = useCallback(() => {
    if (!segment) return;

    videoControllerRef.current?.updateRenderOptions({
      segment,
      backgroundConfig,
      mousePositions
    });
  }, [segment, backgroundConfig, mousePositions]);

  // Remove frameCallback and simplify the animation effect
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!video.paused) {
      const renderContext = {
        video,
        canvas: canvasRef.current!,
        tempCanvas: tempCanvasRef.current,
        segment: segment!,
        backgroundConfig,
        mousePositions,
        currentTime: video.currentTime
      };
      videoRenderer.startAnimation(renderContext);
    }

    return () => {
      videoRenderer.stopAnimation();
    };
  }, [segment, backgroundConfig, mousePositions]);

  // Update other places where drawFrame was used to use renderFrame instead
  useEffect(() => {
    if (videoRef.current && !videoRef.current.paused) return;
    renderFrame();
  }, [backgroundConfig, renderFrame]);

  // Update handleStartRecording to show confirmation when needed
  async function handleStartRecording() {
    if (isRecording) return;

    if (currentVideo) {
      setShowConfirmNewRecording(true);
      return;
    }

    await startNewRecording();
  }

  // Separate the actual recording logic
  async function startNewRecording() {
    try {
      console.log('Starting new recording, clearing states');
      // Clear all states first
      setMousePositions([]);  // Clear first
      setIsVideoReady(false);
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      setSegment(null);
      setZoomFactor(1.5);
      setEditingKeyframeId(null);
      setIsDraggingTrimStart(false);
      setIsDraggingTrimEnd(false);

      // Clear previous video
      if (currentVideo) {
        URL.revokeObjectURL(currentVideo);
        setCurrentVideo(null);
      }

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

      // Now start the new recording
      await invoke("start_recording");
      setIsRecording(true);
      setError(null);

      console.log('Recording started, mouse positions cleared');
    } catch (err) {
      console.error("Failed to start recording:", err);
      setError(err as string);
    }
  }

  // Update handleStopRecording to handle loading state
  async function handleStopRecording() {
    if (!isRecording) return;

    try {
      setIsRecording(false);
      setIsLoadingVideo(true);
      setIsVideoReady(false);

      // Clear existing mouse positions before getting new ones
      setMousePositions([]);

      const [videoData, mouseData] = await invoke<[number[], MousePosition[]]>("stop_recording");

      console.log('Received new mouse positions:', {
        count: mouseData.length,
        first: mouseData[0],
        last: mouseData[mouseData.length - 1]
      });
      setMousePositions(mouseData);

      const uint8Array = new Uint8Array(videoData);
      const blob = new Blob([uint8Array], {
        type: "video/mp4; codecs=avc1.42E01E,mp4a.40.2"
      });

      const url = URL.createObjectURL(blob);
      setCurrentVideo(url);

      if (videoRef.current) {
        videoRef.current.src = url;
        videoRef.current.load();
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
  const togglePlayPause = () => {
    videoControllerRef.current?.togglePlayPause();
  };

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

  // Add new export function to replace video-exporter.ts
  const handleExport = async () => {
    if (!currentVideo || !segment || !videoRef.current || !canvasRef.current) return;

    if (isProcessing) {
      console.log('[App] Export already in progress, ignoring request');
      return;
    }

    try {
      console.log('[App] Starting export process');
      setIsProcessing(true);

      await videoExporter.exportAndDownload({
        video: videoRef.current,
        canvas: canvasRef.current,
        tempCanvas: tempCanvasRef.current,
        segment,
        backgroundConfig,
        mousePositions,
        onProgress: (progress) => {
          console.log(`[App] Export progress: ${progress.toFixed(1)}%`);
          setExportProgress(progress);
        }
      });

      console.log('[App] Export completed successfully');

    } catch (error) {
      console.error('[App] Export error:', error);
    } finally {
      console.log('[App] Cleanup: Resetting states');
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
      renderFrame();
    });
  }, 32); // 32ms throttle

  // Add this effect to redraw when background config changes
  useEffect(() => {
    if (videoRef.current && !videoRef.current.paused) return; // Don't interrupt if playing

    // Create a proper FrameRequestCallback
    const frameCallback: FrameRequestCallback = (_time: number) => {
      renderFrame();
    };

    requestAnimationFrame(frameCallback);
  }, [backgroundConfig, renderFrame]);

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
      <header className="bg-[#1a1a1b] border-b border-[#343536]">
        <div className="max-w-6xl mx-auto px-4 py-3 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-[#d7dadc]">Video Editor</h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Button onClick={isRecording ? handleStopRecording : handleStartRecording} disabled={isProcessing || isLoadingVideo} className={`flex items-center px-4 py-2 h-9 text-sm font-medium transition-colors ${isRecording ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-emerald-500 hover:bg-emerald-600 text-white'}`}>
                {isRecording ? <><StopCircle className="w-4 h-4 mr-2" />Stop Recording</> : isLoadingVideo ? <><span className="animate-spin mr-2"></span>Loading Video...</> : <><Video className="w-4 h-4 mr-2" />{currentVideo ? 'New Recording' : 'Start Recording'}</>}
              </Button>
              {isRecording && <span className="text-red-500 font-medium">{formatTime(recordingDuration)}</span>}
            </div>
            {currentVideo && <Button onClick={handleExport} disabled={isProcessing} className={`flex items-center px-4 py-2 h-9 text-sm font-medium ${isProcessing ? 'bg-gray-600 text-gray-400 cursor-not-allowed' : 'bg-[#0079d3] hover:bg-[#1484d6] text-white'}`}><Download className="w-4 h-4 mr-2" />Export Video</Button>}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {error && <p className="text-red-500 mb-4">{error}</p>}
        {isRecording && <p className="text-[#0079d3] mb-4">Recording in progress...</p>}
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-6 items-start">
            <div className="col-span-2 rounded-lg">
              <div className="aspect-video relative">
                <div className="absolute inset-0 flex items-center justify-center">
                  <canvas ref={canvasRef} className="w-full h-full object-contain" />
                  <video ref={videoRef} className="hidden" playsInline preload="auto" crossOrigin="anonymous" />
                </div>
                <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2 bg-black/30 rounded-full p-2 backdrop-blur-sm z-10">
                  <Button onClick={togglePlayPause} disabled={isProcessing || !currentVideo || !isVideoReady} variant="ghost" className={`transition-colors ${!currentVideo || isProcessing || !isVideoReady ? 'text-gray-500 bg-gray-600/50 hover:bg-gray-600/50 cursor-not-allowed' : 'text-white hover:bg-white/20 hover:text-white'}`}>
                    {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
                  </Button>
                  <div className="text-white/90 px-2 flex items-center">{formatTime(currentTime)} / {formatTime(duration)}</div>
                </div>
              </div>
            </div>

            <div className="col-span-1 space-y-3">
              <div className="flex bg-[#272729] p-0.5 rounded-md">
                <Button onClick={() => setActivePanel('zoom')} variant={activePanel === 'zoom' ? 'default' : 'outline'} size="sm" className={`flex-1 ${activePanel === 'zoom' ? 'bg-[#1a1a1b] text-[#d7dadc]' : 'bg-transparent text-[#818384]'}`}>Zoom</Button>
                <Button onClick={() => setActivePanel('background')} variant={activePanel === 'background' ? 'default' : 'outline'} size="sm" className={`flex-1 ${activePanel === 'background' ? 'bg-[#1a1a1b] text-[#d7dadc]' : 'bg-transparent text-[#818384]'}`}>Background</Button>
                <Button onClick={() => setActivePanel('cursor')} variant={activePanel === 'cursor' ? 'default' : 'outline'} size="sm" className={`flex-1 ${activePanel === 'cursor' ? 'bg-[#1a1a1b] text-[#d7dadc]' : 'bg-transparent text-[#818384]'}`}>Cursor</Button>
              </div>

              {activePanel === 'zoom' ? (
                <>
                  {(editingKeyframeId !== null) ? (
                    <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-4">
                      <div className="flex justify-between items-center mb-4">
                        <h2 className="text-base font-semibold text-[#d7dadc]">Zoom Configuration</h2>
                        {editingKeyframeId !== null && <Button onClick={() => {if (segment && editingKeyframeId !== null) {setSegment({...segment, zoomKeyframes: segment.zoomKeyframes.filter((_, i) => i !== editingKeyframeId)}); setEditingKeyframeId(null);}}} variant="ghost" size="icon" className="text-[#d7dadc] hover:text-red-400 hover:bg-red-400/10 transition-colors"><Trash2 className="w-5 h-5" /></Button>}
                      </div>
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-[#d7dadc] mb-2">Zoom Factor</label>
                          <div className="space-y-2">
                            <input type="range" min="1" max="3" step="0.1" value={zoomFactor} onChange={(e) => {const newValue = Number(e.target.value); setZoomFactor(newValue); throttledUpdateZoom({ zoomFactor: newValue });}} className="w-full accent-[#0079d3]" />
                            <div className="flex justify-between text-xs text-[#818384] font-medium">
                              <span>1x</span>
                              <span>{zoomFactor.toFixed(1)}x</span>
                              <span>3x</span>
                            </div>
                          </div>
                        </div>
                        <div className="space-y-4">
                          <div>
                            <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between"><span>Horizontal Position</span><span className="text-[#818384]">{Math.round((segment?.zoomKeyframes[editingKeyframeId!]?.positionX ?? 0.5) * 100)}%</span></label>
                            <input type="range" min="0" max="1" step="0.01" value={segment?.zoomKeyframes[editingKeyframeId!]?.positionX ?? 0.5} onChange={(e) => {throttledUpdateZoom({ positionX: Number(e.target.value) });}} className="w-full accent-[#0079d3]" />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between"><span>Vertical Position</span><span className="text-[#818384]">{Math.round((segment?.zoomKeyframes[editingKeyframeId!]?.positionY ?? 0.5) * 100)}%</span></label>
                            <input type="range" min="0" max="1" step="0.01" value={segment?.zoomKeyframes[editingKeyframeId!]?.positionY ?? 0.5} onChange={(e) => {throttledUpdateZoom({ positionY: Number(e.target.value) });}} className="w-full accent-[#0079d3]" />
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6 flex flex-col items-center justify-center text-center">
                      <div className="bg-[#272729] rounded-full p-3 mb-3"><Search className="w-6 h-6 text-[#818384]" /></div>
                      <p className="text-[#d7dadc] font-medium">No Zoom Effect Selected</p>
                      <p className="text-[#818384] text-sm mt-1 max-w-[200px]">Select a zoom effect on the timeline or add a new one</p>
                    </div>
                  )}
                </>
              ) : activePanel === 'background' ? (
                <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-4">
                  <h2 className="text-base font-semibold text-[#d7dadc] mb-4">Background & Layout</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between"><span>Video Size</span><span className="text-[#818384]">{backgroundConfig.scale}%</span></label>
                      <input type="range" min="50" max="100" value={backgroundConfig.scale} onChange={(e) => {setBackgroundConfig(prev => ({...prev, scale: Number(e.target.value)}));}} className="w-full accent-[#0079d3]" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between"><span>Border Radius</span><span className="text-[#818384]">{backgroundConfig.borderRadius}px</span></label>
                      <input type="range" min="0" max="64" value={backgroundConfig.borderRadius} onChange={(e) => {setBackgroundConfig(prev => ({...prev, borderRadius: Number(e.target.value)}));}} className="w-full accent-[#0079d3]" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-3">Background Style</label>
                      <div className="grid grid-cols-2 gap-2">
                        {Object.entries(GRADIENT_PRESETS).map(([key, gradient]) => (
                          <button key={key} onClick={() => setBackgroundConfig(prev => ({...prev, backgroundType: key as BackgroundConfig['backgroundType']}))} className={`h-14 rounded-lg transition-all ${gradient} ${backgroundConfig.backgroundType === key ? 'ring-2 ring-[#0079d3] ring-offset-2 ring-offset-[#1a1a1b] scale-105' : 'ring-1 ring-[#343536] hover:ring-[#0079d3]/50'}`} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ) : activePanel === 'cursor' && (
                <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-4">
                  <h2 className="text-base font-semibold text-[#d7dadc] mb-4">Cursor Settings</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                        <span>Cursor Size</span>
                        <span className="text-[#818384]">{backgroundConfig.cursorScale || 2}x</span>
                      </label>
                      <input 
                        type="range" 
                        min="1" 
                        max="4" 
                        step="0.1" 
                        value={backgroundConfig.cursorScale || 2} 
                        onChange={(e) => setBackgroundConfig(prev => ({...prev, cursorScale: Number(e.target.value)}))}
                        className="w-full accent-[#0079d3]" 
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                        <span>Movement Smoothing</span>
                        <span className="text-[#818384]">{backgroundConfig.cursorSmoothness || 5}</span>
                      </label>
                      <input 
                        type="range" 
                        min="0" 
                        max="10" 
                        step="1" 
                        value={backgroundConfig.cursorSmoothness || 5} 
                        onChange={(e) => setBackgroundConfig(prev => ({...prev, cursorSmoothness: Number(e.target.value)}))}
                        className="w-full accent-[#0079d3]" 
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6">
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-lg font-semibold text-[#d7dadc]">Timeline</h2>
              <Button onClick={() => {handleAddKeyframe(); setActivePanel('zoom');}} disabled={isProcessing || !currentVideo} className={`flex items-center px-4 py-2 h-9 text-sm font-medium transition-colors ${!currentVideo || isProcessing ? 'bg-gray-600/50 text-gray-400 cursor-not-allowed' : 'bg-[#0079d3] hover:bg-[#1484d6] text-white shadow-sm'}`}><Plus className="w-4 h-4 mr-2" />Add Zoom at Playhead</Button>
            </div>

            <div className="relative h-32">
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

              <div ref={timelineRef} className="h-12 bg-[#272729] rounded-lg cursor-pointer relative mt-8" onClick={handleTimelineClick} onMouseMove={handleTrimDrag} onMouseUp={() => {setIsDraggingTrimStart(false); setIsDraggingTrimEnd(false);}} onMouseLeave={() => {setIsDraggingTrimStart(false); setIsDraggingTrimEnd(false);}}>
                {segment && (
                  <>
                    <div className="absolute top-0 bottom-0 bg-black/50" style={{left: 0, width: `${(segment.trimStart / duration) * 100}%`}} />
                    <div className="absolute top-0 bottom-0 bg-black/50" style={{right: 0, width: `${((duration - segment.trimEnd) / duration) * 100}%`}} />
                  </>
                )}

                {segment && (
                  <>
                    <div className="absolute top-0 bottom-0 w-1 bg-[#d7dadc] cursor-col-resize z-30 hover:bg-[#0079d3]" style={{left: `${(segment.trimStart / duration) * 100}%`}} onMouseDown={() => setIsDraggingTrimStart(true)} />
                    <div className="absolute top-0 bottom-0 w-1 bg-[#d7dadc] cursor-col-resize z-30 hover:bg-[#0079d3]" style={{left: `${(segment.trimEnd / duration) * 100}%`}} onMouseDown={() => setIsDraggingTrimEnd(true)} />
                  </>
                )}

                {segment?.zoomKeyframes.map((keyframe, index) => {
                  const active = editingKeyframeId === index;
                  
                  // Get previous and next keyframes
                  const prevKeyframe = index > 0 ? segment.zoomKeyframes[index - 1] : null;
                  const nextKeyframe = segment.zoomKeyframes[index + 1];
                  
                  // Calculate range start and end
                  // If there's a previous keyframe, start at that keyframe
                  // Otherwise, start 0.5s before current keyframe
                  const rangeStart = prevKeyframe 
                    ? prevKeyframe.time 
                    : Math.max(0, keyframe.time - 0.5);
                    
                  // Range always ends at current keyframe
                  const rangeEnd = keyframe.time;
                  
                  return (
                    <div key={index}>
                      <div 
                        className={`absolute h-full cursor-pointer transition-colors border-r border-[#0079d3] ${active ? 'opacity-100' : 'opacity-80'}`} 
                        style={{
                          left: `${(rangeStart / duration) * 100}%`, 
                          width: `${((rangeEnd - rangeStart) / duration) * 100}%`, 
                          zIndex: 20, 
                          background: `linear-gradient(90deg, rgba(0, 121, 211, 0.1) 0%, rgba(0, 121, 211, ${0.1 + (keyframe.zoomFactor - 1) * 0.3}) 100%)`
                        }} 
                      />
                      <div 
                        className="absolute cursor-pointer group" 
                        style={{
                          left: `${(keyframe.time / duration) * 100}%`, 
                          transform: 'translateX(-50%)', 
                          top: '-32px', 
                          height: '56px'
                        }} 
                        onClick={(e) => {
                          e.stopPropagation(); 
                          if (videoRef.current) {
                            videoRef.current.currentTime = keyframe.time; 
                            setCurrentTime(keyframe.time); 
                            setEditingKeyframeId(index); 
                            setActivePanel('zoom');
                          }
                        }}
                      >
                        <div className="relative flex flex-col items-center">
                          <div className={`px-2 py-1 mb-1 rounded-full text-xs font-medium whitespace-nowrap ${active ? 'bg-[#0079d3] text-white' : 'bg-[#0079d3]/20 text-[#0079d3]'}`}>
                            {Math.round((keyframe.zoomFactor - 1) * 100)}%
                          </div>
                          <div className={`w-3 h-3 bg-[#0079d3] rounded-full hover:scale-125 transition-transform ${active ? 'ring-2 ring-white' : ''}`} />
                          <div className="w-[1px] h-10 bg-[#0079d3]/30 group-hover:bg-[#0079d3]/50" />
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="absolute top-[-16px] bottom-0 flex flex-col items-center pointer-events-none z-30" style={{left: `${(currentTime / duration) * 100}%`, transform: 'translateX(-50%)'}}>
                  <div className={`w-4 h-3 ${!currentVideo ? 'bg-gray-600' : 'bg-red-500'} rounded-t`} />
                  <div className={`w-0.5 flex-1 ${!currentVideo ? 'bg-gray-600' : 'bg-red-500'}`} />
                </div>
              </div>

              <div className="text-center font-mono text-sm text-[#818384] mt-4">{formatTime(currentTime)} / {formatTime(duration)}</div>
            </div>
          </div>
        </div>
      </main>

      {isProcessing && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536]">
            <p className="text-lg text-[#d7dadc]">{exportProgress > 0 ? `Exporting video... ${Math.round(exportProgress)}%` : 'Processing video...'}</p>
          </div>
        </div>
      )}

      {showConfirmNewRecording && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536] max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-[#d7dadc] mb-4">Start New Recording?</h3>
            <p className="text-[#818384] mb-6">Starting a new recording will discard your current video. Are you sure you want to continue?</p>
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setShowConfirmNewRecording(false)} className="bg-transparent border-[#343536] text-[#d7dadc] hover:bg-[#272729] hover:text-[#d7dadc]">Cancel</Button>
              <Button onClick={() => {setShowConfirmNewRecording(false); startNewRecording();}} className="bg-[#0079d3] hover:bg-[#1484d6] text-white">Start New Recording</Button>
            </div>
          </div>
        </div>
      )}

      {currentVideo && !isVideoReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="text-white">Preparing video...</div>
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

