export interface LuminanceTrackerState {
  lastLuminance: number;
  isPeak: boolean;
  peakTimestamps: number[];
  refractoryPeriodMs: number;
  lastPeakTime: number;
  lumaHistory: number[];
}

export function initTrackerState(refractoryPeriodMs = 60): LuminanceTrackerState {
  return {
    lastLuminance: 0,
    isPeak: false,
    peakTimestamps: [],
    refractoryPeriodMs,
    lastPeakTime: 0,
    lumaHistory: [],
  };
}

export function sampleRoiLuma(
  ctx: CanvasRenderingContext2D,
  roi: { x: number; y: number },
  boxSize = 16
): number {
  const half = Math.floor(boxSize / 2);
  const startX = Math.max(0, roi.x - half);
  const startY = Math.max(0, roi.y - half);

  try {
    const frameData = ctx.getImageData(startX, startY, boxSize, boxSize);
    const data = frameData.data;
    let totalLuma = 0;

    for (let i = 0; i < data.length; i += 4) {
      totalLuma += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }

    return totalLuma / (data.length / 4);
  } catch {
    return 0;
  }
}

export interface PulseEvaluationOptions {
  riseThreshold?: number;
  fallThreshold?: number;
  refractoryPeriodMs?: number;
  bladeCount?: number;
  isMultiBladeSymmetrical?: boolean;
}

export function evaluatePulse(
  currentLuma: number,
  tracker: LuminanceTrackerState,
  now: number,
  options: PulseEvaluationOptions = {}
): { isDetected: boolean; instantRpm: number | null; delta: number } {
  const riseThreshold = options.riseThreshold ?? 16.0;
  const fallThreshold = options.fallThreshold ?? -10.0;
  const refractory = options.refractoryPeriodMs ?? tracker.refractoryPeriodMs;
  const bladeCount = options.bladeCount && options.bladeCount > 0 ? options.bladeCount : 1;
  const isMultiBlade = options.isMultiBladeSymmetrical ?? false;

  const delta = currentLuma - tracker.lastLuminance;
  let isDetected = false;
  let instantRpm: number | null = null;

  // Track recent luma history for the live oscilloscope UI (up to 60 samples)
  tracker.lumaHistory.push(currentLuma);
  if (tracker.lumaHistory.length > 60) {
    tracker.lumaHistory.shift();
  }

  const timeSinceLastPeak = now - tracker.lastPeakTime;

  if (delta > riseThreshold && !tracker.isPeak && timeSinceLastPeak > refractory) {
    tracker.isPeak = true;
    tracker.lastPeakTime = now;
    tracker.peakTimestamps.push(now);
    isDetected = true;

    // Keep the last 10 peak timestamps for moving average interval
    if (tracker.peakTimestamps.length > 10) {
      tracker.peakTimestamps.shift();
    }

    if (tracker.peakTimestamps.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < tracker.peakTimestamps.length; i++) {
        intervals.push(tracker.peakTimestamps[i] - tracker.peakTimestamps[i - 1]);
      }
      const avgInterval = intervals.reduce((acc, val) => acc + val, 0) / intervals.length;

      if (avgInterval > 0) {
        // If multi-blade symmetrical, each physical revolution has `bladeCount` pulses
        const effectiveMultiplier = isMultiBlade ? bladeCount : 1;
        const calculatedRpm = (60000 / (avgInterval * effectiveMultiplier));
        instantRpm = Math.round(calculatedRpm);
      }
    }
  } else if (delta < fallThreshold) {
    tracker.isPeak = false;
  }

  tracker.lastLuminance = currentLuma;
  return { isDetected, instantRpm, delta };
}

