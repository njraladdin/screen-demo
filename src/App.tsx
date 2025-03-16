import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Pause, Video, StopCircle, Plus, Trash2, Search, Download, Loader2, Save, FolderOpen, Upload, Wand2 } from "lucide-react";
import "./App.css";
import { Button } from "@/components/ui/button";
import { videoRenderer } from '@/lib/videoRenderer';
import { BackgroundConfig, VideoSegment, ZoomKeyframe, MousePosition, ExportOptions, Project } from '@/types/video';
import { videoExporter, EXPORT_PRESETS, DIMENSION_PRESETS } from '@/lib/videoExporter';
import { createVideoController } from '@/lib/videoController';
import logo from '@/assets/logo.svg';
import { Timeline } from '@/components/Timeline';
import { thumbnailGenerator } from '@/lib/thumbnailGenerator';
import { RemotionPlayer } from '@/components/RemotionPlayer';

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

// Add these interfaces near the top of the file
interface MonitorInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  is_primary: boolean;
}

// Add this helper function near the top of the file
const sortMonitorsByPosition = (monitors: MonitorInfo[]) => {
  return [...monitors]
    .sort((a, b) => a.x - b.x)
    .map((monitor, index) => ({
      ...monitor,
      name: `Display ${index + 1}${monitor.is_primary ? ' (Primary)' : ''}`
    }));
};

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [segment, setSegment] = useState<VideoSegment | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);

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
  const [activePanel, setActivePanel] = useState<'background' | 'cursor'>('background');

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
  
  // Initialize hidden video element for operations that still require it
  useEffect(() => {
    if (!videoRef.current) {
      videoRef.current = document.createElement('video');
      videoRef.current.crossOrigin = 'anonymous';
      videoRef.current.playsInline = true;
      videoRef.current.preload = 'auto';
    }
    
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    
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

  // Helper function to render a frame (simplified since we're using RemotionPlayer)
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
    if (videoRef.current && segment) {
      videoControllerRef.current?.updateRenderOptions({
        segment,
        backgroundConfig,
        mousePositions
      });
    }
  }, [segment, backgroundConfig, mousePositions]);

  // Add these state variables inside App component
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [showMonitorSelect, setShowMonitorSelect] = useState(false);
  const [selectedMonitor, setSelectedMonitor] = useState<string | null>(null);

  // Add this function to fetch monitors
  const getMonitors = async () => {
    try {
      const monitors = await invoke<MonitorInfo[]>("get_monitors");
      // Sort monitors before setting state
      const sortedMonitors = sortMonitorsByPosition(monitors);
      setMonitors(sortedMonitors);
      return sortedMonitors;
    } catch (err) {
      console.error("Failed to get monitors:", err);
      setError(err as string);
      return [];
    }
  };

  // Update handleStartRecording
  async function handleStartRecording() {
    if (isRecording) return;

    try {
      const monitors = await getMonitors();
      
      if (monitors.length > 1) {
        setShowMonitorSelect(true);
        return;
      }
      
      // If only one monitor, use it directly
      if (currentVideo) {
        setShowConfirmNewRecording(true);
      } else {
        await startNewRecording('0');
      }
    } catch (err) {
      console.error("Failed to handle start recording:", err);
      setError(err as string);
    }
  }

  // Update startNewRecording to handle string IDs
  async function startNewRecording(monitorId: string) {
    try {
      console.log('Starting new recording, clearing states');
      // Clear all states first
      setMousePositions([]);
      setIsVideoReady(false);
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      setSegment(null);
      setThumbnails([]);

      // Clear previous video
      if (currentVideo) {
        URL.revokeObjectURL(currentVideo);
        setCurrentVideo(null);
      }

      // Now start the new recording
      await invoke("start_recording", { monitorId });
      setIsRecording(true);
      setError(null);

      console.log('Recording started, mouse positions cleared');
    } catch (err) {
      console.error("Failed to start recording:", err);
      setError(err as string);
    }
  }

  // Update handleStopRecording
  async function handleStopRecording() {
    if (!isRecording) return;

    try {
      setIsRecording(false);
      setIsLoadingVideo(true);
      setIsVideoReady(false);
      setLoadingProgress(0);
      setThumbnails([]);

      const [videoUrl, mouseData] = await invoke<[string, MousePosition[]]>("stop_recording");
      setMousePositions(mouseData);

      // Use the video controller to load the video for metadata and thumbnails
      const objectUrl = await videoControllerRef.current?.loadVideo({
        videoUrl,
        onLoadingProgress: (progress) => setLoadingProgress(progress)
      });

      if (objectUrl) {
        setCurrentVideo(objectUrl);
        setIsVideoReady(true);
        generateThumbnails();
      }

    } catch (err) {
      console.error("❌ Failed to stop recording:", err);
      setError(err as string);
    } finally {
      setIsLoadingVideo(false);
      setLoadingProgress(0);
    }
  }

  // Add cleanup for object URL
  useEffect(() => {
    return () => {
      if (currentVideo && currentVideo.startsWith('blob:')) {
        URL.revokeObjectURL(currentVideo);
      }
    };
  }, [currentVideo]);

  // Toggle play/pause
  const togglePlayPause = () => {
    // Add a small delay to allow the UI to update first
    setTimeout(() => {
      handlePlayStateChange(!isPlaying);
    }, 50);
  };

  // Handle play state changes
  const handlePlayStateChange = (playing: boolean) => {
    // Set state immediately for UI feedback
    setIsPlaying(playing);
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

  // Replace the debugLog function
  const debugLog = (message: string, data?: any) => {
    if (data) {
      console.log(`[DEBUG] ${message}`, data);
    } else {
      console.log(`[DEBUG] ${message}`);
    }
  };

  // Add new export function to replace video-exporter.ts
  const handleExport = async () => {
    setShowExportDialog(true);
  };

  // Add new method to handle actual export
  const startExport = async () => {
    if (!currentVideo || !segment || !videoRef.current || !canvasRef.current) return;

    try {
      setShowExportDialog(false);
      setIsProcessing(true);

      // Create a complete export options object
      const exportConfig: ExportOptions = {
        quality: exportOptions.quality,
        dimensions: exportOptions.dimensions,
        speed: exportOptions.speed,
        video: videoRef.current,
        canvas: canvasRef.current,
        tempCanvas: tempCanvasRef.current,
        segment,
        backgroundConfig,
        mousePositions,
        onProgress: (progress: number) => {
          setExportProgress(progress);
        }
      };

      await videoExporter.exportAndDownload(exportConfig);

    } catch (error) {
      console.error('[App] Export error:', error);
    } finally {
      setIsProcessing(false);
      setExportProgress(0);
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

  // Update the loading placeholder to show progress
  const renderPlaceholder = () => {
    return (
      <div className="absolute inset-0 bg-[#1a1a1b] flex flex-col items-center justify-center">
        {/* Grid pattern background */}
        <div className="absolute inset-0 opacity-5">
          <div className="w-full h-full" style={{
            backgroundImage: `
              linear-gradient(to right, #fff 1px, transparent 1px),
              linear-gradient(to bottom, #fff 1px, transparent 1px)
            `,
            backgroundSize: '20px 20px'
          }} />
        </div>
        
        {isLoadingVideo ? (
          // Loading state after recording
          <div className="flex flex-col items-center">
            <Loader2 className="w-12 h-12 text-[#0079d3] animate-spin mb-4" />
            <p className="text-[#d7dadc] font-medium">Processing Video</p>
            <p className="text-[#818384] text-sm mt-1">This may take a few moments...</p>
          </div>
        ) : isRecording ? (
          // Recording state
          <div className="flex flex-col items-center">
            <div className="w-4 h-4 rounded-full bg-red-500 animate-pulse mb-4" />
            <p className="text-[#d7dadc] font-medium">Recording in progress...</p>
            <p className="text-[#818384] text-sm mt-1">Screen is being captured</p>
          </div>
        ) : (
          // No video state
          <div className="flex flex-col items-center">
            <Video className="w-12 h-12 text-[#343536] mb-4" />
            <p className="text-[#d7dadc] font-medium">No Video Selected</p>
            <p className="text-[#818384] text-sm mt-1">Click 'Start Recording' to begin</p>
          </div>
        )}
        {isLoadingVideo && loadingProgress > 0 && (
          <div className="mt-2">
            <p className="text-[#818384] text-sm">
              Loading video: {Math.min(Math.round(loadingProgress), 100)}%
            </p>
          </div>
        )}
      </div>
    );
  };

  // Add new state for export options
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportOptions, setExportOptions] = useState<ExportOptions>({
    quality: 'balanced',
    dimensions: '1080p',
    speed: 1 // Default to 100% speed
  });

  // Add these state variables in the App component
  const [thumbnails, setThumbnails] = useState<string[]>([]);

  // Replace the existing generateThumbnails function
  const generateThumbnails = useCallback(async () => {
    if (!currentVideo || !segment) return;
    
    const thumbnails = await thumbnailGenerator.generateThumbnails(currentVideo, 20, {
      trimStart: segment.trimStart,
      trimEnd: segment.trimEnd
    });
    
    setThumbnails(thumbnails);
  }, [currentVideo, segment]);

  // Add this effect
  useEffect(() => {
    if (isVideoReady && duration > 0 && thumbnails.length === 0) {
      generateThumbnails();
    }
  }, [isVideoReady, duration, generateThumbnails]);

  // Initialize segment when video loads
  useEffect(() => {
    if (duration > 0 && !segment) {
      const initialSegment: VideoSegment = {
        trimStart: 0,
        trimEnd: duration,
        textSegments: []
      };
      setSegment(initialSegment);
    }
  }, [duration, segment]);

  return (
    <div className="min-h-screen bg-[#1a1a1b]">
      <header className="bg-[#1a1a1b] border-b border-[#343536]">
        <div className="max-w-6xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <img src={logo} alt="Screen Demo Logo" className="w-8 h-8" />
              <h1 className="text-2xl font-bold text-[#d7dadc]">Screen Demo</h1>
            </div>
            <a 
              href="https://github.com/njraladdin" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="text-[#818384] hover:text-[#d7dadc] transition-colors text-sm underline"
            >
              dev: @njraladdin
            </a>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Button 
                onClick={isRecording ? handleStopRecording : handleStartRecording} 
                disabled={isProcessing || isLoadingVideo} 
                className={`flex items-center px-4 py-2 h-9 text-sm font-medium transition-colors ${
                  isRecording 
                    ? 'bg-red-500 hover:bg-red-600 text-white'
                    : 'bg-[#FF26BE] hover:bg-[#FF26BE]/90 text-white'
                }`}
              >
                {isRecording ? (
                  <><StopCircle className="w-4 h-4 mr-2" />Stop Recording</>
                ) : isLoadingVideo ? (
                  <div className="flex items-center">
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading Video...
                  </div>
                ) : (
                  <><Video className="w-4 h-4 mr-2" />{currentVideo ? 'New Recording' : 'Start Recording'}</>
                )}
              </Button>
              {isRecording && <span className="text-red-500 font-medium">{formatTime(recordingDuration)}</span>}
            </div>
            {currentVideo && (
              <Button 
                onClick={handleExport} 
                disabled={isProcessing} 
                className={`flex items-center px-4 py-2 h-9 text-sm font-medium transition-colors ${
                  isProcessing 
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed' 
                    : 'bg-[#9C17FF] hover:bg-[#9C17FF]/90 text-white'
                }`}
              >
                <Download className="w-4 h-4 mr-2" />Export Video
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {error && <p className="text-red-500 mb-4">{error}</p>}

        <div className="space-y-6">
          <div className="grid grid-cols-4 gap-6 items-start">
            <div className="col-span-3 rounded-lg">
              <div className="aspect-video relative">
                {(!currentVideo || isRecording || isLoadingVideo) ? (
                  <div className="absolute inset-0 flex items-center justify-center">
                    {renderPlaceholder()}
                  </div>
                ) : (
                  <div className="absolute inset-0">
                    <RemotionPlayer 
                      videoUrl={currentVideo}
                      backgroundConfig={backgroundConfig}
                      isPlaying={isPlaying}
                      currentTime={currentTime}
                      duration={duration}
                      setCurrentTime={setCurrentTime}
                      setIsPlaying={setIsPlaying}
                      mousePositions={mousePositions}
                      segment={segment || undefined}
                    />
                  </div>
                )}
                
                {currentVideo && !isRecording && !isLoadingVideo && (
                  <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center gap-3 bg-black/80 rounded-full px-4 py-2 backdrop-blur-sm z-10">
                    <Button 
                      onClick={togglePlayPause} 
                      disabled={isProcessing || !isVideoReady} 
                      variant="ghost" 
                      size="icon"
                      className={`w-8 h-8 rounded-full transition-colors text-white bg-transparent hover:text-white hover:bg-transparent ${
                        isProcessing || !isVideoReady 
                          ? 'opacity-50 cursor-not-allowed' 
                          : ''
                      }`}
                    >
                      {isPlaying ? (
                        <Pause className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4 ml-0.5" />
                      )}
                    </Button>
                    <div className="text-white/90 text-sm font-medium">
                      {formatTime(currentTime)} / {formatTime(duration)}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right panel remains unchanged */}
          </div>

          <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6">
            <div className="space-y-2 mb-8">
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold text-[#d7dadc]">Timeline</h2>
              </div>
              <p className="text-sm text-[#818384]">
                Drag handles to trim video length
              </p>
            </div>

            <Timeline
              duration={duration}
              currentTime={currentTime}
              segment={segment}
              thumbnails={thumbnails}
              timelineRef={timelineRef}
              videoRef={videoRef}
              editingTextId={null}
              setCurrentTime={setCurrentTime}
              setEditingTextId={() => {}}
              setSegment={setSegment}
            />
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
              <Button variant="outline" onClick={() => {setShowConfirmNewRecording(false); setSelectedMonitor(null);}} className="bg-transparent border-[#343536] text-[#d7dadc] hover:bg-[#272729] hover:text-[#d7dadc]">Cancel</Button>
              <Button 
                onClick={() => {
                  setShowConfirmNewRecording(false); 
                  startNewRecording(selectedMonitor ? selectedMonitor : '0'); 
                  setSelectedMonitor(null);
                }} 
                className="bg-[#0079d3] hover:bg-[#1484d6] text-white"
              >
                Start New Recording
              </Button>
            </div>
          </div>
        </div>
      )}

      {showMonitorSelect && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536] max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-[#d7dadc] mb-4">Select Monitor</h3>
            <div className="space-y-3 mb-6">
              {monitors.map((monitor) => (
                <button
                  key={monitor.id}
                  onClick={() => {
                    setShowMonitorSelect(false);
                    if (currentVideo) {
                      setShowConfirmNewRecording(true);
                      setSelectedMonitor(monitor.id);
                    } else {
                      startNewRecording(monitor.id);
                    }
                  }}
                  className="w-full p-4 rounded-lg border border-[#343536] hover:bg-[#272729] transition-colors text-left"
                >
                  <div className="font-medium text-[#d7dadc]">
                    {monitor.name}
                  </div>
                  <div className="text-sm text-[#818384] mt-1">
                    {monitor.width}x{monitor.height} at ({monitor.x}, {monitor.y})
                  </div>
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <Button 
                onClick={() => setShowMonitorSelect(false)} 
                variant="outline" 
                className="bg-transparent border-[#343536] text-[#d7dadc] hover:bg-[#272729] hover:text-[#d7dadc]"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {currentVideo && !isVideoReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="text-white">Preparing video...</div>
        </div>
      )}

      {showExportDialog && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536] max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-[#d7dadc] mb-4">Export Options</h3>
            
            <div className="space-y-4 mb-6">
              <div>
                <label className="text-sm font-medium text-[#d7dadc] mb-2 block">Quality</label>
                <select 
                  value={exportOptions.quality}
                  onChange={(e) => setExportOptions(prev => ({ ...prev, quality: e.target.value as ExportOptions['quality'] }))}
                  className="w-full bg-[#272729] border border-[#343536] rounded-md px-3 py-2 text-[#d7dadc]"
                >
                  {Object.entries(EXPORT_PRESETS).map(([key, preset]) => (
                    <option key={key} value={key}>{preset.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-[#d7dadc] mb-2 block">Dimensions</label>
                <select 
                  value={exportOptions.dimensions}
                  onChange={(e) => setExportOptions(prev => ({ ...prev, dimensions: e.target.value as ExportOptions['dimensions'] }))}
                  className="w-full bg-[#272729] border border-[#343536] rounded-md px-3 py-2 text-[#d7dadc]"
                >
                  {Object.entries(DIMENSION_PRESETS).map(([key, preset]) => (
                    <option key={key} value={key}>{preset.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-[#d7dadc] mb-2 block">Speed</label>
                <div className="bg-[#272729] rounded-md p-3">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-[#d7dadc] tabular-nums">
                        {formatTime(segment ? (segment.trimEnd - segment.trimStart) / exportOptions.speed : 0)}
                      </span>
                      {segment && exportOptions.speed !== 1 && (
                        <span className={`text-xs ${exportOptions.speed > 1 ? 'text-red-400/90' : 'text-green-400/90'}`}>
                          {exportOptions.speed > 1 ? '↓' : '↑'}
                          {formatTime(Math.abs(
                            (segment.trimEnd - segment.trimStart) - 
                            ((segment.trimEnd - segment.trimStart) / exportOptions.speed)
                          ))}
                        </span>
                      )}
                    </div>
                    <span className="text-sm font-medium text-[#d7dadc] tabular-nums">
                      {Math.round(exportOptions.speed * 100)}%
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-xs text-[#818384] min-w-[36px]">Slower</span>
                    <div className="flex-1">
                      <input 
                        type="range" 
                        min="50" 
                        max="200" 
                        step="10"
                        value={exportOptions.speed * 100}
                        onChange={(e) => setExportOptions(prev => ({ 
                          ...prev, 
                          speed: Number(e.target.value) / 100 
                        }))}
                        className="w-full h-1 accent-[#0079d3] rounded-full"
                        style={{
                          background: `linear-gradient(to right, 
                            #818384 0%, 
                            #0079d3 ${((exportOptions.speed * 100 - 50) / 150) * 100}%`
                        }}
                      />
                    </div>
                    <span className="text-xs text-[#818384] min-w-[36px]">Faster</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <Button 
                variant="outline" 
                onClick={() => setShowExportDialog(false)}
                className="bg-transparent border-[#343536] text-[#d7dadc] hover:bg-[#272729] hover:text-[#d7dadc]"
              >
                Cancel
              </Button>
              <Button 
                onClick={startExport}
                className="bg-[#0079d3] hover:bg-[#0079d3]/90 text-white"
              >
                Export Video
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


