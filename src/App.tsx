import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg'
import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"

// Create FFmpeg instance outside the component
const ffmpeg = createFFmpeg({ log: true });

interface VideoSegment {
  id: string;
  startTime: number;
  endTime: number;
  trimStart: number;
  trimEnd: number;
}

export default function App() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<string | null>(null);
  const [isFFmpegReady, setIsFFmpegReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingTrimStart, setIsDraggingTrimStart] = useState(false);
  const [isDraggingTrimEnd, setIsDraggingTrimEnd] = useState(false);
  const [segments, setSegments] = useState<VideoSegment[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Add FFmpeg.js progress handler
  ffmpeg.setProgress(({ ratio }) => {
    setProgress(Math.round(ratio * 100));
  });

  // Update currentTime when video plays
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      console.log('Video ref is null');
      return;
    }

    console.log('Setting up video event listeners');
    console.log('Initial video duration:', video.duration);
    console.log('Initial video currentTime:', video.currentTime);

    const handleTimeUpdate = () => {
      console.log('Time update event:', video.currentTime);
      setCurrentTime(video.currentTime);
    };

    const handleLoadedMetadata = () => {
      console.log('Loaded metadata event. Duration:', video.duration);
      setDuration(video.duration);
    };

    const handleLoadedData = () => {
      console.log('Video loaded data. Duration:', video.duration);
      setDuration(video.duration);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('loadeddata', handleLoadedData);

    return () => {
      console.log('Cleaning up video event listeners');
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('loadeddata', handleLoadedData);
    };
  }, [currentVideo]);

  // Debug state changes
  useEffect(() => {
    console.log('Duration state changed:', duration);
  }, [duration]);

  useEffect(() => {
    console.log('Current time state changed:', currentTime);
  }, [currentTime]);

  // Initialize single segment when video loads
  useEffect(() => {
    if (duration > 0) {
      const initialSegment: VideoSegment = {
        id: 'initial',
        startTime: 0,
        endTime: duration,
        trimStart: 0,
        trimEnd: duration
      };
      setSegments([initialSegment]);
      setActiveSegmentId('initial');
    }
  }, [duration]);

  const handleSplit = () => {
    const splitTime = currentTime;
    
    setSegments(prevSegments => {
      const segmentToSplit = prevSegments.find(seg => 
        splitTime >= seg.startTime && splitTime <= seg.endTime
      );

      if (!segmentToSplit) return prevSegments;

      const newSegments: VideoSegment[] = prevSegments.filter(seg => seg.id !== segmentToSplit.id);
      
      const segment1: VideoSegment = {
        id: `${segmentToSplit.id}-1`,
        startTime: segmentToSplit.startTime,
        endTime: splitTime,
        trimStart: segmentToSplit.trimStart,
        trimEnd: splitTime
      };

      const segment2: VideoSegment = {
        id: `${segmentToSplit.id}-2`,
        startTime: splitTime,
        endTime: segmentToSplit.endTime,
        trimStart: splitTime,
        trimEnd: segmentToSplit.trimEnd
      };

      return [...newSegments, segment1, segment2].sort((a, b) => a.startTime - b.startTime);
    });
  };

  // Handle trim handle dragging
  const handleTrimDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDraggingTrimStart || isDraggingTrimEnd) {
      const timeline = timelineRef.current;
      if (!timeline) return;

      const rect = timeline.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const percent = x / rect.width;
      const newTime = percent * duration;

      setSegments(prevSegments => 
        prevSegments.map(segment => {
          if (segment.id === activeSegmentId) {
            if (isDraggingTrimStart) {
              const newTrimStart = Math.min(newTime, segment.trimEnd - 0.1);
              return {
                ...segment,
                trimStart: Math.max(segment.startTime, newTrimStart)
              };
            }
            if (isDraggingTrimEnd) {
              const newTrimEnd = Math.max(newTime, segment.trimStart + 0.1);
              return {
                ...segment,
                trimEnd: Math.min(segment.endTime, newTrimEnd)
              };
            }
          }
          return segment;
        })
      );

      if (videoRef.current) {
        videoRef.current.currentTime = newTime;
      }
    }
  };

  // Update video playback to respect segment trim bounds
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const activeSegment = segments.find(seg => seg.id === activeSegmentId);
    if (!activeSegment) return;

    const handleTimeUpdate = () => {
      if (video.currentTime >= activeSegment.trimEnd) {
        video.pause();
        video.currentTime = activeSegment.trimEnd;
      } else if (video.currentTime < activeSegment.trimStart) {
        video.currentTime = activeSegment.trimStart;
      }
    };

    // Check and adjust initial position if in trimmed area
    if (video.currentTime < activeSegment.trimStart || video.currentTime > activeSegment.trimEnd) {
      video.currentTime = activeSegment.trimStart;
    }

    video.addEventListener('timeupdate', handleTimeUpdate);
    return () => video.removeEventListener('timeupdate', handleTimeUpdate);
  }, [segments, activeSegmentId]);

  // Update timeline click to respect trim bounds
  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDraggingTrimStart || isDraggingTrimEnd) return;
    
    const timeline = timelineRef.current;
    const video = videoRef.current;
    if (!timeline || !video) return;

    const activeSegment = segments.find(seg => seg.id === activeSegmentId);
    if (!activeSegment) return;

    const rect = timeline.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = x / rect.width;
    const newTime = percent * duration;
    
    // Only allow clicking within active segment's trim bounds
    if (newTime >= activeSegment.trimStart && newTime <= activeSegment.trimEnd) {
      video.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  // Separate handler for timeline dragging
  const handleTimelineDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDragging && !isDraggingTrimStart && !isDraggingTrimEnd) {
      handleTimelineClick(e);
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
      
      // Initialize FFmpeg if not ready
      if (!isFFmpegReady) {
        await loadFFmpeg();
      }

      const inputFileName = 'input.mp4';
      const outputFileName = 'output.mp4';

      // Write the file to FFmpeg's virtual filesystem
      ffmpeg.FS('writeFile', inputFileName, await fetchFile(file));

      // Process the video using stream copy (no re-encoding)
      await ffmpeg.run(
        '-i', inputFileName,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputFileName
      );

      // Read the processed video
      const data = ffmpeg.FS('readFile', outputFileName);
      const videoBlob = new Blob([data.buffer], { type: 'video/mp4' });
      const videoUrl = URL.createObjectURL(videoBlob);
      setCurrentVideo(videoUrl);

      // Clean up
      ffmpeg.FS('unlink', inputFileName);
      ffmpeg.FS('unlink', outputFileName);

    } catch (error) {
      console.error('Error processing video:', error);
    } finally {
      setIsProcessing(false);
    }
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
            <div className="flex gap-2 mb-4">
              <Button 
                onClick={handleSplit}
                disabled={!currentVideo || isProcessing}
              >
                Split at Playhead
              </Button>
            </div>

            <video 
              ref={videoRef}
              src={currentVideo}
              controls 
              preload="metadata"
              className="w-full rounded-lg border mb-8"
              onLoadedMetadata={(e) => {
                console.log('onLoadedMetadata prop called. Duration:', e.currentTarget.duration);
                setDuration(e.currentTarget.duration);
              }}
            />
            
            {/* Timeline */}
            <div className="relative mt-8">
              <div
                ref={timelineRef}
                className="h-6 bg-gray-200 rounded cursor-pointer relative"
                onClick={handleTimelineClick}
                onMouseMove={handleTrimDrag}
                onMouseUp={() => {
                  setIsDragging(false);
                  setIsDraggingTrimStart(false);
                  setIsDraggingTrimEnd(false);
                }}
                onMouseLeave={() => {
                  setIsDragging(false);
                  setIsDraggingTrimStart(false);
                  setIsDraggingTrimEnd(false);
                }}
              >
                {/* Segments */}
                {segments.map(segment => (
                  <div
                    key={segment.id}
                    className={`absolute top-0 bottom-0 ${
                      segment.id === activeSegmentId ? 'bg-violet-100' : 'bg-gray-100'
                    }`}
                    style={{
                      left: `${(segment.startTime / duration) * 100}%`,
                      width: `${((segment.endTime - segment.startTime) / duration) * 100}%`,
                    }}
                    onClick={() => setActiveSegmentId(segment.id)}
                  >
                    {/* Trimmed areas for this segment */}
                    <div
                      className="absolute top-0 bottom-0 bg-black/20"
                      style={{
                        left: 0,
                        width: `${((segment.trimStart - segment.startTime) / (segment.endTime - segment.startTime)) * 100}%`,
                      }}
                    />
                    <div
                      className="absolute top-0 bottom-0 bg-black/20"
                      style={{
                        right: 0,
                        width: `${((segment.endTime - segment.trimEnd) / (segment.endTime - segment.startTime)) * 100}%`,
                      }}
                    />

                    {/* Trim handles for active segment */}
                    {segment.id === activeSegmentId && (
                      <>
                        <div
                          className="absolute top-0 bottom-0 w-1 bg-violet-600 cursor-ew-resize hover:w-2 transition-all z-30"
                          style={{
                            left: `${((segment.trimStart - segment.startTime) / (segment.endTime - segment.startTime)) * 100}%`,
                            transform: 'translateX(-50%)',
                          }}
                          onMouseDown={() => setIsDraggingTrimStart(true)}
                        />
                        <div
                          className="absolute top-0 bottom-0 w-1 bg-violet-600 cursor-ew-resize hover:w-2 transition-all z-30"
                          style={{
                            left: `${((segment.trimEnd - segment.startTime) / (segment.endTime - segment.startTime)) * 100}%`,
                            transform: 'translateX(-50%)',
                          }}
                          onMouseDown={() => setIsDraggingTrimEnd(true)}
                        />
                      </>
                    )}
                  </div>
                ))}

                {/* Playhead */}
                <div 
                  className="absolute top-[-8px] bottom-0 flex flex-col items-center pointer-events-none"
                  style={{ 
                    left: `${(currentTime / duration) * 100}%`,
                    transform: 'translateX(-50%)',
                    zIndex: 10,
                  }}
                >
                  <div className="w-4 h-2 bg-red-500 rounded-t" />
                  <div className="w-0.5 flex-1 bg-red-500" />
                </div>
              </div>
            </div>
          </div>
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
