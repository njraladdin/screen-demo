import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg'
import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Play, Pause } from "lucide-react"

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
}

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

  const handleZoomChange = (duration: number, factor: number) => {
    if (!segment || !videoRef.current) return;
    
    const newZoomEffect: ZoomEffect = {
      time: videoRef.current.currentTime,
      duration: duration,
      zoomFactor: factor
    };

    setSegment({
      ...segment,
      zoomEffects: editingZoomId !== null
        ? segment.zoomEffects.map((effect, index) => 
            index === editingZoomId ? newZoomEffect : effect
          )
        : [...segment.zoomEffects, { ...newZoomEffect }]
    });
  };

  const startEditingZoom = (index: number) => {
    if (!segment) return;
    const zoomEffect = segment.zoomEffects[index];
    setZoomDuration(zoomEffect.duration);
    setZoomFactor(zoomEffect.zoomFactor);
    setEditingZoomId(index);
    setIsAddingZoom(true);
    
    // Set playhead to zoom position
    if (videoRef.current) {
      videoRef.current.currentTime = zoomEffect.time;
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
    
    // Draw function with zoom effect
    const drawFrame = () => {
      if (!ctx || !video) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      
      // Find active zoom effect at current time
      const activeZoom = segment.zoomEffects.find(effect => 
        video.currentTime >= effect.time && 
        video.currentTime <= (effect.time + effect.duration)
      );

      if (activeZoom) {
        // Calculate progress through the zoom effect (0 to 1)
        const progress = (video.currentTime - activeZoom.time) / activeZoom.duration;
        
        // Calculate zoom factor:
        // Start at 1 (no zoom)
        // Smoothly transition to target zoom
        // Then smoothly transition back to 1
        let currentZoom;
        if (progress < 0.5) {
          // Zoom in during first half
          currentZoom = 1 + (2 * progress) * (activeZoom.zoomFactor - 1);
        } else {
          // Zoom out during second half
          currentZoom = activeZoom.zoomFactor - (2 * (progress - 0.5)) * (activeZoom.zoomFactor - 1);
        }

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        ctx.translate(centerX, centerY);
        ctx.scale(currentZoom, currentZoom);
        ctx.translate(-centerX, -centerY);
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

  // Update handleZoomChange to add default zoom when clicking "Add Zoom"
  const handleAddZoom = () => {
    if (!segment || !videoRef.current) return;
    
    const newZoomEffect: ZoomEffect = {
      time: videoRef.current.currentTime,
      duration: 1, // 1 second default duration
      zoomFactor: 1.5 // 50% zoom by default
    };

    setSegment({
      ...segment,
      zoomEffects: [...segment.zoomEffects, newZoomEffect]
    });
    
    // Start editing the new zoom
    setZoomDuration(1);
    setZoomFactor(1.5);
    setIsAddingZoom(true);
    setEditingZoomId(segment.zoomEffects.length);
  };

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <div className="space-y-4">
        <input
          type="file"
          accept="video/*"
          onChange={handleFileUpload}
          disabled={isProcessing}
          className="block w-full text-sm text-slate-500
            file:mr-4 file:py-2 file:px-4
            file:rounded-full file:border-0
            file:text-sm file:font-semibold
            file:bg-violet-50 file:text-violet-700
            hover:file:bg-violet-100"
        />

        {isProcessing && (
          <div className="text-center">
            <p>Processing video... {progress}%</p>
          </div>
        )}

        {currentVideo && (
          <div className="space-y-2">
            <div className="overflow-hidden rounded-lg border mb-12 relative z-0">
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
              
              <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2 bg-black/50 rounded-full p-2 z-20">
                <Button
                  onClick={togglePlay}
                  variant="ghost"
                  className="text-white hover:bg-white/20"
                >
                  {isPlaying ? (
                    <Pause className="w-6 h-6" />
                  ) : (
                    <Play className="w-6 h-6" />
                  )}
                </Button>
                <div className="text-white px-2 flex items-center">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </div>
              </div>
            </div>
            
            <div className="flex gap-2 mb-4">
              <Button 
                onClick={handleAddZoom}
                disabled={isProcessing}
              >
                Add Zoom at Playhead
              </Button>
            </div>

            {isAddingZoom && (
              <div className="space-y-2 p-4 border rounded">
                <div>
                  <label className="block text-sm font-medium">
                    Zoom Duration (seconds)
                  </label>
                  <input
                    type="range"
                    min="0.1"
                    max="5"
                    step="0.1"
                    value={zoomDuration}
                    onChange={(e) => {
                      setZoomDuration(Number(e.target.value));
                      handleZoomChange(Number(e.target.value), zoomFactor);
                    }}
                    className="mt-1 block w-full"
                  />
                  <span className="text-sm text-gray-500">{zoomDuration}s</span>
                </div>
                <div>
                  <label className="block text-sm font-medium">
                    Zoom Factor
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="3"
                    step="0.1"
                    value={zoomFactor}
                    onChange={(e) => {
                      setZoomFactor(Number(e.target.value));
                      handleZoomChange(zoomDuration, Number(e.target.value));
                    }}
                    className="mt-1 block w-full"
                  />
                  <span className="text-sm text-gray-500">{Math.round((zoomFactor - 1) * 100)}% zoom</span>
                </div>
                <div className="flex gap-2">
                  <Button 
                    onClick={() => {
                      setIsAddingZoom(false);
                      setEditingZoomId(null);
                    }}
                    variant="outline"
                  >
                    Done
                  </Button>
                </div>
              </div>
            )}

            <div className="relative mt-12 z-10">
              <TimelineMarkers duration={duration} />

              <div
                ref={timelineRef}
                className="h-8 bg-gray-200 rounded cursor-pointer relative mt-12"
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
                {segment?.zoomEffects.map((effect, index) => (
                  <div
                    key={index}
                    onClick={() => startEditingZoom(index)}
                    className={`absolute h-full cursor-pointer group ${
                      editingZoomId === index ? 'bg-yellow-200/50' : 'bg-yellow-100/50'
                    } hover:bg-yellow-200/50 transition-colors border-l-2 border-r-2 border-yellow-400 z-10`}
                    style={{
                      left: `${(effect.time / duration) * 100}%`,
                      width: `${(effect.duration / duration) * 100}%`,
                    }}
                  >
                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs whitespace-nowrap bg-yellow-100 px-1 rounded">
                      {Math.round((effect.zoomFactor - 1) * 100)}% zoom
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
                        flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-20"
                    >
                      ×
                    </button>
                  </div>
                ))}

                {segment && (
                  <div className="absolute top-0 bottom-0 w-full bg-violet-100">
                    <div
                      className="absolute top-0 bottom-0 bg-black/20"
                      style={{
                        left: 0,
                        width: `${(segment.trimStart / duration) * 100}%`,
                      }}
                    />
                    <div
                      className="absolute top-0 bottom-0 bg-black/20"
                      style={{
                        right: 0,
                        width: `${((duration - segment.trimEnd) / duration) * 100}%`,
                      }}
                    />

                    <div
                      className="absolute top-0 bottom-0 w-1 bg-violet-600 cursor-ew-resize hover:w-2 transition-all z-30"
                      style={{
                        left: `${(segment.trimStart / duration) * 100}%`,
                        transform: 'translateX(-50%)',
                      }}
                      onMouseDown={() => setIsDraggingTrimStart(true)}
                    />
                    <div
                      className="absolute top-0 bottom-0 w-1 bg-violet-600 cursor-ew-resize hover:w-2 transition-all z-30"
                      style={{
                        left: `${(segment.trimEnd / duration) * 100}%`,
                        transform: 'translateX(-50%)',
                      }}
                      onMouseDown={() => setIsDraggingTrimEnd(true)}
                    />
                  </div>
                )}

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
        )}
        {currentVideo && segment && segment.zoomEffects && segment.zoomEffects.length > 0 && (
          <Button
            onClick={processWithZoomEffects}
            disabled={isProcessing}
          >
            Export Video with Effects
          </Button>
        )}
      </div>
    </div>
  );
}

// Helper function to format time in MM:SS format
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

const TimelineMarkers = ({ duration }: { duration: number }) => (
  <div className="absolute w-full flex justify-between text-xs text-gray-500 mb-4 pb-2" style={{ top: '-64px' }}>
    {Array.from({ length: 11 }).map((_, i) => {
      const time = (duration * i) / 10;
      return (
        <div key={i} className="flex flex-col items-center">
          <div className="h-2 w-0.5 bg-gray-300 mb-1" />
          {formatTime(time)}
        </div>
      );
    })}
  </div>
);
