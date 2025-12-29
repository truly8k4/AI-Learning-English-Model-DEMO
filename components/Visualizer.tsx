import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  analyser: AnalyserNode | null;
  isActive: boolean;
  color?: string;
}

export const Visualizer: React.FC<VisualizerProps> = ({ analyser, isActive, color = '#6366f1' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser || !isActive) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);

      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw a circular visualizer
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const radius = Math.min(centerX, centerY) - 10;

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius - 5, 0, 2 * Math.PI);
      ctx.strokeStyle = `${color}20`; // very faint ring
      ctx.stroke();

      const bars = 60;
      const step = (Math.PI * 2) / bars;

      for (let i = 0; i < bars; i++) {
        // Average a chunk of frequencies for this bar
        const freqIndex = Math.floor((i / bars) * (bufferLength / 2)); 
        const value = dataArray[freqIndex];
        const barHeight = (value / 255) * 50; 

        const angle = i * step;
        const x1 = centerX + Math.cos(angle) * (radius - 20);
        const y1 = centerY + Math.sin(angle) * (radius - 20);
        const x2 = centerX + Math.cos(angle) * (radius - 20 + barHeight);
        const y2 = centerY + Math.sin(angle) * (radius - 20 + barHeight);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    };

    draw();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [analyser, isActive, color]);

  return (
    <canvas
      ref={canvasRef}
      width={300}
      height={300}
      className={`transition-opacity duration-500 ${isActive ? 'opacity-100' : 'opacity-20'}`}
    />
  );
};