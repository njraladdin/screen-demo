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
  backgroundConfig: {
    scale: number;
    borderRadius: number;
    backgroundType: 'solid' | 'gradient1' | 'gradient2' | 'gradient3';
  };
}

export async function exportVideo({
  video,
  segment,
  onProgress,
  findPreviousZoom,
  calculateZoomTransition,
  backgroundConfig
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

  // Helper function to generate background gradient
  const getBackgroundStyle = (ctx: CanvasRenderingContext2D, type: string) => {
    switch (type) {
      case 'gradient1':
        const gradient1 = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient1.addColorStop(0, '#2563eb');
        gradient1.addColorStop(1, '#7c3aed');
        return gradient1;
      case 'gradient2':
        const gradient2 = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient2.addColorStop(0, '#fb7185');
        gradient2.addColorStop(1, '#fdba74');
        return gradient2;
      case 'gradient3':
        const gradient3 = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
        gradient3.addColorStop(0, '#10b981');
        gradient3.addColorStop(1, '#2dd4bf');
        return gradient3;
      default:
        return '#000000';
    }
  };

  const processFrame = async (time: number) => {
    video.currentTime = time;
    await new Promise<void>(resolve => {
      video.onseeked = () => resolve();
    });

    // Draw background
    ctx.fillStyle = getBackgroundStyle(ctx, backgroundConfig.backgroundType);
    ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);

    // Calculate scaled dimensions
    const scale = backgroundConfig.scale / 100;
    const scaledWidth = outputCanvas.width * scale;
    const scaledHeight = outputCanvas.height * scale;
    const x = (outputCanvas.width - scaledWidth) / 2;
    const y = (outputCanvas.height - scaledHeight) / 2;

    // Create temporary canvas for rounded corners
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = outputCanvas.width;
    tempCanvas.height = outputCanvas.height;
    const tempCtx = tempCanvas.getContext('2d')!;

    // Draw rounded rectangle path
    const radius = backgroundConfig.borderRadius;
    tempCtx.beginPath();
    tempCtx.moveTo(x + radius, y);
    tempCtx.lineTo(x + scaledWidth - radius, y);
    tempCtx.quadraticCurveTo(x + scaledWidth, y, x + scaledWidth, y + radius);
    tempCtx.lineTo(x + scaledWidth, y + scaledHeight - radius);
    tempCtx.quadraticCurveTo(x + scaledWidth, y + scaledHeight, x + scaledWidth - radius, y + scaledHeight);
    tempCtx.lineTo(x + radius, y + scaledHeight);
    tempCtx.quadraticCurveTo(x, y + scaledHeight, x, y + scaledHeight - radius);
    tempCtx.lineTo(x, y + radius);
    tempCtx.quadraticCurveTo(x, y, x + radius, y);
    tempCtx.closePath();

    // Apply clipping and draw video frame
    tempCtx.save();
    tempCtx.clip();
    
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

      tempCtx.save();
      const zoomedWidth = scaledWidth * currentZoom;
      const zoomedHeight = scaledHeight * currentZoom;
      const zoomOffsetX = (scaledWidth - zoomedWidth) * currentPosX;
      const zoomOffsetY = (scaledHeight - zoomedHeight) * currentPosY;
      
      tempCtx.translate(x + zoomOffsetX, y + zoomOffsetY);
      tempCtx.scale(currentZoom * scale, currentZoom * scale);
      tempCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
      tempCtx.restore();
    } else {
      tempCtx.drawImage(video, x, y, scaledWidth, scaledHeight);
    }

    tempCtx.restore();

    // Draw the temporary canvas onto the main canvas
    ctx.drawImage(tempCanvas, 0, 0);

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