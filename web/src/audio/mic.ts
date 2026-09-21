// Microphone via AudioWorklet. AGC is off on purpose: shouting must stay
// louder than talking, or the startle meter has nothing to measure.

export interface Mic {
  sampleRate: number;
  frameMs: number;
  stop(): void;
}

export async function openMic(onFrame: (frame: Float32Array) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/worklets/capture.js");
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "capture");
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
  src.connect(node);
  // keep the graph alive without hearing ourselves
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  await ctx.resume();
  return {
    sampleRate: ctx.sampleRate,
    frameMs: (1024 / ctx.sampleRate) * 1000,
    stop() {
      node.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
