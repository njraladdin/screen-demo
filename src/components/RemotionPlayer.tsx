import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Player, PlayerRef } from '@remotion/player';
import { RemotionVideo } from './RemotionVideo';
import { MousePosition, VideoSegment } from '@/types/video';

interface RemotionPlayerProps {
  videoUrl: string | null;
  backgroundConfig: {
    scale: number;
    borderRadius: number;
    backgroundType: string;
  };
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  setCurrentTime: (time: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  mousePositions?: MousePosition[];
  segment?: VideoSegment;
}

export const RemotionPlayer: React.FC<RemotionPlayerProps> = ({
  videoUrl,
  backgroundConfig,
  isPlaying,
  currentTime,
  duration,
  setCurrentTime,
  setIsPlaying,
  mousePositions = [],
  segment,
}) => {
  // Ref for the player
  const playerRef = useRef<PlayerRef>(null);
  // Track last observed playing state so we can detect changes
  const [lastPlayingState, setLastPlayingState] = useState(isPlaying);
  // Add this to prevent rapid play/pause changes
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Remotion composition configuration
  const fps = 30;
  const durationInFrames = Math.ceil(duration * fps) || 1;
  const compositionWidth = 1920;
  const compositionHeight = 1080;

  // Convert seconds to frames
  const currentFrame = Math.floor(currentTime * fps);

  // Create a memoized component for RemotionVideo to prevent unnecessary re-renders
  const VideoComponent = useMemo(() => {
    return () => (
      <RemotionVideo
        videoUrl={videoUrl}
        backgroundConfig={backgroundConfig}
        mousePositions={mousePositions}
        segment={segment}
      />
    );
  }, [videoUrl, backgroundConfig, mousePositions, segment]);

  // Handle play/pause with debouncing to prevent rapid changes
  const handlePlayPauseChange = useCallback(async (shouldPlay: boolean) => {
    if (!playerRef.current || isTransitioning) return;
    
    setIsTransitioning(true);
    
    try {
      if (shouldPlay) {
        await playerRef.current.play();
      } else {
        await playerRef.current.pause();
      }
      
      setLastPlayingState(shouldPlay);
    } catch (error) {
      console.error('Error changing play state:', error);
    } finally {
      // Short delay before allowing another transition
      setTimeout(() => {
        setIsTransitioning(false);
      }, 150);
    }
  }, [isTransitioning]);

  // Sync with external isPlaying state
  useEffect(() => {
    if (isPlaying !== lastPlayingState && !isTransitioning) {
      handlePlayPauseChange(isPlaying);
    }
  }, [isPlaying, lastPlayingState, handlePlayPauseChange, isTransitioning]);

  // Sync with external currentTime state
  useEffect(() => {
    if (!playerRef.current) return;
    
    // Only seek if the difference is significant and we're not playing
    // This prevents seeking during playback which can cause flashing
    const currentPlayerFrame = playerRef.current.getCurrentFrame();
    if (Math.abs(currentPlayerFrame - currentFrame) > 2 && !isPlaying) {
      playerRef.current.seekTo(currentFrame);
    }
  }, [currentFrame, isPlaying]);

  // Update time based on player frame
  useEffect(() => {
    if (!playerRef.current) return;
    
    // Just check the current frame periodically
    const interval = setInterval(() => {
      if (!playerRef.current) return;
      
      // 1. Update time
      const frame = playerRef.current.getCurrentFrame();
      const timeInSeconds = frame / fps;
      if (Math.abs(timeInSeconds - currentTime) > 0.1) {
        setCurrentTime(timeInSeconds);
      }
      
      // 2. Detect if player has changed play state
      if (!isTransitioning) {
        try {
          const playing = playerRef.current.isPlaying();
          if (playing !== isPlaying) {
            setIsPlaying(playing);
            setLastPlayingState(playing);
          }
        } catch (e) {
          // Ignore errors
        }
      }
    }, 250);
    
    return () => clearInterval(interval);
  }, [fps, currentTime, setCurrentTime, isPlaying, setIsPlaying, lastPlayingState, isTransitioning]);

  // Player style with optimizations to prevent flickering
  const playerStyle = {
    width: '100%',
    height: '100%',
    willChange: 'transform', // This helps maintain the current frame during transitions
  };

  return (
    <div className="w-full h-full">
      <Player
        ref={playerRef}
        component={VideoComponent}
        durationInFrames={durationInFrames}
        compositionWidth={compositionWidth}
        compositionHeight={compositionHeight}
        fps={fps}
        style={playerStyle}
        controls
        loop
        initialFrame={currentFrame}
        allowFullscreen={false}
        autoPlay={isPlaying}
        spaceKeyToPlayOrPause
        doubleClickToFullscreen={false}
        // Add these props to improve performance
        renderLoading={() => (
          <div className="w-full h-full bg-black flex items-center justify-center text-white">
            Loading...
          </div>
        )}
        showVolumeControls={false}
        clickToPlay={false}
        inputProps={{ preservesPitch: true }}
        playbackRate={1}
      />
    </div>
  );
};