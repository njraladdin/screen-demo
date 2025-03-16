import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, Video, Series, Sequence } from 'remotion';
import { MousePosition, VideoSegment } from '@/types/video';

interface VideoCompositionProps {
  videoUrl: string | null;
  backgroundConfig: {
    scale: number;
    borderRadius: number;
    backgroundType: string;
  };
  mousePositions?: MousePosition[];
  segment?: VideoSegment;
}

export const RemotionVideo: React.FC<VideoCompositionProps> = ({
  videoUrl,
  backgroundConfig,
  mousePositions = [],
  segment,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();

  const scale = backgroundConfig.scale / 100;
  const borderRadius = backgroundConfig.borderRadius;

  // Calculate current time in seconds from frames
  const currentTime = frame / fps;
  
  // Handle mouse cursor rendering
  const getCurrentMousePosition = () => {
    if (!mousePositions.length) return null;
    
    // Find the right mouse position based on the current time
    for (let i = mousePositions.length - 1; i >= 0; i--) {
      if (mousePositions[i].timestamp <= currentTime) {
        // If we have a next position, interpolate between them
        if (i < mousePositions.length - 1) {
          const current = mousePositions[i];
          const next = mousePositions[i + 1];
          const timeDiff = next.timestamp - current.timestamp;
          
          // Avoid division by zero
          if (timeDiff === 0) return current;
          
          const progress = (currentTime - current.timestamp) / timeDiff;
          
          // Linear interpolation of x and y
          return {
            x: current.x + (next.x - current.x) * progress,
            y: current.y + (next.y - current.y) * progress,
            timestamp: currentTime,
            isClicked: current.isClicked || next.isClicked,
            cursor_type: current.cursor_type || next.cursor_type
          };
        }
        return mousePositions[i];
      }
    }
    
    // If no position is found, return the first one
    return mousePositions[0];
  };
  
  // Memoize the mouse position to prevent recalculation on every frame
  const mousePosition = useMemo(() => getCurrentMousePosition(), [currentTime, mousePositions]);

  if (!videoUrl) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: '#1a1a1b',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            color: '#d7dadc',
            fontSize: '16px',
          }}
        >
          No video selected
        </div>
      </AbsoluteFill>
    );
  }

  // Handle segment trimming
  const shouldRender = (): boolean => {
    if (!segment) return true;
    return currentTime >= segment.trimStart && currentTime <= segment.trimEnd;
  };

  // Use a background color that matches the player background to reduce flash
  const containerStyle = {
    backgroundColor: '#000000',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    height: '100%',
  };

  // Video container style with optimizations
  const videoContainerStyle = {
    width: `${width * scale}px`,
    height: `${height * scale}px`,
    overflow: 'hidden',
    borderRadius: `${borderRadius}px`,
    boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.5)',
    position: 'relative' as const,
    // Optimizations for smoother rendering
    backfaceVisibility: 'hidden' as const,
    transform: 'translateZ(0)',
    willChange: 'transform',
  };

  return (
    <AbsoluteFill style={containerStyle}>
      <div style={videoContainerStyle}>
        {/* Use Sequence for better performance */}
        <Sequence from={0} durationInFrames={Number.MAX_SAFE_INTEGER}>
          {shouldRender() && (
            <Video
              src={videoUrl}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                // Adding rendering optimizations
                backfaceVisibility: 'hidden',
                transform: 'translateZ(0)',
              }}
              muted
              preload="auto"
            />
          )}
        </Sequence>
        
        {/* Render mouse cursor */}
        {mousePosition && shouldRender() && (
          <div
            style={{
              position: 'absolute',
              left: `${mousePosition.x * 100}%`,
              top: `${mousePosition.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: '20px',
              height: '20px',
              pointerEvents: 'none',
              // Add z-index to ensure cursor is above video
              zIndex: 10,
            }}
          >
            {/* Simple cursor representation */}
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path 
                d="M3.5,0.5 L16.5,11.5 L10.5,11.5 L13.5,19.5 L9.5,19.5 L6.5,11.5 L3.5,11.5 Z" 
                fill="white" 
                stroke="black" 
                strokeWidth="1"
                transform="rotate(0)" 
              />
            </svg>
            
            {/* Click indicator */}
            {mousePosition.isClicked && (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: '30px',
                  height: '30px',
                  borderRadius: '50%',
                  backgroundColor: 'rgba(255, 255, 255, 0.3)',
                  animation: 'click-ripple 0.5s ease-out',
                }}
              />
            )}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};