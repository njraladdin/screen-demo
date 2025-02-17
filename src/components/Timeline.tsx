import React, { useState } from 'react';
import { VideoSegment, ZoomKeyframe } from '@/types/video';

// Helper function to format time
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Helper function to calculate keyframe range
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

interface TimelineProps {
  duration: number;
  currentTime: number;
  segment: VideoSegment | null;
  thumbnails: string[];
  timelineRef: React.RefObject<HTMLDivElement>;
  videoRef: React.RefObject<HTMLVideoElement>;
  editingKeyframeId: number | null;
  setCurrentTime: (time: number) => void;
  setEditingKeyframeId: (id: number | null) => void;
  setActivePanel: (panel: 'zoom' | 'background' | 'cursor') => void;
  setSegment: (segment: VideoSegment | null) => void;
}

const TimeMarkers: React.FC<{ duration: number }> = ({ duration }) => (
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
);

const VideoTrack: React.FC<{ segment: VideoSegment; duration: number; thumbnails: string[] }> = ({
  segment,
  duration,
  thumbnails
}) => (
  <div className="absolute inset-0">
    {/* Background track */}
    <div className="absolute inset-0 bg-[#272729] rounded-lg overflow-hidden">
      {/* Thumbnails */}
      <div className="absolute inset-0 flex gap-[2px]">
        {thumbnails.map((thumbnail, index) => (
          <div 
            key={index}
            className="h-full flex-shrink-0"
            style={{ 
              width: `calc(${100 / thumbnails.length}% - 2px)`,
              backgroundImage: `url(${thumbnail})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              opacity: 0.5
            }}
          />
        ))}
      </div>
    </div>

    {/* Trimmed sections */}
    <div 
      className="absolute inset-y-0 left-0 bg-black/50 rounded-l-lg" 
      style={{ width: `${(segment.trimStart / duration) * 100}%` }} 
    />
    <div 
      className="absolute inset-y-0 right-0 bg-black/50 rounded-r-lg" 
      style={{ width: `${((duration - segment.trimEnd) / duration) * 100}%` }} 
    />

    {/* Active section */}
    <div 
      className="absolute inset-y-0 bg-white/2 border border-white/20"
      style={{
        left: `${(segment.trimStart / duration) * 100}%`,
        right: `${((duration - segment.trimEnd) / duration) * 100}%`
      }}
    />
  </div>
);

const ZoomKeyframes: React.FC<{ 
  segment: VideoSegment; 
  duration: number;
  editingKeyframeId: number | null;
  onKeyframeClick: (time: number, index: number) => void;
}> = ({ segment, duration, editingKeyframeId, onKeyframeClick }) => (
  <div className="absolute inset-x-0 h-full">
    {segment.zoomKeyframes.map((keyframe, index) => {
      const active = editingKeyframeId === index;
      const { rangeStart, rangeEnd } = getKeyframeRange(segment.zoomKeyframes, index);

      return (
        <div key={index}>
          {/* Gradient background for zoom range */}
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
          {/* Keyframe marker with label */}
          <div
            className="absolute cursor-pointer group"
            style={{
              left: `${(keyframe.time / duration) * 100}%`,
              transform: "translateX(-50%)",
              top: "-40px",
              height: "64px"
            }}
            onClick={(e) => {
              e.stopPropagation();
              onKeyframeClick(keyframe.time, index);
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
  </div>
);

const TrimHandles: React.FC<{ 
  segment: VideoSegment; 
  duration: number;
  onTrimDragStart: (type: 'start' | 'end') => void;
}> = ({ segment, duration, onTrimDragStart }) => (
  <>
    <div 
      className="absolute -top-2 -bottom-2 w-4 cursor-col-resize z-30 group"
      style={{ left: `calc(${(segment.trimStart / duration) * 100}% - 8px)` }}
      onMouseDown={() => onTrimDragStart('start')}
    >
      <div className="absolute inset-y-0 w-2 bg-white/80 group-hover:bg-[#0079d3] group-hover:w-2.5 transition-all rounded-full left-1/2 transform -translate-x-1/2" />
      <div className="absolute inset-y-2 left-1/2 transform -translate-x-1/2 flex flex-col justify-center gap-1">
        <div className="w-0.5 h-1 bg-black/40 rounded-full" />
        <div className="w-0.5 h-1 bg-black/40 rounded-full" />
      </div>
    </div>

    <div 
      className="absolute -top-2 -bottom-2 w-4 cursor-col-resize z-30 group"
      style={{ left: `calc(${(segment.trimEnd / duration) * 100}% - 8px)` }}
      onMouseDown={() => onTrimDragStart('end')}
    >
      <div className="absolute inset-y-0 w-2 bg-white/80 group-hover:bg-[#0079d3] group-hover:w-2.5 transition-all rounded-full left-1/2 transform -translate-x-1/2" />
      <div className="absolute inset-y-2 left-1/2 transform -translate-x-1/2 flex flex-col justify-center gap-1">
        <div className="w-0.5 h-1 bg-black/40 rounded-full" />
        <div className="w-0.5 h-1 bg-black/40 rounded-full" />
      </div>
    </div>
  </>
);

const Playhead: React.FC<{ currentTime: number; duration: number }> = ({ currentTime, duration }) => (
  <div 
    className="absolute top-0 bottom-0 flex flex-col items-center pointer-events-none z-30" 
    style={{
      left: `${(currentTime / duration) * 100}%`, 
      transform: 'translateX(-50%)'
    }}
  >
    <div className="w-4 h-3 bg-red-500 rounded-t" />
    <div className="w-0.5 flex-1 bg-red-500" />
  </div>
);

export const Timeline: React.FC<TimelineProps> = ({
  duration,
  currentTime,
  segment,
  thumbnails,
  timelineRef,
  videoRef,
  editingKeyframeId,
  setCurrentTime,
  setEditingKeyframeId,
  setActivePanel,
  setSegment
}) => {
  const [isDraggingTrimStart, setIsDraggingTrimStart] = useState(false);
  const [isDraggingTrimEnd, setIsDraggingTrimEnd] = useState(false);

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDraggingTrimStart || isDraggingTrimEnd) return;

    const timeline = timelineRef.current;
    const video = videoRef.current;
    if (!timeline || !video || !segment) return;

    const rect = timeline.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percent = x / rect.width;
    const newTime = percent * duration;

    // Only allow seeking within trimmed bounds
    if (newTime >= segment.trimStart && newTime <= segment.trimEnd) {
      video.currentTime = newTime;
      requestAnimationFrame(() => {
        setCurrentTime(newTime);
      });
    }
  };

  const handleTrimDragStart = (type: 'start' | 'end') => {
    if (type === 'start') setIsDraggingTrimStart(true);
    else setIsDraggingTrimEnd(true);
  };

  const handleTrimDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingTrimStart && !isDraggingTrimEnd) return;

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
      if (videoRef.current) {
        videoRef.current.currentTime = newTime;
      }
    }

    if (isDraggingTrimEnd) {
      const newTrimEnd = Math.max(newTime, segment.trimStart + 0.1);
      setSegment({
        ...segment,
        trimEnd: Math.min(duration, newTrimEnd)
      });
      if (videoRef.current) {
        videoRef.current.currentTime = newTime;
      }
    }
  };

  const handleTrimDragEnd = () => {
    setIsDraggingTrimStart(false);
    setIsDraggingTrimEnd(false);
  };

  return (
    <div className="relative h-48">
      <TimeMarkers duration={duration} />
      <div 
        ref={timelineRef}
        className="h-32 bg-[#1a1a1b] rounded-lg cursor-pointer relative mt-12"
        onClick={handleTimelineClick}
        onMouseMove={handleTrimDrag}
        onMouseUp={handleTrimDragEnd}
        onMouseLeave={handleTrimDragEnd}
      >
        {segment && (
          <>
            {/* Base track with thumbnails */}
            <div className="absolute inset-x-0 bottom-0 h-12">
              <VideoTrack 
                segment={segment} 
                duration={duration} 
                thumbnails={thumbnails} 
              />

              {/* Zoom keyframes layer */}
              <div className="absolute inset-0">
                <ZoomKeyframes 
                  segment={segment}
                  duration={duration}
                  editingKeyframeId={editingKeyframeId}
                  onKeyframeClick={(time, index) => {
                    if (videoRef.current) {
                      videoRef.current.currentTime = time;
                      setCurrentTime(time);
                      setEditingKeyframeId(index);
                      setActivePanel("zoom");
                    }
                  }}
                />
              </div>

              {/* Trim handles */}
              <TrimHandles 
                segment={segment}
                duration={duration}
                onTrimDragStart={handleTrimDragStart}
              />
            </div>
          </>
        )}

        {/* Playhead */}
        <Playhead 
          currentTime={currentTime} 
          duration={duration} 
        />
      </div>
      
      {/* Duration display */}
      <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 text-sm text-[#818384]">
        {segment ? formatTime(segment.trimEnd - segment.trimStart) : formatTime(duration)}
      </div>
    </div>
  );
}; 