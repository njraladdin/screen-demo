import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg'
import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Play, Pause, Plus, Search, Download } from "lucide-react"

// Create FFmpeg instance outside the component
const ffmpeg = createFFmpeg({ log: true });

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

// Add these easing functions at the top of the file
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);
const easeInOutCubic = (x: number): number => 
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

export default function App() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<string | null>(null);
  const [isFFmpegReady, setIsFFmpegReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDraggingTrimStart, setIsDraggingTrimStart] = useState(false);
  const [isDraggingTrimEnd, setIsDraggingTrimEnd] = useState(false);
  const [segment, setSegment] = useState<VideoSegment | null>(null);
  const [isAddingZoom, setIsAddingZoom] = useState(false);
  const [zoomDuration, setZoomDuration] = useState(1); // Default 1 second
  const [zoomFactor, setZoomFactor] = useState(1.5); // Default 50% zoom
  const [isPlaying, setIsPlaying] = useState(false);
  const [editingZoomId, setEditingZoomId] = useState<number | null>(null);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const animationFrameRef = useRef<number>();

  // Add FFmpeg.js progress handler
  ffmpeg.setProgress(({ ratio }) => setProgress(Math.round(ratio * 100)));

  // Update currentTime when video plays
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => setCurrentTime(video.currentTime);
    const handleLoadedMetadata = () => setDuration(video.duration);
    const handleLoadedData = () => setDuration(video.duration);

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('loadeddata', handleLoadedData);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('loadeddata', handleLoadedData);
    };
  }, [currentVideo]);

  // Initialize single segment when video loads
  useEffect(() => {
    if (duration > 0) {
      const initialSegment: VideoSegment = {
        id: 'trim',
        trimStart: 0,
        trimEnd: duration,
        zoomEffects: []
      };
      setSegment(initialSegment);
    }
  }, [duration]);

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

  const loadFFmpeg = async () => {
    await ffmpeg.load();
    setIsFFmpegReady(true);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setIsProcessing(true);
      
      if (!isFFmpegReady) {
        await loadFFmpeg();
      }

      const inputFileName = 'input.mp4';
      const outputFileName = 'output.mp4';

      // Just load the video initially - no effects
      ffmpeg.FS('writeFile', inputFileName, await fetchFile(file));
      await ffmpeg.run(
        '-i', inputFileName,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputFileName
      );

      const data = ffmpeg.FS('readFile', outputFileName);
      const videoBlob = new Blob([data.buffer], { type: 'video/mp4' });
      const videoUrl = URL.createObjectURL(videoBlob);
      setCurrentVideo(videoUrl);

      ffmpeg.FS('unlink', inputFileName);
      ffmpeg.FS('unlink', outputFileName);

    } catch (error) {
      console.error('Error processing video:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const processWithZoomEffects = async () => {
    if (!currentVideo || !segment || segment.zoomEffects.length === 0) return;

    try {
      setIsProcessing(true);
      
      const inputFileName = 'input.mp4';
      const outputFileName = 'output_with_zoom.mp4';

      // Write current video to FFmpeg filesystem
      const response = await fetch(currentVideo);
      const videoData = await response.arrayBuffer();
      ffmpeg.FS('writeFile', inputFileName, new Uint8Array(videoData));

      // Build FFmpeg filter command for zoom effects
      const filterCommands = segment.zoomEffects.map(effect => {
        const startTime = effect.time;
        const endTime = effect.time + effect.duration;
        const zoomExpression = `zoompan=z='if(between(t,${startTime},${endTime}),${effect.zoomFactor}+((t-${startTime})/${effect.duration})*(1-${effect.zoomFactor}),1)'`;
        return zoomExpression;
      }).join(',');

      // Process video with zoom effects
      await ffmpeg.run(
        '-i', inputFileName,
        '-vf', filterCommands,
        '-c:a', 'copy',
        outputFileName
      );

      const data = ffmpeg.FS('readFile', outputFileName);
      const videoBlob = new Blob([data.buffer], { type: 'video/mp4' });
      const videoUrl = URL.createObjectURL(videoBlob);
      setCurrentVideo(videoUrl);

      // Cleanup
      ffmpeg.FS('unlink', inputFileName);
      ffmpeg.FS('unlink', outputFileName);

    } catch (error) {
      console.error('Error applying zoom effects:', error);
    } finally {
      setIsProcessing(false);
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
    if (!segment) return;
    const zoomEffect = segment.zoomEffects[index];
    setZoomDuration(zoomEffect.duration);
    setZoomFactor(zoomEffect.zoomFactor);
    setEditingZoomId(index);
    setIsAddingZoom(true);
    
    // Set playhead to end of zoom transition
    if (videoRef.current) {
      videoRef.current.currentTime = zoomEffect.time + zoomEffect.duration;
    }
  };

  // Add effect to initialize canvas and handle rendering
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !segment) return;

    // Setup canvas
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvasCtxRef.current = ctx;

    // Match canvas size to video
    const updateCanvasSize = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    };
    
    // Update the drawFrame function with smoother transitions
    const drawFrame = () => {
      if (!ctx || !video) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      
      // Find the last zoom effect before current time
      const activeZoom = segment.zoomEffects
        .sort((a, b) => a.time - b.time)
        .filter(effect => video.currentTime >= effect.time)
        .pop();

      if (activeZoom) {
        // Find the previous zoom effect
        const previousZoom = segment.zoomEffects
          .sort((a, b) => a.time - b.time)
          .filter(effect => effect.time < activeZoom.time)
          .pop();

        let currentZoom = activeZoom.zoomFactor;
        let currentPosX = activeZoom.positionX;
        let currentPosY = activeZoom.positionY;

        const TRANSITION_DURATION = 1.0;
        
        // Calculate transition progress
        const transitionProgress = Math.min(
          (video.currentTime - activeZoom.time) / TRANSITION_DURATION,
          1
        );
        
        // Apply easing
        const easedProgress = easeOutCubic(transitionProgress);

        if (previousZoom) {
          // Interpolate between previous and current values
          currentZoom = previousZoom.zoomFactor + (activeZoom.zoomFactor - previousZoom.zoomFactor) * easedProgress;
          currentPosX = previousZoom.positionX + (activeZoom.positionX - previousZoom.positionX) * easedProgress;
          currentPosY = previousZoom.positionY + (activeZoom.positionY - previousZoom.positionY) * easedProgress;
        } else {
          // For first zoom, immediately use target position but ease the zoom
          currentZoom = 1 + (activeZoom.zoomFactor - 1) * easedProgress;
          currentPosX = activeZoom.positionX;  // Use target position immediately
          currentPosY = activeZoom.positionY;  // Use target position immediately
        }

        // Calculate the scaled dimensions with subpixel accuracy
        const scaledWidth = canvas.width * currentZoom;
        const scaledHeight = canvas.height * currentZoom;
        
        // Calculate the position offset based on the interpolated position
        const offsetX = (canvas.width - scaledWidth) * currentPosX;
        const offsetY = (canvas.height - scaledHeight) * currentPosY;

        // Apply transform with subpixel rendering
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.translate(Math.round(offsetX * 100) / 100, Math.round(offsetY * 100) / 100);
        ctx.scale(currentZoom, currentZoom);
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      animationFrameRef.current = requestAnimationFrame(drawFrame);
    };

    // Handle video events
    const handlePlay = () => {
      drawFrame();
    };

    const handlePause = () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };

    const handleSeeked = () => {
      drawFrame();
    };

    // Update canvas size when video metadata is loaded
    video.addEventListener('loadedmetadata', updateCanvasSize);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('seeked', handleSeeked);

    // Initial draw
    updateCanvasSize();
    drawFrame();

    // Cleanup
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      video.removeEventListener('loadedmetadata', updateCanvasSize);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('seeked', handleSeeked);
    };
  }, [segment]);

  // Add play/pause control function
  const togglePlay = () => {
    if (!videoRef.current) return;
    
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  // Add effect to sync video play state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePause = () => setIsPlaying(false);
    const handlePlay = () => setIsPlaying(true);
    const handleEnded = () => setIsPlaying(false);

    video.addEventListener('pause', handlePause);
    video.addEventListener('play', handlePlay);
    video.addEventListener('ended', handleEnded);

    return () => {
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('ended', handleEnded);
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
      setZoomDuration(segment.zoomEffects[activeZoom].duration);
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
    const previousZoom = [...segment.zoomEffects]
      .sort((a, b) => a.time - b.time)
      .reduce((current, effect) => {
        if (videoRef.current && effect.time < videoRef.current.currentTime) {
          return effect;
        }
        return current;
      }, null);

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

  return (
    <div className="min-h-screen bg-[#1a1a1b]">
      {/* Header */}
      <header className="bg-[#1a1a1b] border-b border-[#343536]">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-[#d7dadc]">Video Editor</h1>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* File Upload Section */}
        <div className="mb-6">
          <input
            type="file"
            accept="video/*"
            onChange={handleFileUpload}
            disabled={isProcessing}
            className="block w-full text-sm text-[#d7dadc]
              file:mr-4 file:py-2 file:px-4
              file:rounded-full file:border-0
              file:text-sm file:font-semibold
              file:bg-[#0079d3] file:text-white
              hover:file:bg-[#1484d6]"
          />
        </div>

        {isProcessing && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="bg-[#1a1a1b] p-6 rounded-lg border border-[#343536]">
              <p className="text-lg text-[#d7dadc]">Processing video... {progress}%</p>
            </div>
          </div>
        )}

        {currentVideo && (
          <div className="space-y-6">
            {/* Video Preview Section */}
            <div className="bg-black rounded-lg p-4">
              <div className="aspect-video relative overflow-hidden rounded-lg">
                <video 
                  ref={videoRef}
                  src={currentVideo}
                  className="hidden"
                  onLoadedMetadata={(e) => {
                    setDuration(e.currentTarget.duration);
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

            {/* Editor Controls Section */}
            <div className="space-y-6">
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
                      // Find the previous zoom effect
                      const previousZoom = [...segment.zoomEffects]
                        .sort((a, b) => a.time - b.time)
                        .reduce((current, effect2) => {
                          if (effect2.time < effect.time) {
                            return effect2;
                          }
                          return current;
                        }, null);

                      const fromZoom = previousZoom ? 
                        Math.round((previousZoom.zoomFactor - 1) * 100) : 
                        0;
                      const toZoom = Math.round((effect.zoomFactor - 1) * 100);

                      return (
                        <div
                          key={index}
                          onClick={() => startEditingZoom(index)}
                          className={`absolute h-full cursor-pointer group ${
                            editingZoomId === index ? 'bg-[#0079d3]/40' : 'bg-[#0079d3]/20'
                          } hover:bg-[#0079d3]/40 transition-colors border-l-2 border-r-2 border-[#0079d3] z-50`}
                          style={{
                            left: `${(effect.time / duration) * 100}%`,
                            width: `${(effect.duration / duration) * 100}%`,
                          }}
                        >
                          <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs whitespace-nowrap bg-[#0079d3] text-white px-2 rounded z-35">
                            {fromZoom}% → {toZoom}% zoom
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (segment) {
                                setSegment({
                                  ...segment,
                                  zoomEffects: segment.zoomEffects.filter((_, i) => i !== index)
                                });
                              }
                            }}
                            className="absolute -right-2 -top-2 w-4 h-4 bg-red-500 rounded-full text-white 
                              flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-35"
                          >
                            ×
                          </button>
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

              {/* Zoom Configuration Panel */}
              {isAddingZoom ? (
                <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-6">
                  <div className="flex justify-between items-center mb-6">
                    <h2 className="text-lg font-semibold text-[#d7dadc]">Zoom Configuration</h2>
                    <span className="text-[#818384]">
                      At {formatTime(currentTime)}
                    </span>
                  </div>
                  <div className="space-y-6">
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
                    
                    <div className="grid grid-cols-2 gap-4">
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
                <div className="bg-[#1a1a1b] rounded-lg border border-[#343536] p-8 flex flex-col items-center justify-center text-center">
                  <div className="bg-[#272729] rounded-full p-3 mb-3">
                    <Search className="w-6 h-6 text-[#818384]" />
                  </div>
                  <p className="text-[#d7dadc] font-medium">No Zoom Effect Selected</p>
                  <p className="text-[#818384] text-sm mt-1">
                    Select a zoom effect on the timeline or add a new one to configure
                  </p>
                </div>
              )}

              {/* Export Button */}
              {segment && segment.zoomEffects && segment.zoomEffects.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    onClick={processWithZoomEffects}
                    disabled={isProcessing}
                    className="bg-[#0079d3] hover:bg-[#1484d6] text-white px-6"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Export Video with Effects
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// Helper function to format time in MM:SS format
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}
