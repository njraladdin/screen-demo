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
  editingTextId: string | null;
  setCurrentTime: (time: number) => void;
  setEditingTextId: (id: string | null) => void;
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

const TextTrack: React.FC<{
  segment: VideoSegment;
  duration: number;
  editingTextId: string | null;
  isDraggingTextStart: boolean;
  isDraggingTextEnd: boolean;
  onTextClick: (id: string) => void;
  onHandleDragStart: (id: string, type: 'start' | 'end') => void;
}> = ({ segment, duration, editingTextId, isDraggingTextStart, isDraggingTextEnd, onTextClick, onHandleDragStart }) => (
  <div className="absolute inset-x-0 bottom-14 h-8 bg-[#272729] rounded-lg">
    {segment.textSegments?.map((text) => (
      <div
        key={text.id}
        onClick={() => {
          // Prevent click when dragging
          if (!isDraggingTextStart && !isDraggingTextEnd) {
            onTextClick(text.id);
          }
        }}
        className={`absolute h-full cursor-pointer group ${
          editingTextId === text.id ? 'bg-[#0079d3]/30' : 'bg-[#0079d3]/20 hover:bg-[#0079d3]/25'
        }`}
        style={{
          left: `${(text.startTime / duration) * 100}%`,
          width: `${((text.endTime - text.startTime) / duration) * 100}%`
        }}
      >
        <div className="absolute inset-y-0 flex items-center justify-center w-full">
          <div className="px-2 truncate text-xs font-medium text-[#d7dadc]">
            {text.text}
          </div>
        </div>
        {/* Drag handles */}
        <div
          className="absolute inset-y-0 left-0 w-1 cursor-ew-resize group-hover:bg-[#0079d3]"
          onMouseDown={(e) => {
            e.stopPropagation();
            onHandleDragStart(text.id, 'start');
          }}
        />
        <div
          className="absolute inset-y-0 right-0 w-1 cursor-ew-resize group-hover:bg-[#0079d3]"
          onMouseDown={(e) => {
            e.stopPropagation();
            onHandleDragStart(text.id, 'end');
          }}
        />
      </div>
    ))}
  </div>
);

export const Timeline: React.FC<TimelineProps> = ({
  duration,
  currentTime,
  segment,
  thumbnails,
  timelineRef,
  videoRef,
  editingTextId,
  setCurrentTime,
  setEditingTextId,
  setSegment
}) => {
  const [isDraggingTrimStart, setIsDraggingTrimStart] = useState(false);
  const [isDraggingTrimEnd, setIsDraggingTrimEnd] = useState(false);
  const [isDraggingTextStart, setIsDraggingTextStart] = useState(false);
  const [isDraggingTextEnd, setIsDraggingTextEnd] = useState(false);
  const [draggingTextId, setDraggingTextId] = useState<string | null>(null);

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

  const handleTextDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingTextStart && !isDraggingTextEnd || !draggingTextId || !segment) return;

    const timeline = timelineRef.current;
    if (!timeline) return;

    const rect = timeline.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const newTime = (x / rect.width) * duration;

    setSegment({
      ...segment,
      textSegments: segment.textSegments.map(text => {
        if (text.id !== draggingTextId) return text;

        if (isDraggingTextStart) {
          return {
            ...text,
            startTime: Math.min(Math.max(0, newTime), text.endTime - 0.1)
          };
        } else {
          return {
            ...text,
            endTime: Math.max(Math.min(duration, newTime), text.startTime + 0.1)
          };
        }
      })
    });
  };

  return (
    <div className="relative h-48">
      <TimeMarkers duration={duration} />
      <div 
        ref={timelineRef}
        className="h-32 bg-[#1a1a1b] rounded-lg cursor-pointer relative mt-12"
        onClick={handleTimelineClick}
        onMouseMove={(e) => {
          handleTrimDrag(e);
          handleTextDrag(e);
        }}
        onMouseUp={() => {
          handleTrimDragEnd();
          setIsDraggingTextStart(false);
          setIsDraggingTextEnd(false);
          setDraggingTextId(null);
        }}
        onMouseLeave={() => {
          handleTrimDragEnd();
          setIsDraggingTextStart(false);
          setIsDraggingTextEnd(false);
          setDraggingTextId(null);
        }}
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


              {/* Trim handles */}
              <TrimHandles 
                segment={segment}
                duration={duration}
                onTrimDragStart={handleTrimDragStart}
              />
            </div>

            {/* Text track */}
            <TextTrack
              segment={segment}
              duration={duration}
              editingTextId={editingTextId}
              isDraggingTextStart={isDraggingTextStart}
              isDraggingTextEnd={isDraggingTextEnd}
              onTextClick={(id) => {
                setEditingTextId(id);
              }}
              onHandleDragStart={(id, type) => {
                setDraggingTextId(id);
                if (type === 'start') setIsDraggingTextStart(true);
                else setIsDraggingTextEnd(true);
              }}
            />
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