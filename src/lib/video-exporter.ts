interface ExportOptions {
  video: HTMLVideoElement;
  segment: {
    trimStart: number;
    trimEnd: number;
    zoomEffects: Array<{
      time: number;
      duration: number;
      zoomFactor: number;
      positionX: number;
      positionY: number;
    }>;
  };
  onProgress: (progress: number) => void;
  findPreviousZoom: (effects: any[], currentTime: number) => any;
  calculateZoomTransition: (time: number, activeZoom: any, previousZoom: any) => any;
}

export async function exportVideo({
  video,
  segment,
  onProgress,
  findPreviousZoom,
  calculateZoomTransition
}: ExportOptions): Promise<void> {
  // Create a high-resolution canvas for the output
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = video.videoWidth;
  outputCanvas.height = video.videoHeight;
  
  const ctx = outputCanvas.getContext('2d', {
    alpha: false,
    desynchronized: true,
    willReadFrequently: false,
    colorSpace: 'display-p3',
    powerPreference: 'high-performance'
  } as any) as CanvasRenderingContext2D;
  
  // Enable image smoothing for better quality
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  
  // Create MediaRecorder with maximum quality settings
  const stream = outputCanvas.captureStream(60);

  // Try to use VP9 codec first (better quality), fall back to VP8
  const mimeTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus'
  ];
  
  const supportedMimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
  if (!supportedMimeType) {
    throw new Error('No supported video codec found');
  }

  // Create and configure MediaRecorder
  const mediaRecorder = new MediaRecorder(stream, {
    mimeType: supportedMimeType,
    videoBitsPerSecond: 20000000,
    audioBitsPerSecond: 256000
  });

  const chunks: Blob[] = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  // Create a promise that resolves when recording is complete
  const exportComplete = new Promise<void>((resolve) => {
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: supportedMimeType });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      const codec = supportedMimeType.includes('vp9') ? 'vp9' : 'vp8';
      a.download = `processed_video_${codec}_60fps.webm`;
      a.click();
      URL.revokeObjectURL(url);

      stream.getTracks().forEach(track => track.stop());
      resolve();
    };
  });

  mediaRecorder.start(20);

  const frameRate = 60;
  const frameDuration = 1 / frameRate;
  const totalFrames = Math.ceil((segment.trimEnd - segment.trimStart) * frameRate);
  let processedFrames = 0;

  const processFrame = async (time: number) => {
    video.currentTime = time;
    await new Promise<void>(resolve => {
      video.onseeked = () => resolve();
    });

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
    
    const activeZoom = segment.zoomEffects
      .filter(effect => time >= effect.time)
      .pop();

    if (activeZoom) {
      const previousZoom = findPreviousZoom(segment.zoomEffects, activeZoom.time);
      const { currentZoom, currentPosX, currentPosY } = calculateZoomTransition(
        time,
        activeZoom,
        previousZoom
      );

      ctx.save();
      (ctx as any).filter = 'url(#interpolate)';
      
      const scaledWidth = outputCanvas.width * currentZoom;
      const scaledHeight = outputCanvas.height * currentZoom;
      const offsetX = (outputCanvas.width - scaledWidth) * currentPosX;
      const offsetY = (outputCanvas.height - scaledHeight) * currentPosY;
      
      ctx.translate(offsetX, offsetY);
      ctx.scale(currentZoom, currentZoom);
      ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
      ctx.restore();
    } else {
      ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
    }

    processedFrames++;
    onProgress((processedFrames / totalFrames) * 100);
  };

  // Process all frames
  for (let time = segment.trimStart; time <= segment.trimEnd; time += frameDuration) {
    await processFrame(time);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  await new Promise(resolve => setTimeout(resolve, 100));
  mediaRecorder.stop();

  return exportComplete;
} 