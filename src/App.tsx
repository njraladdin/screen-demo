import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Pause, Video, StopCircle, Plus, Trash2, Search, Download, Loader2, Save, FolderOpen } from "lucide-react";
import "./App.css";
import { Button } from "@/components/ui/button";
import { videoRenderer } from '@/lib/videoRenderer';
import { BackgroundConfig, VideoSegment, ZoomKeyframe, MousePosition, ExportOptions, Project } from '@/types/video';
import { videoExporter, EXPORT_PRESETS, DIMENSION_PRESETS } from '@/lib/videoExporter';
import { createVideoController } from '@/lib/videoController';
import logo from '@/assets/logo.svg';
import { projectManager } from '@/lib/projectManager';

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

// Added helper function to calculate the range for a zoom keyframe.
// It returns an object containing the range start and end for the given keyframe.
const getKeyframeRange = (
  keyframes: ZoomKeyframe[],
  index: number
): { rangeStart: number; rangeEnd: number } => {
  const keyframe = keyframes[index];
  const prevKeyframe = index > 0 ? keyframes[index - 1] : null;
  const rangeStart =
    prevKeyframe && keyframe.time - prevKeyframe.time <= 1.0
      ? prevKeyframe.time
      : Math.max(0, keyframe.time - 1.0);
  return { rangeStart, rangeEnd: keyframe.time };
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

    // Start animation when playing, render single frame when paused
    if (video.paused) {
      renderFrame();
    } else {
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

      const [videoUrl, mouseData] = await invoke<[string, MousePosition[]]>("stop_recording");
      setMousePositions(mouseData);
      setLoadingProgress(25);

      // Fetch the video data first
      console.log('[App] Fetching video data from:', videoUrl);
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
        const progress = Math.min(((receivedLength / contentLength) * 75), 75);
        setLoadingProgress(25 + progress); // 25-100%
      }

      // Combine all chunks into a single Uint8Array
      const videoData = new Uint8Array(receivedLength);
      let position = 0;
      for(const chunk of chunks) {
        videoData.set(chunk, position);
        position += chunk.length;
      }

      // Create blob and object URL
      const blob = new Blob([videoData], { type: 'video/mp4' });
      const objectUrl = URL.createObjectURL(blob);
      setCurrentVideo(objectUrl);

      if (videoRef.current) {
        const video = videoRef.current;
        
        // Wait for video to be fully loaded
        const handleCanPlayThrough = () => {
          console.log('[App] Video can play through');
          video.removeEventListener('canplaythrough', handleCanPlayThrough);
          setIsVideoReady(true);
          setIsLoadingVideo(false);
          setLoadingProgress(100);
        };

        video.addEventListener('canplaythrough', handleCanPlayThrough);
        videoControllerRef.current?.handleVideoSourceChange(objectUrl);
      }

    } catch (err) {
      console.error("❌ Failed to stop recording:", err);
      setError(err as string);
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

    console.log('[Timeline] Click seek:', {
      percent,
      newTime,
      currentTime: video.currentTime,
      duration
    });

    if (newTime >= segment.trimStart && newTime <= segment.trimEnd) {
      // Use the video controller instead of directly setting currentTime
      videoControllerRef.current?.seek(newTime);
      
      // Add a small delay before setting current time in state
      requestAnimationFrame(() => {
        setCurrentTime(newTime);
      });
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

  // Update the throttled update function for zoom configuration
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

    // Seek to the keyframe's time to show the final zoom state
    if (videoRef.current) {
      const keyframeTime = updatedKeyframes[editingKeyframeId].time;
      videoRef.current.currentTime = keyframeTime;
      setCurrentTime(keyframeTime);
    }

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

  // Add this effect after the other useEffect hooks
  useEffect(() => {
    if (!segment || !isVideoReady) return;

    // Find the active keyframe based on current time
    const findActiveKeyframe = () => {
      const sortedKeyframes = [...segment.zoomKeyframes].sort((a, b) => a.time - b.time);

      for (let i = 0; i < sortedKeyframes.length; i++) {
        // Use the helper to compute rangeStart and rangeEnd
        const { rangeStart, rangeEnd } = getKeyframeRange(sortedKeyframes, i);

        // Check if current time is within this keyframe's range
        if (currentTime >= rangeStart && currentTime <= rangeEnd) {
          if (editingKeyframeId !== i) {
            setEditingKeyframeId(i);
            setZoomFactor(sortedKeyframes[i].zoomFactor);
            if (activePanel !== "zoom") {
              setActivePanel("zoom");
            }
          }
          return;
        }
      }

      // If we're not in any keyframe's range, deselect
      if (editingKeyframeId !== null) {
        setEditingKeyframeId(null);
      }
    };

    findActiveKeyframe();
  }, [currentTime, segment, isVideoReady]);

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
  const [projects, setProjects] = useState<Omit<Project, 'videoBlob'>[]>([]);
  const [showProjectsDialog, setShowProjectsDialog] = useState(false);

  // Add this effect to load projects on mount
  useEffect(() => {
    loadProjects();
  }, []);

  // Add these functions to the App component
  const loadProjects = async () => {
    const projects = await projectManager.getProjects();
    setProjects(projects);
  };

  // Add new state for the save dialog
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState('');

  // Add new state for current project
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  // Update handleSaveProject to show different options when editing existing project
  const handleSaveProject = async () => {
    if (!currentVideo || !segment) return;
    
    if (currentProjectId) {
      // We're editing an existing project - show save options
      setShowSaveDialog(true);
      setProjectNameInput(projects.find(p => p.id === currentProjectId)?.name || 'Untitled Project');
    } else {
      // New project
      setShowSaveDialog(true);
      setProjectNameInput('Untitled Project');
    }
  };

  // Update handleSaveConfirm to handle both new and existing projects
  const handleSaveConfirm = async () => {
    if (!currentVideo || !segment || !projectNameInput.trim()) return;

    const response = await fetch(currentVideo);
    const videoBlob = await response.blob();

    if (currentProjectId) {
      // Update existing project
      await projectManager.updateProject(currentProjectId, {
        name: projectNameInput,
        videoBlob,
        segment,
        backgroundConfig,
        mousePositions
      });
    } else {
      // Create new project
      const project = await projectManager.saveProject({
        name: projectNameInput,
        videoBlob,
        segment,
        backgroundConfig,
        mousePositions
      });
      setCurrentProjectId(project.id);
    }

    setShowSaveDialog(false);
    await loadProjects();
  };

  // Update handleLoadProject to set current project ID
  const handleLoadProject = async (projectId: string) => {
    const project = await projectManager.loadProject(projectId);
    if (!project) return;

    // Clear previous video
    if (currentVideo) {
      URL.revokeObjectURL(currentVideo);
    }

    // Set up new video
    const videoUrl = URL.createObjectURL(project.videoBlob);
    setCurrentVideo(videoUrl);
    setSegment(project.segment);
    setBackgroundConfig(project.backgroundConfig);
    setMousePositions(project.mousePositions);
    setShowProjectsDialog(false);
    setCurrentProjectId(projectId);

    // Update video controller
    videoControllerRef.current?.handleVideoSourceChange(videoUrl);
  };

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
                className={`flex items-center px-4 py-2 h-9 text-sm font-medium ${
                  isProcessing 
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed' 
                    : 'bg-[#9C17FF] hover:bg-[#9C17FF]/90 text-white'
                }`}
              >
                <Download className="w-4 h-4 mr-2" />Export Video
              </Button>
            )}
            {currentVideo && (
              <Button
                onClick={handleSaveProject}
                className="bg-[#272729] hover:bg-[#343536] text-[#d7dadc]"
              >
                <Save className="w-4 h-4 mr-2" />Save Project
              </Button>
            )}
            <Button
              onClick={() => setShowProjectsDialog(true)}
              className="bg-[#272729] hover:bg-[#343536] text-[#d7dadc]"
            >
              <FolderOpen className="w-4 h-4 mr-2" />Recent Projects
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {error && <p className="text-red-500 mb-4">{error}</p>}

        <div className="space-y-6">
          <div className="grid grid-cols-4 gap-6 items-start">
            <div className="col-span-3 rounded-lg">
              <div className="aspect-video relative">
                <div className="absolute inset-0 flex items-center justify-center">
                  <canvas ref={canvasRef} className="w-full h-full object-contain" />
                  <video ref={videoRef} className="hidden" playsInline preload="auto" crossOrigin="anonymous" />
                  {(!currentVideo || isRecording || isLoadingVideo) && renderPlaceholder()}
                </div>
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

            <div className="col-span-1 space-y-3">
              <div className="flex bg-[#272729] p-0.5 rounded-md">
                <Button 
                  onClick={() => setActivePanel('zoom')} 
                  variant={activePanel === 'zoom' ? 'default' : 'outline'} 
                  size="sm" 
                  className={`flex-1 ${
                    activePanel === 'zoom' 
                      ? 'bg-[#1a1a1b] text-[#d7dadc] border-0'
                      : 'bg-transparent text-[#818384] border-0 hover:bg-[#1a1a1b]/10 hover:text-[#d7dadc]'
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
                      ? 'bg-[#1a1a1b] text-[#d7dadc] border-0'
                      : 'bg-transparent text-[#818384] border-0 hover:bg-[#1a1a1b]/10 hover:text-[#d7dadc]'
                  }`}
                >
                  Background
                </Button>
                <Button 
                  onClick={() => setActivePanel('cursor')} 
                  variant={activePanel === 'cursor' ? 'default' : 'outline'} 
                  size="sm" 
                  className={`flex-1 ${
                    activePanel === 'cursor' 
                      ? 'bg-[#1a1a1b] text-[#d7dadc] border-0'
                      : 'bg-transparent text-[#818384] border-0 hover:bg-[#1a1a1b]/10 hover:text-[#d7dadc]'
                  }`}
                >
                  Cursor
                </Button>
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
                          <label className="text-sm font-medium text-[#d7dadc] mb-2">Zoom Factor</label>
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
                            <label className="text-sm font-medium text-[#d7dadc] mb-2 flex justify-between"><span>Horizontal Position</span><span className="text-[#818384]">{Math.round((segment?.zoomKeyframes[editingKeyframeId!]?.positionX ?? 0.5) * 100)}%</span></label>
                            <input type="range" min="0" max="1" step="0.01" value={segment?.zoomKeyframes[editingKeyframeId!]?.positionX ?? 0.5} onChange={(e) => {throttledUpdateZoom({ positionX: Number(e.target.value) });}} className="w-full accent-[#0079d3]" />
                          </div>
                          <div>
                            <label className="text-sm font-medium text-[#d7dadc] mb-2 flex justify-between"><span>Vertical Position</span><span className="text-[#818384]">{Math.round((segment?.zoomKeyframes[editingKeyframeId!]?.positionY ?? 0.5) * 100)}%</span></label>
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
                      <label className="text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                        <span>Video Size</span>
                        <span className="text-[#818384]">{backgroundConfig.scale}%</span>
                      </label>
                      <input type="range" min="50" max="100" value={backgroundConfig.scale} 
                        onChange={(e) => setBackgroundConfig(prev => ({...prev, scale: Number(e.target.value)}))} 
                        className="w-full accent-[#0079d3]" 
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                        <span>Roundness</span>
                        <span className="text-[#818384]">{backgroundConfig.borderRadius}px</span>
                      </label>
                      <input type="range" min="0" max="64" value={backgroundConfig.borderRadius} 
                        onChange={(e) => setBackgroundConfig(prev => ({...prev, borderRadius: Number(e.target.value)}))} 
                        className="w-full accent-[#0079d3]" 
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                        <span>Shadow</span>
                        <span className="text-[#818384]">{backgroundConfig.shadow || 0}px</span>
                      </label>
                      <input type="range" min="0" max="100" value={backgroundConfig.shadow || 0} 
                        onChange={(e) => setBackgroundConfig(prev => ({...prev, shadow: Number(e.target.value)}))} 
                        className="w-full accent-[#0079d3]" 
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-[#d7dadc] mb-3">Background Style</label>
                      <div className="grid grid-cols-4 gap-2">
                        {Object.entries(GRADIENT_PRESETS).map(([key, gradient]) => (
                          <button 
                            key={key} 
                            onClick={() => setBackgroundConfig(prev => ({...prev, backgroundType: key as BackgroundConfig['backgroundType']}))} 
                            className={`aspect-square h-10 rounded-lg transition-all ${gradient} ${  // Changed from h-14 to h-10 and added aspect-square
                              backgroundConfig.backgroundType === key 
                                ? 'ring-2 ring-[#0079d3] ring-offset-2 ring-offset-[#1a1a1b] scale-105' 
                                : 'ring-1 ring-[#343536] hover:ring-[#0079d3]/50'
                            }`} 
                          />
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
                      <label className="text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
                        <span>Cursor Size</span>
                        <span className="text-[#818384]">{backgroundConfig.cursorScale || 2}x</span>
                      </label>
                      <input 
                        type="range" 
                        min="1" 
                        max="8" 
                        step="0.1" 
                        value={backgroundConfig.cursorScale || 2} 
                        onChange={(e) => setBackgroundConfig(prev => ({...prev, cursorScale: Number(e.target.value)}))}
                        className="w-full accent-[#0079d3]" 
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-[#d7dadc] mb-2 flex justify-between">
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
              <Button 
                onClick={() => {handleAddKeyframe(); setActivePanel('zoom');}} 
                disabled={isProcessing || !currentVideo} 
                className={`flex items-center px-4 py-2 h-9 text-sm font-medium transition-colors ${
                  !currentVideo || isProcessing 
                    ? 'bg-gray-600/50 text-gray-400 cursor-not-allowed' 
                    : 'bg-[#0079d3] hover:bg-[#0079d3]/90 text-white shadow-sm'
                }`}
              >
                <Plus className="w-4 h-4 mr-2" />Add Zoom at Playhead
              </Button>
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

                {segment && (
                  <>
                    {segment.zoomKeyframes.map((keyframe, index) => {
                      const active = editingKeyframeId === index;
                      // Use the helper to calculate the keyframe range
                      const { rangeStart, rangeEnd } = getKeyframeRange(segment.zoomKeyframes, index);

                      return (
                        <div key={index}>
                          <div
                            className={`absolute h-full cursor-pointer transition-colors border-r border-[#0079d3] ${
                              active ? "opacity-100" : "opacity-80"
                            }`}
                            style={{
                              left: `${(rangeStart / duration) * 100}%`,
                              width: `${((rangeEnd - rangeStart) / duration) * 100}%`,
                              zIndex: 20,
                              background: `linear-gradient(90deg, rgba(0, 121, 211, 0.1) 0%, rgba(0, 121, 211, ${
                                0.1 + (keyframe.zoomFactor - 1) * 0.3
                              }) 100%)`
                            }}
                          />
                          <div
                            className="absolute cursor-pointer group"
                            style={{
                              left: `${(keyframe.time / duration) * 100}%`,
                              transform: "translateX(-50%)",
                              top: "-32px",
                              height: "56px"
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (videoRef.current) {
                                videoRef.current.currentTime = keyframe.time;
                                setCurrentTime(keyframe.time);
                                setEditingKeyframeId(index);
                                setActivePanel("zoom");
                              }
                            }}
                          >
                            <div className="relative flex flex-col items-center">
                              <div
                                className={`px-2 py-1 mb-1 rounded-full text-xs font-medium whitespace-nowrap ${
                                  active ? "bg-[#0079d3] text-white" : "bg-[#0079d3]/20 text-[#0079d3]"
                                }`}
                              >
                                {Math.round((keyframe.zoomFactor - 1) * 100)}%
                              </div>
                              <div
                                className={`w-3 h-3 bg-[#0079d3] rounded-full hover:scale-125 transition-transform ${
                                  active ? "ring-2 ring-white" : ""
                                }`}
                              />
                              <div className="w-[1px] h-10 bg-[#0079d3]/30 group-hover:bg-[#0079d3]/50" />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}

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
                            #0079d3 ${((exportOptions.speed * 100 - 50) / 150) * 100}%, 
                            #272729 ${((exportOptions.speed * 100 - 50) / 150) * 100}%)`
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

      {showProjectsDialog && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536] max-w-2xl w-full mx-4">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-semibold text-[#d7dadc]">Recent Projects</h3>
              <Button
                variant="ghost"
                onClick={() => setShowProjectsDialog(false)}
                className="text-[#818384] hover:text-[#d7dadc]"
              >
                ✕
              </Button>
            </div>

            {projects.length === 0 ? (
              <div className="text-center py-8 text-[#818384]">
                No saved projects yet
              </div>
            ) : (
              <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                {projects.map((project) => (
                  <div
                    key={project.id}
                    className="flex items-center justify-between p-4 rounded-lg border border-[#343536] hover:bg-[#272729] transition-colors"
                  >
                    <div>
                      <h4 className="text-[#d7dadc] font-medium">{project.name}</h4>
                      <p className="text-sm text-[#818384]">
                        Last modified: {new Date(project.lastModified).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleLoadProject(project.id)}
                        className="bg-[#0079d3] hover:bg-[#0079d3]/90 text-white"
                      >
                        Load Project
                      </Button>
                      <Button
                        onClick={async () => {
                          await projectManager.deleteProject(project.id);
                          await loadProjects();
                        }}
                        variant="destructive"
                        className="bg-red-500/10 hover:bg-red-500/20 text-red-500"
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showSaveDialog && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536] max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-[#d7dadc] mb-4">Save Project</h3>
            <input
              type="text"
              value={projectNameInput}
              onChange={(e) => setProjectNameInput(e.target.value)}
              placeholder="Enter project name"
              className="w-full bg-[#272729] border border-[#343536] rounded-md px-3 py-2 text-[#d7dadc] mb-6"
              autoFocus
            />
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setShowSaveDialog(false)}
                className="bg-transparent border-[#343536] text-[#d7dadc] hover:bg-[#272729] hover:text-[#d7dadc]"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveConfirm}
                disabled={!projectNameInput.trim()}
                className="bg-[#0079d3] hover:bg-[#0079d3]/90 text-white disabled:opacity-50"
              >
                Save Project
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


