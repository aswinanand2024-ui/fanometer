'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Rocket, 
  Activity, 
  Compass, 
  Play, 
  Pause, 
  Upload, 
  Trophy, 
  Crosshair, 
  RotateCw, 
  Gauge, 
  Volume2, 
  VolumeX, 
  ShieldAlert,
  Camera,
  CameraOff,
  Sliders,
  Download,
  Award,
  Sparkles,
  Trash2,
  FileSpreadsheet,
  RefreshCw,
  Zap,
  Power,
  UserPlus,
  Layers,
  Info,
  Check,
  Calculator
} from 'lucide-react';
import confetti from 'canvas-confetti';

import { KinematicsData, FlightRecord, TrackingRoi, CalibrationMode } from '@/lib/types';
import { initTrackerState, sampleRoiLuma, evaluatePulse } from '@/lib/cvEngine';
import { calculateKinematics, calculateProjectedTrajectory } from '@/lib/kinematics';
import { resolveTier, CHARACTER_TIERS } from '@/lib/characterMatrix';
import { getPersistedStandings, saveFlightRecord, clearStandings, exportStandingsCsv } from '@/lib/storage';
import { missionAudio } from '@/lib/soundFx';

type InputFeedMode = 'synthetic' | 'camera' | 'upload';

// Explicit ROI / Target Pin Renderer with strict transform isolation
function drawROI(ctx: CanvasRenderingContext2D, point: { x: number; y: number } | null | undefined, radius = 8) {
  if (!point || point.x === undefined || point.y === undefined) return;

  ctx.save();
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI, false);
  ctx.fillStyle = '#00FFA3'; // Neon green target pin
  ctx.shadowColor = 'rgba(0, 255, 163, 0.7)';
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();
  
  // Crosshair center
  ctx.beginPath();
  ctx.moveTo(point.x - 12, point.y);
  ctx.lineTo(point.x + 12, point.y);
  ctx.moveTo(point.x, point.y - 12);
  ctx.lineTo(point.x, point.y + 12);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

export default function MissionControl() {
  // Video & Canvas Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const graphCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lumaScopeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pilotImg = useRef<HTMLImageElement | HTMLCanvasElement | null>(null);
  const videoAngleRef = useRef<number>(0);

  // Custom Blade Leaf Passenger / Pilot States
  const [customPilotUrl, setCustomPilotUrl] = useState<string>('/pilot_swing.png');
  const [autoRemoveBg, setAutoRemoveBg] = useState<boolean>(true);
  const [pilotScale, setPilotScale] = useState<number>(1.5);

  // Input & Mode States
  const [feedMode, setFeedMode] = useState<InputFeedMode>('synthetic');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [cameraFacing, setCameraFacing] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(true);

  // Calibration & Optical Sensors
  const [bladeDiameter, setBladeDiameter] = useState<number>(1.2);
  const [roi, setRoi] = useState<TrackingRoi | null>({ x: 400, y: 180 });
  const [calibrationMode, setCalibrationMode] = useState<CalibrationMode>('single_marker');
  const [bladeCount, setBladeCount] = useState<number>(3);
  const [riseThreshold, setRiseThreshold] = useState<number>(16.0);
  const [refractoryMs, setRefractoryMs] = useState<number>(60);
  const [boxSize, setBoxSize] = useState<number>(20);
  const [showCalibration, setShowCalibration] = useState<boolean>(false);

  // 2-Click Radius Calibration State
  const [isCalibratingRadius, setIsCalibratingRadius] = useState<boolean>(false);
  const [calCenter, setCalCenter] = useState<{ x: number; y: number } | null>(null);
  const [calTip, setCalTip] = useState<{ x: number; y: number } | null>(null);
  const [calRadiusPx, setCalRadiusPx] = useState<number | null>(null);

  // Mathematical Projected Distance State
  const [projectionHours, setProjectionHours] = useState<number>(1.0);

  // Audio Controls
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [turbineAudioEnabled, setTurbineAudioEnabled] = useState<boolean>(false);
  const [audioVolume, setAudioVolume] = useState<number>(0.4);

  // Synthetic Simulation Controls
  const [syntheticTargetRpm, setSyntheticTargetRpm] = useState<number>(240);
  const [syntheticBladeCount, setSyntheticBladeCount] = useState<number>(3);
  const syntheticCurrentRpmRef = useRef<number>(240);
  const syntheticAngleRef = useRef<number>(0);

  // Telemetry & Mission State
  const [telemetry, setTelemetry] = useState<KinematicsData>({
    rpm: 0,
    smoothedRpm: 0,
    linearVelocityKmh: 0,
    linearVelocityMph: 0,
    cumulativeRotations: 0,
    totalDistanceMeters: 0,
    totalDistanceKm: 0,
    moonProgressPct: 0,
    everestClimbsEquivalent: 0,
    centripetalG: 0,
    machNumber: 0,
    kineticEnergyJoules: 0,
  });
  const [peakSessionRpm, setPeakSessionRpm] = useState<number>(0);
  const [missionElapsedTime, setMissionElapsedTime] = useState<number>(0);
  const [historyRpm, setHistoryRpm] = useState<number[]>([]);
  const [recentLumaHistory, setRecentLumaHistory] = useState<number[]>([]);
  const [leaderboard, setLeaderboard] = useState<FlightRecord[]>([]);
  const [systemStatus, setSystemStatus] = useState<string>('SYNTHETIC MATRIX ONLINE');
  const [pulseDetectedFlash, setPulseDetectedFlash] = useState<boolean>(false);

  // Certificate Modal State
  const [showCertificateModal, setShowCertificateModal] = useState<boolean>(false);
  const [pilotCallsign, setPilotCallsign] = useState<string>('Specialist Babu');
  const [fanCodename, setFanCodename] = useState<string>('Aero-Drift Mk.IV');

  const trackerRef = useRef(initTrackerState(refractoryMs));
  const lastHazardAlarmTimeRef = useRef<number>(0);

  // Background Removal Chroma-Key Processor
  const processChromaKey = (img: HTMLImageElement): HTMLCanvasElement => {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = img.naturalWidth || img.width || 300;
    offCanvas.height = img.naturalHeight || img.height || 300;
    const offCtx = offCanvas.getContext('2d');
    if (!offCtx) return offCanvas;

    offCtx.drawImage(img, 0, 0);
    try {
      const imgData = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
      const d = imgData.data;
      const bgR = d[0];
      const bgG = d[1];
      const bgB = d[2];

      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const dist = Math.hypot(r - bgR, g - bgG, b - bgB);
        if (dist < 46) {
          d[i + 3] = 0;
        } else if (dist < 64) {
          d[i + 3] = Math.round(((dist - 46) / 18) * 255);
        }
      }
      offCtx.putImageData(imgData, 0, 0);
      return offCanvas;
    } catch {
      return offCanvas;
    }
  };

  // Stop Fan / Emergency Brake Handler
  const handleStopFan = () => {
    setSyntheticTargetRpm(0);
    syntheticCurrentRpmRef.current = 0;
    setTelemetry((prev) => calculateKinematics(bladeDiameter, prev.cumulativeRotations, 0));
    missionAudio.stopTurbineDrone();
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
      setIsProcessing(false);
    }
    setSystemStatus('FAN STOPPED // BRAKE ENGAGED');
  };

  // Custom Pilot/Leaf Picture Upload Handlers
  const handleCustomPilotUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setCustomPilotUrl(url);
    }
  };

  const handleResetPilotPic = () => {
    setCustomPilotUrl('/pilot_swing.png');
  };

  // Load standings & pilot character sprite on mount
  useEffect(() => {
    setLeaderboard(getPersistedStandings());

    const img = new Image();
    img.src = customPilotUrl;
    img.onload = () => {
      pilotImg.current = autoRemoveBg ? processChromaKey(img) : img;
    };
  }, [customPilotUrl, autoRemoveBg]);

  // Update audio volume and turbine drone preferences
  useEffect(() => {
    missionAudio.enabled = audioEnabled;
    missionAudio.turbineAudioEnabled = turbineAudioEnabled;
    missionAudio.setVolume(audioVolume);
  }, [audioEnabled, turbineAudioEnabled, audioVolume]);

  // Mission Elapsed Time Timer
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isProcessing) {
      timer = setInterval(() => {
        setMissionElapsedTime((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isProcessing]);

  // Active Tier
  const activeTier = resolveTier(telemetry.rpm);

  // Trigger sound alarm on high hazard
  useEffect(() => {
    if (telemetry.rpm > 0) {
      missionAudio.updateTurbineDrone(telemetry.rpm);
    } else {
      missionAudio.stopTurbineDrone();
    }

    if (activeTier.hazardLevel === 'CRITICAL' || activeTier.hazardLevel === 'COSMIC') {
      const now = Date.now();
      if (now - lastHazardAlarmTimeRef.current > 6000) {
        lastHazardAlarmTimeRef.current = now;
        missionAudio.playHazardAlarm();
      }
    }
  }, [telemetry.rpm, activeTier.hazardLevel]);

  // Camera Management
  const stopCameraStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const startCameraStream = useCallback(async (facing: 'environment' | 'user') => {
    stopCameraStream();
    setCameraError(null);
    setSystemStatus('ACQUIRING OPTICAL SENSOR...');

    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: facing,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setFeedMode('camera');
      setIsProcessing(true);
      setSystemStatus('OPTICAL SENSOR ACTIVE: LOCKED');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Camera access rejected';
      setCameraError(`Camera acquisition failed: ${errorMsg}. Using Synthetic matrix.`);
      setFeedMode('synthetic');
      setSystemStatus('SYSTEM: SYNTHETIC FALLBACK');
    }
  }, [stopCameraStream]);

  // Clean up camera on unmount
  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, [stopCameraStream]);

  // File Upload Handler
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      stopCameraStream();
      setVideoSrc(URL.createObjectURL(file));
      setFeedMode('upload');
      setRoi(null);
      setIsProcessing(false);
      setSystemStatus('CALIBRATE: CLICK TARGET BLADE');
    }
  };

  // Switch to Synthetic Mode
  const handleSwitchToSynthetic = () => {
    stopCameraStream();
    setVideoSrc(null);
    setFeedMode('synthetic');
    setIsProcessing(true);
    setSystemStatus('SYNTHETIC MATRIX ONLINE');
    if (!roi) {
      setRoi({ x: 400, y: 180 });
    }
  };

  // Canvas Click: Set ROI Coordinates or 2-Click Radius Calibration
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    if (isCalibratingRadius) {
      if (!calCenter) {
        setCalCenter({ x, y });
        setSystemStatus(`CALIBRATION [1/2]: HUB SET [${x}, ${y}]. CLICK BLADE TIP`);
      } else {
        setCalTip({ x, y });
        const radiusPx = Math.round(Math.hypot(x - calCenter.x, y - calCenter.y));
        setCalRadiusPx(radiusPx);
        setRoi({ x, y }); // Immediately lock optical sensor onto the outer blade tip
        setIsCalibratingRadius(false);
        setSystemStatus(`CALIBRATION LOCKED: RADIUS ${radiusPx}px. SENSOR ENGAGED`);
      }
      return;
    }

    setRoi({ x, y });
    setSystemStatus(`TARGET LOCKED [${x}, ${y}]`);
  };

  // Main Render & Detection Loop
  useEffect(() => {
    let animId: number;

    const loop = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d', { willReadFrequently: true });
      const video = videoRef.current;

      if (canvas && ctx) {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        let blade0Angle = 0;
        let pilotRadius = 126;
        let activeRpm = 0;

        if (feedMode === 'synthetic') {
          // Synthetic Simulation Rendering
          ctx.fillStyle = '#030712';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Subtle background radar rings
          ctx.save();
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1;
          for (let r = 40; r <= 160; r += 40) {
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, 2 * Math.PI);
            ctx.stroke();
          }

          // Smooth rotational inertia
          const targetRadSpeed = (syntheticTargetRpm * 2 * Math.PI) / 3600; // per frame at 60fps
          const currentRadSpeed = (syntheticCurrentRpmRef.current * 2 * Math.PI) / 3600;
          syntheticCurrentRpmRef.current += (syntheticTargetRpm - syntheticCurrentRpmRef.current) * 0.05;
          syntheticAngleRef.current += currentRadSpeed;

          // Draw rotating hub & blades
          ctx.translate(cx, cy);
          ctx.rotate(syntheticAngleRef.current);

          const bladeStep = (2 * Math.PI) / syntheticBladeCount;
          for (let i = 0; i < syntheticBladeCount; i++) {
            ctx.rotate(bladeStep);
            
            // Blade body
            ctx.beginPath();
            ctx.roundRect(16, -12, 115, 24, 6);
            ctx.fillStyle = i === 0 ? '#ec4899' : '#1e293b';
            ctx.fill();
            ctx.strokeStyle = i === 0 ? '#f43f5e' : '#334155';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Neon tip marker for crisp optical detection
            if (i === 0) {
              ctx.fillStyle = '#38bdf8';
              ctx.fillRect(100, -10, 26, 20);
            }
          }

          // Central Rotor Housing
          ctx.beginPath();
          ctx.arc(0, 0, 26, 0, 2 * Math.PI);
          ctx.fillStyle = '#0f172a';
          ctx.fill();
          ctx.strokeStyle = '#06b6d4';
          ctx.lineWidth = 2;
          ctx.stroke();

          // Hub center bolt
          ctx.beginPath();
          ctx.arc(0, 0, 8, 0, 2 * Math.PI);
          ctx.fillStyle = '#06b6d4';
          ctx.fill();

          ctx.restore();

          if (!roi) {
            setRoi({ x: Math.round(cx + 90), y: Math.round(cy) });
          }

          blade0Angle = syntheticAngleRef.current + bladeStep;
          pilotRadius = 126;
          activeRpm = syntheticCurrentRpmRef.current || telemetry.rpm || 0;
        } else if ((feedMode === 'camera' || feedMode === 'upload') && video && video.readyState >= 2) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          videoAngleRef.current += (Math.max(telemetry.rpm, 20) * 2 * Math.PI) / 3600;
          blade0Angle = videoAngleRef.current;
          pilotRadius = roi ? Math.hypot(roi.x - cx, roi.y - cy) : 126;
          activeRpm = telemetry.rpm || 0;
        } else {
          // Clear canvas cleanly when waiting for video or camera stream
          ctx.fillStyle = '#030712';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        // Optical Pulse Evaluation (Sampled BEFORE rendering pilot overlay to prevent interference)
        if (roi && isProcessing) {
          const luma = sampleRoiLuma(ctx, roi, boxSize);
          const now = performance.now();
          const { isDetected, instantRpm } = evaluatePulse(
            luma, 
            trackerRef.current, 
            now,
            {
              riseThreshold,
              fallThreshold: -riseThreshold * 0.65,
              refractoryPeriodMs: refractoryMs,
              bladeCount,
              isMultiBladeSymmetrical: calibrationMode === 'symmetrical_blades',
            }
          );

          setRecentLumaHistory([...trackerRef.current.lumaHistory]);

          if (isDetected) {
            if (feedMode !== 'synthetic' && roi) {
              videoAngleRef.current = Math.atan2(roi.y - cy, roi.x - cx);
            }

            missionAudio.playBladePassBlip(instantRpm ? Math.min(1200, 300 + instantRpm * 2) : 880);
            setPulseDetectedFlash(true);
            setTimeout(() => setPulseDetectedFlash(false), 90);

            setTelemetry((prev) => {
              const currentRpm = (instantRpm && instantRpm < 1500) ? instantRpm : prev.rpm;
              if (currentRpm > 0) {
                setHistoryRpm((h) => [...h.slice(-30), currentRpm]);
                setPeakSessionRpm((p) => Math.max(p, currentRpm));
              }
              return calculateKinematics(bladeDiameter, prev.cumulativeRotations + 1, currentRpm);
            });
          }
        }

        // Target Optical Sensor Pin Marker (#00FFA3 neon pin with glow & crosshair)
        if (roi) {
          drawROI(ctx, roi, 8);

          if (pulseDetectedFlash) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(roi.x, roi.y, 16, 0, 2 * Math.PI);
            ctx.strokeStyle = 'rgba(0, 255, 163, 0.8)';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
          }
        }

        // 2-Click Radius Calibration Markers & Dynamic Scale Line
        if (calCenter) {
          drawROI(ctx, calCenter, 6);
        }
        if (calCenter && calTip) {
          drawROI(ctx, calTip, 6);
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(calCenter.x, calCenter.y);
          ctx.lineTo(calTip.x, calTip.y);
          ctx.strokeStyle = '#00FFA3';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.restore();
        }

        // Render Swinging Character Holding onto Outer Tip of Blade #0
        if (pilotImg.current && (feedMode === 'synthetic' || isProcessing)) {
          ctx.save();
          // 1. Navigate to outer tip of blade #0 relative to the rotating hub
          ctx.translate(cx, cy);
          ctx.rotate(blade0Angle);
          ctx.translate(pilotRadius, 0);

          // 2. Calculate centrifugal swing: compute a tilt angle based on current RPM
          const tiltAngle = Math.min(Math.PI / 3, (activeRpm / 350) * (Math.PI / 4));
          ctx.rotate(tiltAngle);

          // 3. Add high-speed chaos: if RPM exceeds 220, introduce a random positional jitter/shake of 3–6 pixels
          if (activeRpm > 220) {
            const jitterMagnitude = 3 + Math.random() * 3;
            const jitterX = (Math.random() - 0.5) * jitterMagnitude;
            const jitterY = (Math.random() - 0.5) * jitterMagnitude;
            ctx.translate(jitterX, jitterY);
          }

          // 4. Draw the character image holding onto the blade tip (Projector High-Visibility Scale)
          const pilotW = 95 * pilotScale;
          const pilotH = 120 * pilotScale;
          const drawX = -pilotW * 0.45;
          const drawY = -pilotH * 0.12;
          ctx.drawImage(pilotImg.current, drawX, drawY, pilotW, pilotH);
          ctx.restore();
        }
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [
    roi, 
    isProcessing, 
    feedMode, 
    syntheticTargetRpm, 
    syntheticBladeCount, 
    boxSize, 
    riseThreshold, 
    refractoryMs, 
    bladeCount, 
    calibrationMode, 
    bladeDiameter, 
    pulseDetectedFlash,
    pilotScale,
    calCenter,
    calTip
  ]);

  // Render Frequency Oscillogram
  useEffect(() => {
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Grid lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.moveTo(0, canvas.height / 4);
    ctx.lineTo(canvas.width, canvas.height / 4);
    ctx.moveTo(0, (canvas.height * 3) / 4);
    ctx.lineTo(canvas.width, (canvas.height * 3) / 4);
    ctx.stroke();

    if (historyRpm.length < 2) return;
    const maxR = Math.max(...historyRpm, 400);
    const step = canvas.width / (historyRpm.length - 1);

    // Gradient fill under waveform
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, 'rgba(6, 182, 212, 0.35)');
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

    ctx.beginPath();
    historyRpm.forEach((val, i) => {
      const x = i * step;
      const y = canvas.height - (val / maxR) * (canvas.height - 10) - 5;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill under line
    ctx.lineTo(canvas.width, canvas.height);
    ctx.lineTo(0, canvas.height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }, [historyRpm]);

  // Render Live Luma Oscilloscope (Calibration Scope)
  useEffect(() => {
    const canvas = lumaScopeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (recentLumaHistory.length < 2) return;

    const maxL = 255;
    const step = canvas.width / (recentLumaHistory.length - 1);

    ctx.beginPath();
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    recentLumaHistory.forEach((val, i) => {
      const x = i * step;
      const y = canvas.height - (val / maxL) * (canvas.height - 8) - 4;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw Threshold Guide
    const currentBaseLuma = recentLumaHistory[recentLumaHistory.length - 1] || 128;
    const thresholdY = canvas.height - (Math.min(255, currentBaseLuma + riseThreshold) / maxL) * (canvas.height - 8) - 4;
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.moveTo(0, thresholdY);
    ctx.lineTo(canvas.width, thresholdY);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [recentLumaHistory, riseThreshold]);

  // Log Flight to Leaderboard & Show Certificate
  const handleOpenCertificateModal = () => {
    setShowCertificateModal(true);
  };

  const handleSaveFlight = () => {
    const record: FlightRecord = {
      id: `FLIGHT-${Date.now().toString().slice(-4)}`,
      fanCodename: fanCodename || 'Sector Fan Alpha',
      pilotCallsign: pilotCallsign || 'Specialist Babu',
      peakRpm: peakSessionRpm || telemetry.rpm,
      maxSpeedKmh: telemetry.linearVelocityKmh,
      totalDistanceKm: telemetry.totalDistanceKm,
      assignedTier: activeTier.title,
      recordedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
      centripetalG: telemetry.centripetalG,
      machNumber: telemetry.machNumber,
      durationSeconds: missionElapsedTime,
    };
    const updated = saveFlightRecord(record);
    setLeaderboard(updated);
    missionAudio.playMissionLoggedChime();
    confetti({ particleCount: 85, spread: 70, origin: { y: 0.7 } });
    setShowCertificateModal(false);
  };

  // Download High-Resolution Flight Certificate as PNG
  const handleDownloadCertificate = () => {
    const certCanvas = document.createElement('canvas');
    certCanvas.width = 1200;
    certCanvas.height = 800;
    const ctx = certCanvas.getContext('2d');
    if (!ctx) return;

    // Background Gradient
    const bgGradient = ctx.createLinearGradient(0, 0, 1200, 800);
    bgGradient.addColorStop(0, '#04070d');
    bgGradient.addColorStop(0.5, '#091322');
    bgGradient.addColorStop(1, '#02050a');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, 1200, 800);

    // Aerospace Tactical Grid
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 40; x < 1200; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 800);
      ctx.stroke();
    }
    for (let y = 40; y < 800; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1200, y);
      ctx.stroke();
    }

    // Border Brackets & Frame
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 3;
    ctx.strokeRect(30, 30, 1140, 740);

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1;
    ctx.strokeRect(36, 36, 1128, 728);

    // Corner decorative markers
    ctx.fillStyle = '#06b6d4';
    ctx.fillRect(25, 25, 25, 5);
    ctx.fillRect(25, 25, 5, 25);
    ctx.fillRect(1150, 25, 25, 5);
    ctx.fillRect(1170, 25, 5, 25);
    ctx.fillRect(25, 765, 5, 25);
    ctx.fillRect(25, 785, 25, 5);
    ctx.fillRect(1170, 765, 5, 25);
    ctx.fillRect(1150, 785, 25, 5);

    // Header Titles
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('AERODYNAMIC TELEMETRY & ORBITAL FAN DISPLACEMENT SYSTEM', 600, 85);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '900 38px monospace';
    ctx.fillText('OFFICIAL FLIGHT QUALIFICATION DIPLOMA', 600, 135);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px monospace';
    ctx.fillText(`DOCUMENT ID: AT-OFDS-${Date.now().toString().slice(-6)} // SECTOR EARTH CEILING GRID`, 600, 165);

    // Decorative Separator Line
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(100, 185);
    ctx.lineTo(1100, 185);
    ctx.stroke();

    // Pilot & Target Credentials Box
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    ctx.fillRect(80, 210, 1040, 100);
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(80, 210, 1040, 100);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px monospace';
    ctx.fillText('CERTIFIED PILOT CALLSIGN', 110, 245);
    ctx.fillText('IDENTIFIED CEILING UNIT', 460, 245);
    ctx.fillText('MISSION DATE & ELAPSED TIME', 820, 245);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 24px monospace';
    ctx.fillText(pilotCallsign.toUpperCase(), 110, 280);

    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(fanCodename.toUpperCase(), 460, 280);

    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
    ctx.fillStyle = '#f59e0b';
    ctx.fillText(`${dateStr} [${Math.floor(missionElapsedTime / 60)}m ${missionElapsedTime % 60}s]`, 820, 280);

    // Telemetry Score Matrix Cards
    const metrics = [
      { label: 'PEAK ROTATIONAL VELOCITY', value: `${peakSessionRpm || telemetry.rpm} RPM`, color: '#06b6d4' },
      { label: 'MAX TIP SPEED', value: `${telemetry.linearVelocityKmh} KM/H`, color: '#10b981' },
      { label: 'TIP CENTRIPETAL STRESS', value: `${telemetry.centripetalG} G`, color: '#f59e0b' },
      { label: 'TOTAL FLOWN DISTANCE', value: `${telemetry.totalDistanceMeters} M`, color: '#a855f7' },
      { label: 'EVEREST ASCENTS EQUIV', value: `${telemetry.everestClimbsEquivalent} CLIMBS`, color: '#38bdf8' },
      { label: 'LUNAR TRANSIT FRACTION', value: `${telemetry.moonProgressPct.toFixed(6)}%`, color: '#ec4899' },
    ];

    metrics.forEach((m, idx) => {
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      const x = 80 + col * 360;
      const y = 335 + row * 115;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
      ctx.fillRect(x, y, 320, 95);
      ctx.strokeStyle = '#1e293b';
      ctx.strokeRect(x, y, 320, 95);

      ctx.fillStyle = '#64748b';
      ctx.font = '11px monospace';
      ctx.fillText(m.label, x + 20, y + 32);

      ctx.fillStyle = m.color;
      ctx.font = 'bold 28px monospace';
      ctx.fillText(m.value, x + 20, y + 72);
    });

    // Classification Tier Stamp Banner
    ctx.fillStyle = 'rgba(6, 182, 212, 0.1)';
    ctx.fillRect(80, 580, 1040, 90);
    ctx.strokeStyle = '#06b6d4';
    ctx.strokeRect(80, 580, 1040, 90);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px monospace';
    ctx.fillText(`OFFICIAL AERODYNAMIC CLASSIFICATION TIER [HAZARD: ${activeTier.hazardLevel}]`, 110, 615);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '900 32px monospace';
    ctx.fillText(activeTier.title.toUpperCase(), 110, 652);

    // Official Holographic Seal Stamp
    ctx.save();
    ctx.translate(1010, 625);
    ctx.rotate(-0.15);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 48, 0, 2 * Math.PI);
    ctx.stroke();

    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('OFFICIALLY CERTIFIED', 0, -12);
    ctx.fillText('POINTLESS FLIGHT', 0, 5);
    ctx.fillText('VERIFIED ROTATION', 0, 22);
    ctx.restore();

    // Footer Credentials
    ctx.fillStyle = '#475569';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PROJECT CEILING DRIFT // AERODYNAMIC TELEMETRY BOARD // IN-BROWSER OPTICAL COMPUTER VISION', 600, 730);

    // Trigger Download
    const dataUrl = certCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `CEILING-DRIFT-CERTIFICATE-${pilotCallsign.replace(/\s+/g, '_')}.png`;
    link.href = dataUrl;
    link.click();
  };

  // Clear Leaderboard
  const handleClearStandings = () => {
    if (confirm('Are you sure you want to purge all recorded flight standings?')) {
      const cleared = clearStandings();
      setLeaderboard(cleared);
    }
  };

  // Export CSV
  const handleExportCsv = () => {
    const csvContent = exportStandingsCsv(leaderboard);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `CEILING_DRIFT_STANDINGS_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Format Time Helper (HH:MM:SS)
  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h > 0 ? `${h.toString().padStart(2, '0')}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Real-time Mathematical Trajectory Projection
  const projectedTrajectory = calculateProjectedTrajectory(bladeDiameter, telemetry.rpm, projectionHours);

  return (
    <main className="min-h-screen bg-[#030712] text-zinc-100 p-3 sm:p-5 md:p-6 lg:p-8 font-mono select-none hud-grid relative">
      {/* Top Aerospace Mission Command Header */}
      <header className="border-b border-cyan-900/40 pb-4 mb-6 flex flex-wrap justify-between items-center gap-4 bg-zinc-950/80 backdrop-blur-md p-4 rounded-xl border shadow-[0_0_30px_rgba(0,0,0,0.8)]">
        <div className="flex items-center gap-3.5">
          <div className="p-2.5 sm:p-3 bg-cyan-950/80 border border-cyan-500/50 rounded-xl text-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.35)] relative overflow-hidden group">
            <Rocket className="w-6 h-6 sm:w-7 sm:h-7 animate-pulse relative z-10" />
            <div className="absolute inset-0 bg-cyan-500/10 scale-0 group-hover:scale-100 transition-transform duration-500 rounded-xl" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg sm:text-xl md:text-2xl lg:text-3xl font-black tracking-widest text-zinc-100 uppercase text-glow-cyan">
                PROJECT CEILING DRIFT
              </h1>
              <span className="text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-500/60 px-2 py-0.5 rounded-full font-bold shadow-[0_0_10px_rgba(6,182,212,0.2)]">
                v2.4 TELEMETRY ONLINE
              </span>
            </div>
            <p className="text-[11px] sm:text-xs text-zinc-400 tracking-wider">
              AERODYNAMIC OPTICAL TACHOMETER & POINTLESS ORBITAL ODOMETRY MATRIX
            </p>
          </div>
        </div>

        {/* Global Controls & Status Bar */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Mission Elapsed Time */}
          <div className="bg-zinc-900/90 border border-zinc-750 px-3 py-1.5 rounded-lg flex items-center gap-2 shadow-inner">
            <span className="text-zinc-500 font-bold text-[10px]">MET:</span>
            <span className="text-cyan-300 font-black tracking-wider">{formatTime(missionElapsedTime)}</span>
          </div>

          {/* Sound Controls */}
          <div className="flex items-center bg-zinc-900/90 border border-zinc-800 rounded-lg px-2.5 py-1.5 gap-2 shadow-inner">
            <button
              id="sfx-toggle-btn"
              onClick={() => setAudioEnabled(!audioEnabled)}
              className="hover:text-cyan-300 transition flex items-center gap-1 font-bold"
              title="Toggle Audio FX"
            >
              {audioEnabled ? <Volume2 className="w-3.5 h-3.5 text-emerald-400" /> : <VolumeX className="w-3.5 h-3.5 text-rose-400" />}
              <span className="text-[11px]">SFX: {audioEnabled ? 'ON' : 'OFF'}</span>
            </button>

            {audioEnabled && (
              <>
                <div className="h-3.5 w-px bg-zinc-700" />
                <button
                  id="turbine-audio-btn"
                  onClick={() => setTurbineAudioEnabled(!turbineAudioEnabled)}
                  className={`text-[11px] px-1.5 py-0.5 rounded transition font-bold ${
                    turbineAudioEnabled ? 'bg-cyan-950 text-cyan-300 border border-cyan-600' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Turbine drone sound pitch follows live RPM"
                >
                  TURBINE: {turbineAudioEnabled ? 'ENGAGED' : 'IDLE'}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={audioVolume}
                  onChange={(e) => setAudioVolume(parseFloat(e.target.value))}
                  className="w-12 h-1 accent-cyan-400 bg-zinc-700 rounded cursor-pointer"
                  title="Master Volume"
                />
              </>
            )}
          </div>

          {/* Live Sensor Status Indicator */}
          <div className="bg-zinc-900/90 border border-zinc-800 px-3 py-1.5 rounded-lg flex items-center gap-2 shadow-inner">
            <span className={`w-2.5 h-2.5 rounded-full ${pulseDetectedFlash ? 'bg-emerald-400 scale-125 shadow-[0_0_10px_#00FFA3]' : 'bg-cyan-500 animate-ping'} transition-all`} />
            <span className="text-zinc-300 font-bold text-[11px]">{systemStatus}</span>
          </div>

          {/* Emergency Stop Button */}
          <button
            id="stop-fan-header-btn"
            onClick={handleStopFan}
            className="bg-rose-950 hover:bg-rose-900 border border-rose-600 hover:border-rose-400 text-rose-200 px-3.5 py-1.5 rounded-lg flex items-center gap-1.5 font-black transition shadow-[0_0_18px_rgba(244,63,94,0.35)] active:scale-95"
            title="Emergency Fan Brake / Stop Fan Immediately"
          >
            <Power className="w-3.5 h-3.5 text-rose-400" />
            <span>STOP FAN</span>
          </button>

          {/* Calibration Drawer Toggle */}
          <button
            id="calibration-toggle-btn"
            onClick={() => setShowCalibration(!showCalibration)}
            className={`px-3 py-1.5 rounded-lg border transition flex items-center gap-1.5 font-bold ${
              showCalibration 
                ? 'bg-amber-950 border-amber-500 text-amber-300 shadow-[0_0_15px_rgba(245,158,11,0.25)]' 
                : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-700 text-zinc-300'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>Calibration</span>
          </button>
        </div>
      </header>

      {/* Camera Alert Banner */}
      {cameraError && (
        <div className="mb-6 p-3.5 bg-rose-950/80 border border-rose-600/70 rounded-xl text-xs text-rose-200 flex items-center justify-between gap-4 backdrop-blur-md shadow-lg">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{cameraError}</span>
          </div>
          <button
            onClick={() => setCameraError(null)}
            className="text-zinc-400 hover:text-zinc-100 font-bold px-2 py-0.5 bg-zinc-900 rounded border border-zinc-750"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Expandable Calibration Panel Drawer */}
      {showCalibration && (
        <section className="mb-6 bg-zinc-950/95 border border-amber-500/40 rounded-xl p-5 shadow-[0_0_30px_rgba(245,158,11,0.12)] backdrop-blur-md">
          <div className="flex flex-wrap items-center justify-between pb-3 border-b border-zinc-800 mb-4 gap-2">
            <div className="flex items-center gap-2 text-amber-400 font-bold text-xs uppercase tracking-wider">
              <Sliders className="w-4 h-4" />
              <span>Optical Receptor Calibration & Waveform Tuning Drawer</span>
            </div>
            <span className="text-[11px] text-zinc-500">Fine-tune optical delta sensitivity to eliminate lighting false-positives</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 text-xs">
            {/* Tracking Mode */}
            <div>
              <label className="block text-zinc-400 mb-1.5 font-bold">Tracking Mode</label>
              <div className="flex flex-col gap-1.5">
                <button
                  onClick={() => setCalibrationMode('single_marker')}
                  className={`text-left px-2.5 py-1.5 rounded-lg border transition ${
                    calibrationMode === 'single_marker'
                      ? 'bg-cyan-950 border-cyan-500 text-cyan-300 font-bold shadow-[0_0_10px_rgba(6,182,212,0.2)]'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  Single Marker / Neon Tape (1 pulse = 1 rev)
                </button>
                <button
                  onClick={() => setCalibrationMode('symmetrical_blades')}
                  className={`text-left px-2.5 py-1.5 rounded-lg border transition ${
                    calibrationMode === 'symmetrical_blades'
                      ? 'bg-cyan-950 border-cyan-500 text-cyan-300 font-bold shadow-[0_0_10px_rgba(6,182,212,0.2)]'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  Symmetrical Blades (Divide by {bladeCount})
                </button>
              </div>

              {calibrationMode === 'symmetrical_blades' && (
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="text-zinc-500 font-bold">Blades:</span>
                  {[3, 4, 5].map((cnt) => (
                    <button
                      key={cnt}
                      onClick={() => setBladeCount(cnt)}
                      className={`px-2.5 py-0.5 rounded border text-xs font-bold transition ${
                        bladeCount === cnt
                          ? 'bg-cyan-900 border-cyan-400 text-cyan-200'
                          : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                      }`}
                    >
                      {cnt} Blades
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Threshold Sensitivity */}
            <div>
              <div className="flex justify-between text-zinc-400 mb-1.5">
                <span className="font-bold">Delta Sensitivity</span>
                <span className="text-amber-400 font-bold">Δ {riseThreshold.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min="6"
                max="40"
                step="1"
                value={riseThreshold}
                onChange={(e) => setRiseThreshold(parseFloat(e.target.value))}
                className="w-full h-1.5 accent-amber-400 bg-zinc-800 rounded cursor-pointer"
              />
              <span className="text-[10px] text-zinc-500 mt-1 block">
                Lower = More sensitive (low contrast). Higher = Rejects room lighting hum.
              </span>
            </div>

            {/* Refractory Lockout */}
            <div>
              <div className="flex justify-between text-zinc-400 mb-1.5">
                <span className="font-bold">Refractory Lockout</span>
                <span className="text-cyan-400 font-bold">{refractoryMs} ms</span>
              </div>
              <input
                type="range"
                min="25"
                max="180"
                step="5"
                value={refractoryMs}
                onChange={(e) => setRefractoryMs(parseInt(e.target.value, 10))}
                className="w-full h-1.5 accent-cyan-400 bg-zinc-800 rounded cursor-pointer"
              />
              <span className="text-[10px] text-zinc-500 mt-1 block">
                Minimum cooldown between pulses to prevent double-counting.
              </span>
            </div>

            {/* Aperture Size */}
            <div>
              <div className="flex justify-between text-zinc-400 mb-1.5">
                <span className="font-bold">Aperture Size</span>
                <span className="text-emerald-400 font-bold">{boxSize}×{boxSize} px</span>
              </div>
              <div className="grid grid-cols-5 gap-1">
                {[12, 16, 20, 24, 32].map((sz) => (
                  <button
                    key={sz}
                    onClick={() => setBoxSize(sz)}
                    className={`py-1 rounded border text-center font-bold transition ${
                      boxSize === sz
                        ? 'bg-emerald-950 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]'
                        : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    {sz}px
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-zinc-500 mt-1 block">
                $20\times20$px perceptual luminance sampling patch.
              </span>
            </div>
          </div>
        </section>
      )}

      {/* PRIMARY COCKPIT TELEMETRY HUD STRIP */}
      <section className="mb-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        {/* Metric 1: Rotational Velocity (RPM) */}
        <div className="bg-zinc-950/90 border border-cyan-900/60 p-4 rounded-xl shadow-[0_0_20px_rgba(6,182,212,0.12)] relative overflow-hidden corner-brackets">
          <div className="flex justify-between items-center text-zinc-400 mb-1">
            <span className="text-[11px] uppercase tracking-wider font-bold flex items-center gap-1.5">
              <RotateCw className="w-3.5 h-3.5 text-cyan-400" />
              ROTATIONAL RPM
            </span>
            <span className="text-[10px] bg-cyan-950/80 text-cyan-300 border border-cyan-700/60 px-1.5 py-0.5 rounded font-bold">
              PEAK: {peakSessionRpm || telemetry.rpm}
            </span>
          </div>
          <div className="text-3xl sm:text-4xl lg:text-5xl font-black text-cyan-400 text-glow-cyan tracking-tight my-1">
            {telemetry.rpm}
          </div>
          <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden mt-2">
            <div 
              className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full transition-all duration-200" 
              style={{ width: `${Math.min((telemetry.rpm / 450) * 100, 100)}%` }}
            />
          </div>
        </div>

        {/* Metric 2: Linear Peripheral Tip Speed */}
        <div className="bg-zinc-950/90 border border-emerald-900/60 p-4 rounded-xl shadow-[0_0_20px_rgba(16,185,129,0.12)] relative overflow-hidden corner-brackets">
          <div className="flex justify-between items-center text-zinc-400 mb-1">
            <span className="text-[11px] uppercase tracking-wider font-bold flex items-center gap-1.5">
              <Gauge className="w-3.5 h-3.5 text-emerald-400" />
              TIP VELOCITY
            </span>
            <span className="text-[10px] text-zinc-500 font-bold">
              {telemetry.linearVelocityMph} MPH
            </span>
          </div>
          <div className="text-3xl sm:text-4xl lg:text-5xl font-black text-emerald-400 text-glow-emerald tracking-tight my-1">
            {telemetry.linearVelocityKmh}
            <span className="text-xs text-zinc-400 ml-1 font-normal">KM/H</span>
          </div>
          <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden mt-2">
            <div 
              className="bg-emerald-500 h-full transition-all duration-200" 
              style={{ width: `${Math.min((telemetry.linearVelocityKmh / 65) * 100, 100)}%` }}
            />
          </div>
        </div>

        {/* Metric 3: Projected Distance & Mathematical Trajectory Analysis */}
        <div className="bg-zinc-950/90 border border-amber-500/70 p-4 rounded-xl shadow-[0_0_25px_rgba(245,158,11,0.18)] relative overflow-hidden corner-brackets">
          {/* Card Header & Quick Time Window Selector */}
          <div className="flex justify-between items-center text-zinc-400 mb-1 flex-wrap gap-1">
            <span className="text-[11px] uppercase tracking-wider font-black flex items-center gap-1.5 text-amber-300">
              <Calculator className="w-3.5 h-3.5 text-amber-400" />
              PROJECTED DISTANCE
            </span>
            <div className="flex items-center gap-1">
              {[
                { label: '15m', hrs: 0.25 },
                { label: '1h', hrs: 1.0 },
                { label: '8h', hrs: 8.0 },
                { label: '24h', hrs: 24.0 },
              ].map((t) => (
                <button
                  key={t.label}
                  onClick={() => setProjectionHours(t.hrs)}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold border transition ${
                    projectionHours === t.hrs
                      ? 'bg-amber-950 border-amber-400 text-amber-200 shadow-[0_0_6px_rgba(245,158,11,0.4)]'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300'
                  }`}
                  title={`Calculate projected distance for ${t.label}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Big Hero Projected Distance Readout */}
          <div className="my-1">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl sm:text-4xl lg:text-5xl font-black text-amber-400 text-glow-amber tracking-tight">
                {projectedTrajectory.projectedDistanceKm >= 1
                  ? projectedTrajectory.projectedDistanceKm.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })
                  : projectedTrajectory.projectedDistanceMeters.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
              <span className="text-xs text-amber-300/80 font-bold uppercase">
                {projectedTrajectory.projectedDistanceKm >= 1 ? 'KM' : 'M'}
              </span>
            </div>
            <div className="text-[10px] text-zinc-400 font-bold flex items-center justify-between mt-0.5">
              <span>
                WILL COVER IN {projectionHours >= 1 ? `${projectionHours} HR${projectionHours > 1 ? 'S' : ''}` : `${Math.round(projectionHours * 60)} MINS`}
              </span>
              <span className="text-amber-400/90 font-mono">
                ~{projectedTrajectory.projectedRotations.toLocaleString()} REVS
              </span>
            </div>
          </div>

          {/* Mathematical Formula Display Box */}
          <div className="mt-2 pt-2 border-t border-zinc-850 bg-black/60 p-2 rounded-lg border border-amber-950/80 text-[10px] font-mono">
            <div className="text-zinc-400 font-bold flex items-center justify-between text-[9px] uppercase tracking-wider text-amber-400/90 mb-1">
              <span>MATH FORMULA</span>
              <span className="text-zinc-500">d = v · t</span>
            </div>
            <div className="text-zinc-300 font-bold text-[10px] leading-tight">
              d = ((RPM · π · D) / 60) · t
            </div>
            <div className="text-[9px] text-emerald-400/90 truncate mt-1">
              d = (({telemetry.rpm} · 3.14 · {bladeDiameter}m) / 60) · {Math.round(projectionHours * 3600)}s
            </div>
          </div>

          {/* Subtext: Real-world equivalent & Odometry so far */}
          <div className="mt-2 text-[10px] text-zinc-400 flex items-center justify-between font-bold">
            <span className="text-zinc-500 truncate">
              📍 {projectedTrajectory.landmarkEquivalent}
            </span>
            <span className="text-zinc-500 font-mono text-[9px]">
              Odo: {telemetry.totalDistanceKm}km
            </span>
          </div>
        </div>

        {/* Metric 4: Centripetal G-Force & Mach */}
        <div className="bg-zinc-950/90 border border-purple-900/60 p-4 rounded-xl shadow-[0_0_20px_rgba(168,85,247,0.12)] relative overflow-hidden corner-brackets">
          <div className="flex justify-between items-center text-zinc-400 mb-1">
            <span className="text-[11px] uppercase tracking-wider font-bold flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              G-FORCE STRESS
            </span>
            <span className="text-[10px] text-cyan-300 font-bold">
              MACH {telemetry.machNumber}
            </span>
          </div>
          <div className="text-3xl sm:text-4xl lg:text-5xl font-black text-purple-400 tracking-tight my-1">
            {telemetry.centripetalG}
            <span className="text-xs text-zinc-400 ml-1 font-normal">G</span>
          </div>
          <div className="text-[10px] text-zinc-400 font-bold mt-1">
            {telemetry.centripetalG > 30 ? '⚠️ CRITICAL STRESS' : 'MOUNT INTEGRITY STABLE'}
          </div>
        </div>

        {/* Metric 5: Lunar Transit Milestone */}
        <div className="col-span-2 sm:col-span-1 md:col-span-2 lg:col-span-1 bg-zinc-950/90 border border-zinc-800 p-4 rounded-xl shadow-[0_0_20px_rgba(0,0,0,0.6)] relative overflow-hidden corner-brackets">
          <div className="flex justify-between items-center text-zinc-400 mb-1">
            <span className="text-[11px] uppercase tracking-wider font-bold flex items-center gap-1.5">
              <Rocket className="w-3.5 h-3.5 text-cyan-300" />
              MOON TRANSIT
            </span>
            <span className="text-[10px] text-zinc-500 font-bold">
              {telemetry.everestClimbsEquivalent}x EVEREST
            </span>
          </div>
          <div className="text-2xl sm:text-3xl lg:text-4xl font-black text-zinc-200 tracking-tight my-1 truncate">
            {telemetry.moonProgressPct.toFixed(5)}%
          </div>
          <div className="text-[10px] text-zinc-500 font-bold mt-1">
            TOWARDS 384,400 KM ORBIT
          </div>
        </div>
      </section>

      {/* MAIN MISSION GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Optical Sensor Viewport & Waveform Suite */}
        <div className="lg:col-span-7 flex flex-col gap-5">
          {/* Tactical Viewport Container */}
          <div className="bg-zinc-950/95 border border-zinc-800 rounded-xl p-4 sm:p-5 shadow-[0_0_30px_rgba(0,0,0,0.7)] backdrop-blur-md">
            <div className="flex flex-wrap justify-between items-center mb-3 text-xs gap-2">
              <span className="text-zinc-200 flex items-center gap-2 font-black tracking-wider uppercase">
                <Crosshair className="w-4 h-4 text-cyan-400 animate-spin-slow" />
                OPTICAL SENSOR VIEWPORT
              </span>
              <div className="flex items-center gap-2.5">
                <span className="text-zinc-400 text-[11px] font-mono bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
                  {roi ? `LOCK: [X:${roi.x}, Y:${roi.y}]` : 'TARGET UNLOCKED (CLICK VIDEO)'}
                </span>
                <span className="text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-700/80 px-2.5 py-0.5 rounded-full font-bold">
                  MODE: {feedMode.toUpperCase()}
                </span>
              </div>
            </div>

            {/* Canvas Viewport HUD Box */}
            <div className="relative aspect-video bg-black rounded-xl border border-zinc-800 overflow-hidden flex items-center justify-center group shadow-2xl">
              <canvas
                id="viewport-canvas"
                ref={canvasRef}
                width={640}
                height={360}
                onClick={handleCanvasClick}
                className="w-full h-full object-contain cursor-crosshair z-0"
              />
              <div className="pointer-events-none absolute inset-0 scanlines opacity-35 z-10" />

              {/* Viewport Corner Brackets */}
              <div className="pointer-events-none absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-cyan-400/70 z-20" />
              <div className="pointer-events-none absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-cyan-400/70 z-20" />
              <div className="pointer-events-none absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-cyan-400/70 z-20" />
              <div className="pointer-events-none absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-cyan-400/70 z-20" />

              {/* Target Reticle Indicator Banner */}
              {roi && (
                <div className="absolute top-3 left-4 z-20 pointer-events-none text-[10px] text-[#00FFA3] font-bold bg-black/70 px-2.5 py-1 rounded-md border border-[#00FFA3]/50 shadow-[0_0_12px_rgba(0,255,163,0.3)]">
                  RECEPTOR LOCKED // CLICK TO REPOSITION
                </div>
              )}

              {/* Hidden Video Tag */}
              <video
                ref={videoRef}
                src={videoSrc || undefined}
                className="hidden"
                playsInline
                muted
                loop
                onPlay={() => setIsProcessing(true)}
                onPause={() => setIsProcessing(false)}
              />
            </div>

            {/* Tactical Presets & 2-Click Radius Calibration Bar */}
            <div className="mt-3 flex flex-wrap items-center justify-between text-[11px] text-zinc-400 gap-2 pt-2 border-t border-zinc-900">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-zinc-500">Presets:</span>
                <button
                  onClick={() => setRoi({ x: 320, y: 180 })}
                  className="px-2 py-0.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded transition text-zinc-300 font-bold"
                >
                  Center Hub
                </button>
                <button
                  onClick={() => setRoi({ x: 410, y: 180 })}
                  className="px-2 py-0.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded transition text-zinc-300 font-bold"
                >
                  Right Blade Tip
                </button>
                <button
                  onClick={() => setRoi({ x: 320, y: 90 })}
                  className="px-2 py-0.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded transition text-zinc-300 font-bold"
                >
                  Top Blade Tip
                </button>
              </div>

              {/* 2-Click Radius Calibration Tool */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (isCalibratingRadius) {
                      setIsCalibratingRadius(false);
                      setCalCenter(null);
                      setCalTip(null);
                      setSystemStatus('CALIBRATION CANCELLED');
                    } else {
                      setIsCalibratingRadius(true);
                      setCalCenter(null);
                      setCalTip(null);
                      setSystemStatus('CALIBRATION [1/2]: CLICK CENTER OF FAN HUB');
                    }
                  }}
                  className={`px-3 py-1 rounded-lg border transition font-black text-xs ${
                    isCalibratingRadius
                      ? 'bg-amber-950 border-amber-500 text-amber-300 animate-pulse shadow-[0_0_12px_rgba(245,158,11,0.3)]'
                      : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-750 text-cyan-300 hover:border-cyan-500'
                  }`}
                >
                  {isCalibratingRadius
                    ? calCenter
                      ? 'Click 2: Blade Tip (Cancel)'
                      : 'Click 1: Fan Hub (Cancel)'
                    : 'Calibrate Radius (2 Clicks)'}
                </button>
                {calRadiusPx && (
                  <span className="text-[10px] text-[#00FFA3] bg-emerald-950/70 px-2 py-0.5 rounded border border-[#00FFA3]/40 font-bold shadow-[0_0_8px_rgba(0,255,163,0.2)]">
                    Radius: {calRadiusPx}px
                  </span>
                )}
              </div>
            </div>

            {/* Input Feeds & Span Controls Toolbar */}
            <div className="mt-4 pt-3 border-t border-zinc-900 flex flex-wrap gap-2.5 items-center justify-between text-xs">
              <div className="flex flex-wrap items-center gap-2">
                {/* Webcam Button */}
                <button
                  id="webcam-toggle-btn"
                  onClick={() => {
                    if (feedMode === 'camera') {
                      stopCameraStream();
                      setFeedMode('synthetic');
                    } else {
                      startCameraStream(cameraFacing);
                    }
                  }}
                  className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-bold transition border ${
                    feedMode === 'camera'
                      ? 'bg-rose-950 border-rose-600 text-rose-300 shadow-[0_0_12px_rgba(244,63,94,0.3)]'
                      : 'bg-cyan-950 hover:bg-cyan-900 border-cyan-600/70 text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.2)]'
                  }`}
                >
                  {feedMode === 'camera' ? <CameraOff className="w-4 h-4" /> : <Camera className="w-4 h-4" />}
                  <span>{feedMode === 'camera' ? 'Disengage Camera' : 'Engage Live Camera'}</span>
                </button>

                {feedMode === 'camera' && (
                  <button
                    onClick={() => {
                      const nextFacing = cameraFacing === 'environment' ? 'user' : 'environment';
                      setCameraFacing(nextFacing);
                      startCameraStream(nextFacing);
                    }}
                    className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 px-2.5 py-1.5 rounded-lg flex items-center gap-1 transition font-bold"
                    title="Flip camera between rear and front"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Flip: {cameraFacing === 'environment' ? 'Back' : 'Front'}</span>
                  </button>
                )}

                {/* Upload MP4 Video */}
                <label className="flex items-center gap-1.5 cursor-pointer bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 hover:border-zinc-600 px-3 py-1.5 rounded-lg transition text-zinc-300 font-bold">
                  <Upload className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Upload Video</span>
                  <input type="file" accept="video/mp4,video/webm" onChange={handleFileUpload} className="hidden" />
                </label>

                {/* Switch to Synthetic Simulation */}
                {feedMode !== 'synthetic' && (
                  <button
                    onClick={handleSwitchToSynthetic}
                    className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 hover:border-zinc-600 text-zinc-300 px-3 py-1.5 rounded-lg transition font-bold"
                  >
                    Simulation Mode
                  </button>
                )}
              </div>

              {/* Blade Diameter Physical Span */}
              <div className="flex items-center gap-2 text-zinc-300 bg-zinc-900/90 px-3 py-1.5 rounded-lg border border-zinc-800 shadow-inner">
                <span className="text-zinc-500 font-bold text-[11px]">Fan Span:</span>
                <input
                  id="span-input"
                  type="number"
                  step="0.1"
                  min="0.3"
                  max="3.0"
                  value={bladeDiameter}
                  onChange={(e) => {
                    const newDiameter = parseFloat(e.target.value) || 1.2;
                    setBladeDiameter(newDiameter);
                    setTelemetry((prev) => calculateKinematics(newDiameter, prev.cumulativeRotations, prev.rpm));
                  }}
                  className="w-14 bg-zinc-950 border border-zinc-700 px-1.5 py-0.5 rounded text-cyan-300 font-bold text-center focus:outline-none focus:border-cyan-500"
                />
                <span className="text-zinc-500 font-bold text-xs">m</span>
              </div>
            </div>

            {/* Video Play/Pause Control (if uploaded video) */}
            {feedMode === 'upload' && videoSrc && (
              <div className="mt-3 pt-3 border-t border-zinc-900 flex items-center justify-between">
                <button
                  id="toggle-playback-btn"
                  onClick={() => {
                    if (videoRef.current) {
                      if (videoRef.current.paused) {
                        videoRef.current.play();
                        setIsProcessing(true);
                      } else {
                        videoRef.current.pause();
                        setIsProcessing(false);
                      }
                    }
                  }}
                  className="bg-emerald-950 hover:bg-emerald-900 border border-emerald-600 text-emerald-300 px-4 py-1.5 rounded-lg flex items-center gap-2 transition text-xs font-black shadow-[0_0_12px_rgba(16,185,129,0.25)]"
                >
                  {isProcessing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  <span>{isProcessing ? 'Halt Telemetry' : 'Commence Analysis'}</span>
                </button>
                <span className="text-[11px] text-zinc-500">Video source loop ready</span>
              </div>
            )}
          </div>

          {/* Dual Channel Waveform & Oscilloscope Deck */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Channel 1: Telemetry Frequency Oscillogram */}
            <div className="bg-zinc-950/95 border border-zinc-800 rounded-xl p-4 shadow-[0_0_20px_rgba(0,0,0,0.6)] backdrop-blur-md">
              <div className="flex justify-between items-center mb-2 text-xs">
                <span className="text-zinc-300 flex items-center gap-1.5 font-bold">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  PULSE FREQUENCY WAVE
                </span>
                <span className="text-cyan-400 font-bold text-[11px]">{telemetry.rpm} RPM</span>
              </div>
              <canvas 
                ref={graphCanvasRef} 
                width={540} 
                height={75} 
                className="w-full h-20 bg-black/80 rounded-lg border border-zinc-800/80 shadow-inner" 
              />
              <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
                <span>TIME DOMAIN (RECENT 30 SAMPLES)</span>
                <span>PEAK: <strong className="text-amber-400 font-mono">{peakSessionRpm} RPM</strong></span>
              </div>
            </div>

            {/* Channel 2: Real-time Luminance Trigger Scope */}
            <div className="bg-zinc-950/95 border border-zinc-800 rounded-xl p-4 shadow-[0_0_20px_rgba(0,0,0,0.6)] backdrop-blur-md">
              <div className="flex justify-between items-center mb-2 text-xs">
                <span className="text-zinc-300 flex items-center gap-1.5 font-bold">
                  <Sliders className="w-4 h-4 text-emerald-400" />
                  OPTICAL TRIGGER SCOPE
                </span>
                <span className="text-amber-400 font-bold text-[10px]">-- TRIGGER Δ {riseThreshold}</span>
              </div>
              <canvas
                ref={lumaScopeCanvasRef}
                width={540}
                height={75}
                className="w-full h-20 bg-black/80 rounded-lg border border-zinc-800/80 shadow-inner"
              />
              <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
                <span>LUMA HISTOGRAM (60 FRAMES)</span>
                <span className="text-emerald-400 font-mono">SENSOR APERTURE: {boxSize}px</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Aerospace Gauges & Mission Telemetry */}
        <div className="lg:col-span-5 flex flex-col gap-5">
          {/* Radial SVG Tachometer Gauge Card */}
          <div className="bg-zinc-950/95 border border-zinc-800 p-5 rounded-xl shadow-[0_0_30px_rgba(0,0,0,0.7)] backdrop-blur-md relative overflow-hidden">
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs text-zinc-300 flex items-center gap-1.5 font-black uppercase tracking-wider">
                <RotateCw className="w-3.5 h-3.5 text-cyan-400" />
                ROTATIONAL VELOCITY TACHOMETER
              </span>
              <span className="text-[10px] bg-zinc-900 text-zinc-400 border border-zinc-700/80 px-2 py-0.5 rounded-full font-bold">
                ACCURACY: 99.4%
              </span>
            </div>

            {/* Radial Tachometer Dial Display */}
            <div className="relative flex flex-col items-center justify-center my-3">
              <svg viewBox="0 0 200 120" className="w-64 h-36 overflow-visible">
                {/* Background Arc */}
                <path
                  d="M 20 105 A 80 80 0 0 1 180 105"
                  fill="none"
                  stroke="#1e293b"
                  strokeWidth="12"
                  strokeLinecap="round"
                />
                {/* Active Dynamic Arc */}
                <path
                  d="M 20 105 A 80 80 0 0 1 180 105"
                  fill="none"
                  stroke="url(#rpmGradient)"
                  strokeWidth="12"
                  strokeLinecap="round"
                  strokeDasharray="251.2"
                  strokeDashoffset={251.2 - (Math.min(telemetry.rpm / 450, 1) * 251.2)}
                  className="transition-all duration-300"
                />
                {/* Needle Indicator */}
                {(() => {
                  const angle = -180 + (Math.min(telemetry.rpm / 450, 1) * 180);
                  const rad = (angle * Math.PI) / 180;
                  const needleX = 100 + 70 * Math.cos(rad);
                  const needleY = 105 + 70 * Math.sin(rad);
                  return (
                    <>
                      <line
                        x1="100"
                        y1="105"
                        x2={needleX}
                        y2={needleY}
                        stroke="#f43f5e"
                        strokeWidth="3"
                        strokeLinecap="round"
                        className="transition-all duration-200"
                      />
                      <circle cx="100" cy="105" r="7" fill="#0f172a" stroke="#f43f5e" strokeWidth="2" />
                    </>
                  );
                })()}
                {/* Dial Tick Labels */}
                <text x="18" y="120" fill="#64748b" fontSize="9" fontWeight="bold" textAnchor="middle">0</text>
                <text x="45" y="55" fill="#64748b" fontSize="9" fontWeight="bold" textAnchor="middle">100</text>
                <text x="100" y="32" fill="#64748b" fontSize="9" fontWeight="bold" textAnchor="middle">225</text>
                <text x="155" y="55" fill="#64748b" fontSize="9" fontWeight="bold" textAnchor="middle">350</text>
                <text x="182" y="120" fill="#64748b" fontSize="9" fontWeight="bold" textAnchor="middle">450+</text>

                <defs>
                  <linearGradient id="rpmGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#06b6d4" />
                    <stop offset="60%" stopColor="#10b981" />
                    <stop offset="85%" stopColor="#f59e0b" />
                    <stop offset="100%" stopColor="#f43f5e" />
                  </linearGradient>
                </defs>
              </svg>

              <div className="text-center -mt-3">
                <div id="rpm-display" className="text-5xl sm:text-6xl font-black text-cyan-400 text-glow-cyan tracking-tight">
                  {telemetry.rpm}
                </div>
                <div className="text-[11px] text-zinc-400 font-bold uppercase tracking-wider mt-1">
                  REVOLUTIONS / MINUTE
                </div>
              </div>
            </div>
          </div>


          {/* Synthetic Motor Controls Deck */}
          {feedMode === 'synthetic' && (
            <div className="bg-zinc-950/95 border border-cyan-950/80 rounded-xl p-5 shadow-[0_0_20px_rgba(0,0,0,0.6)] backdrop-blur-md">
              <div className="flex justify-between items-center mb-2.5 text-xs">
                <span className="text-zinc-200 flex items-center gap-1.5 font-bold uppercase tracking-wider">
                  <Zap className="w-4 h-4 text-cyan-400" />
                  SYNTHETIC MOTOR CONTROLLER
                </span>
                <span className="text-cyan-400 font-black font-mono">{syntheticTargetRpm} RPM TARGET</span>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="450"
                  step="5"
                  value={syntheticTargetRpm}
                  onChange={(e) => setSyntheticTargetRpm(parseInt(e.target.value, 10))}
                  className="w-full h-2 accent-cyan-400 bg-zinc-800 rounded-lg cursor-pointer"
                />
              </div>

              {/* Speed Presets */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-zinc-500 text-[11px] font-bold">Presets:</span>
                  {[
                    { label: 'Idle', rpm: 0 },
                    { label: 'Breeze', rpm: 60 },
                    { label: 'Standard', rpm: 180 },
                    { label: 'Jet Mode', rpm: 290 },
                    { label: 'Hadron', rpm: 390 },
                  ].map((p) => (
                    <button
                      key={p.label}
                      onClick={() => setSyntheticTargetRpm(p.rpm)}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold border transition ${
                        syntheticTargetRpm === p.rpm
                          ? 'bg-cyan-900 border-cyan-400 text-cyan-200 shadow-[0_0_8px_rgba(6,182,212,0.3)]'
                          : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-800 text-zinc-400'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                  <button
                    id="stop-fan-panel-btn"
                    onClick={handleStopFan}
                    className="px-2.5 py-0.5 rounded text-[11px] font-black border transition bg-rose-950 border-rose-500 text-rose-300 hover:bg-rose-900 flex items-center gap-1 shadow-[0_0_8px_rgba(244,63,94,0.3)]"
                    title="Stop fan instantly"
                  >
                    <Power className="w-3 h-3 text-rose-400" />
                    <span>STOP</span>
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500 text-[11px] font-bold">Blades:</span>
                  {[3, 4, 5].map((cnt) => (
                    <button
                      key={cnt}
                      onClick={() => setSyntheticBladeCount(cnt)}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold border transition ${
                        syntheticBladeCount === cnt
                          ? 'bg-pink-950 border-pink-500 text-pink-300'
                          : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-800 text-zinc-400'
                      }`}
                    >
                      {cnt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Passenger / Leaf Picture Customizer */}
          <div className="bg-zinc-950/95 border border-purple-950/80 rounded-xl p-5 shadow-[0_0_20px_rgba(168,85,247,0.1)] backdrop-blur-md">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3 text-xs">
              <div className="flex items-center gap-2 text-purple-400 font-bold uppercase tracking-wider">
                <UserPlus className="w-4 h-4" />
                <span>Fan Passenger / Custom Character</span>
              </div>
              <span className="text-[11px] text-zinc-500">Clings to outer tip of blade #0</span>
            </div>

            <div className="flex flex-wrap sm:flex-nowrap items-center gap-4 text-xs">
              {/* Thumbnail Preview */}
              <div className="w-14 h-14 rounded-xl bg-zinc-900 border border-purple-500/30 flex items-center justify-center overflow-hidden p-1 shrink-0 relative shadow-inner">
                <img
                  src={customPilotUrl}
                  alt="Blade Passenger"
                  className="w-full h-full object-contain"
                />
              </div>

              <div className="flex-1 flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="bg-purple-950 hover:bg-purple-900 border border-purple-600 text-purple-200 px-3 py-1.5 rounded-lg cursor-pointer flex items-center gap-1.5 font-bold transition shadow-[0_0_12px_rgba(168,85,247,0.2)]">
                    <Upload className="w-3.5 h-3.5 text-purple-400" />
                    <span>Upload Picture</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleCustomPilotUpload}
                      className="hidden"
                    />
                  </label>

                  <button
                    onClick={handleResetPilotPic}
                    className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200 px-2.5 py-1.5 rounded-lg transition text-[11px] font-bold"
                  >
                    Reset
                  </button>

                  {/* Quick Scale Presets */}
                  <div className="flex flex-wrap items-center gap-1 bg-zinc-900/90 border border-zinc-800 p-1 rounded-lg">
                    <span className="text-[10px] text-zinc-400 px-1 font-bold">ZOOM:</span>
                    {[
                      { label: '1x', scale: 1.0 },
                      { label: '1.5x', scale: 1.5 },
                      { label: '2.0x', scale: 2.0 },
                      { label: '2.5x', scale: 2.5 },
                    ].map((sz) => (
                      <button
                        key={sz.label}
                        onClick={() => setPilotScale(sz.scale)}
                        className={`px-2 py-0.5 rounded text-[10px] font-black transition ${
                          pilotScale === sz.scale
                            ? 'bg-purple-900 border border-purple-400 text-purple-100 shadow-[0_0_8px_rgba(168,85,247,0.4)]'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                        }`}
                      >
                        {sz.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-zinc-400 pt-1.5 border-t border-zinc-900">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-400 font-bold">Zoom:</span>
                    <input
                      type="range"
                      min="0.8"
                      max="2.8"
                      step="0.1"
                      value={pilotScale}
                      onChange={(e) => setPilotScale(parseFloat(e.target.value))}
                      className="w-24 h-1.5 accent-purple-400 bg-zinc-800 rounded cursor-pointer"
                    />
                    <span className="text-purple-300 font-black text-xs">{(pilotScale * 100).toFixed(0)}%</span>
                  </div>

                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoRemoveBg}
                      onChange={(e) => setAutoRemoveBg(e.target.checked)}
                      className="rounded bg-zinc-800 border-zinc-700 accent-purple-500"
                    />
                    <span>Auto-Remove Background</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* AERODYNAMIC CLASSIFICATION MATRIX TIERS SHOWCASE */}
      <section className="mt-8 bg-zinc-950/95 border border-zinc-800 rounded-xl p-5 shadow-[0_0_30px_rgba(0,0,0,0.7)] backdrop-blur-md">
        <div className="flex items-center gap-2 mb-4 pb-2 border-b border-zinc-900">
          <Layers className="w-5 h-5 text-cyan-400" />
          <h2 className="text-sm font-black tracking-wider uppercase text-zinc-200">
            AERODYNAMIC CLASSIFICATION MATRIX // SPEED TIERS
          </h2>
          <span className="text-[11px] text-zinc-500 ml-auto hidden sm:inline">
            Spin ceiling fan faster to unlock higher relativistic classifications
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {CHARACTER_TIERS.map((tier) => {
            const isActive = activeTier.id === tier.id;
            return (
              <div 
                key={tier.id}
                className={`p-4 rounded-xl border transition-all duration-300 flex flex-col justify-between ${
                  isActive 
                    ? 'bg-cyan-950/60 border-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.3)] scale-[1.02]'
                    : 'bg-zinc-900/60 border-zinc-800/80 hover:border-zinc-700'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      tier.hazardLevel === 'COSMIC' ? 'bg-purple-950 text-purple-300 border border-purple-600' :
                      tier.hazardLevel === 'CRITICAL' ? 'bg-rose-950 text-rose-300 border border-rose-600' :
                      tier.hazardLevel === 'ELEVATED' ? 'bg-amber-950 text-amber-300 border border-amber-600' :
                      'bg-zinc-800 text-zinc-400'
                    }`}>
                      {tier.hazardLevel}
                    </span>
                    {isActive && (
                      <span className="text-[10px] bg-cyan-400 text-black font-black px-1.5 py-0.5 rounded-full animate-pulse">
                        ACTIVE
                      </span>
                    )}
                  </div>

                  <h4 className="text-sm font-black text-zinc-100 mt-1">{tier.title}</h4>
                  <div className="text-[11px] text-cyan-400 font-mono font-bold mt-0.5">
                    {tier.minRpm} – {tier.maxRpm > 1000 ? '450+' : tier.maxRpm} RPM
                  </div>
                  <p className="text-[11px] text-zinc-400 mt-2 leading-relaxed">
                    {tier.description}
                  </p>
                </div>

                <div className="text-[10px] text-zinc-500 font-mono pt-2 mt-3 border-t border-zinc-800">
                  ID: {tier.callsign}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* GLOBAL STANDINGS & FLIGHT RECORDS TABLE */}
      <section className="mt-8 bg-zinc-950/95 border border-zinc-800 rounded-xl p-5 md:p-6 shadow-[0_0_30px_rgba(0,0,0,0.7)] backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between mb-4 gap-3">
          <div className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-amber-400" />
            <h2 className="text-sm font-black tracking-wider uppercase text-zinc-100">
              Global Orbital Ceiling Standings
            </h2>
            <span className="text-[10px] bg-amber-950/80 text-amber-300 border border-amber-600/70 px-2 py-0.5 rounded-full font-bold">
              VERIFIED FLIGHT LOG
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button
              id="log-flight-btn"
              onClick={handleOpenCertificateModal}
              className="bg-cyan-950 hover:bg-cyan-900 border border-cyan-500/70 hover:border-cyan-400 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition text-cyan-200 font-bold shadow-sm"
              title="Log current flight telemetry"
            >
              <Award className="w-3.5 h-3.5 text-cyan-400" />
              <span>Log Flight</span>
            </button>
            <button
              onClick={handleExportCsv}
              className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 hover:border-zinc-600 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition text-zinc-300 font-bold shadow-sm"
              title="Export Standings as CSV file"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span>Export CSV</span>
            </button>
            <button
              onClick={handleClearStandings}
              className="bg-zinc-900 hover:bg-rose-950/60 border border-zinc-700 hover:border-rose-600/60 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition text-zinc-400 hover:text-rose-300 font-bold shadow-sm"
              title="Purge all logged missions"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
              <span>Clear</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-zinc-850">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400 font-bold">
                <th className="py-3 px-3">RANK</th>
                <th className="py-3 px-3">FAN CODENAME</th>
                <th className="py-3 px-3">PILOT CALLSIGN</th>
                <th className="py-3 px-3">CLASSIFICATION</th>
                <th className="py-3 px-3 text-right">PEAK RPM</th>
                <th className="py-3 px-3 text-right">TIP SPEED</th>
                <th className="py-3 px-3 text-right">CENTRIPETAL G</th>
                <th className="py-3 px-3 text-right">DISPLACEMENT</th>
                <th className="py-3 px-3 text-right">RECORDED AT</th>
              </tr>
            </thead>
            <tbody id="leaderboard-body" className="divide-y divide-zinc-900">
              {leaderboard.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-zinc-500 italic">
                    No flight telemetry records logged yet. Run optical tracking or synthetic motor to log records.
                  </td>
                </tr>
              ) : (
                leaderboard.map((item, index) => (
                  <tr key={item.id} className="hover:bg-zinc-900/50 transition">
                    <td className="py-3 px-3 font-bold">
                      {index === 0 ? '🥇 1' : index === 1 ? '🥈 2' : index === 2 ? '🥉 3' : `#${index + 1}`}
                    </td>
                    <td className="py-3 px-3 font-black text-zinc-100">{item.fanCodename}</td>
                    <td className="py-3 px-3 text-zinc-400 font-mono">{item.pilotCallsign}</td>
                    <td className="py-3 px-3 text-cyan-400 font-bold">{item.assignedTier}</td>
                    <td className="py-3 px-3 text-right text-zinc-100 font-bold font-mono">{item.peakRpm} RPM</td>
                    <td className="py-3 px-3 text-right text-emerald-400 font-mono">{item.maxSpeedKmh} km/h</td>
                    <td className="py-3 px-3 text-right text-purple-400 font-mono">{item.centripetalG ? `${item.centripetalG} G` : 'N/A'}</td>
                    <td className="py-3 px-3 text-right text-amber-300 font-black font-mono">{item.totalDistanceKm} km</td>
                    <td className="py-3 px-3 text-right text-zinc-500 font-mono text-[11px]">{item.recordedAt}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Flight Qualification Certificate Modal */}
      {showCertificateModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-cyan-500/60 rounded-2xl max-w-lg w-full p-6 shadow-[0_0_50px_rgba(6,182,212,0.3)] flex flex-col gap-4 relative animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Award className="w-5 h-5 text-cyan-400" />
                <h3 className="font-black text-sm uppercase tracking-wider text-zinc-100">
                  Mission Flight Diploma Formulation
                </h3>
              </div>
              <button
                onClick={() => setShowCertificateModal(false)}
                className="text-zinc-500 hover:text-zinc-200 text-xs font-bold px-2 py-1 bg-zinc-900 rounded border border-zinc-800"
              >
                ✕ CLOSE
              </button>
            </div>

            {/* Callsign & Fan Codename Input Form */}
            <div className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block text-zinc-400 font-bold mb-1">Pilot Callsign</label>
                <input
                  type="text"
                  value={pilotCallsign}
                  onChange={(e) => setPilotCallsign(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 rounded-lg text-cyan-300 font-bold focus:outline-none focus:border-cyan-500 shadow-inner"
                  placeholder="e.g. Flight Officer Babu"
                />
              </div>

              <div>
                <label className="block text-zinc-400 font-bold mb-1">Ceiling Fan Codename</label>
                <input
                  type="text"
                  value={fanCodename}
                  onChange={(e) => setFanCodename(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 rounded-lg text-zinc-200 font-bold focus:outline-none focus:border-cyan-500 shadow-inner"
                  placeholder="e.g. USHA Tornado 9000-GT"
                />
              </div>
            </div>

            {/* Quick Summary Preview */}
            <div className="bg-zinc-900/80 border border-zinc-800 p-3.5 rounded-xl text-xs space-y-2 shadow-inner">
              <div className="flex justify-between">
                <span className="text-zinc-400">Achieved Peak RPM:</span>
                <span className="font-bold text-cyan-400">{peakSessionRpm || telemetry.rpm} RPM</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Max Peripheral Velocity:</span>
                <span className="font-bold text-emerald-400">{telemetry.linearVelocityKmh} KM/H</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Centripetal Stress:</span>
                <span className="font-bold text-purple-400">{telemetry.centripetalG} G</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Displacement Flown:</span>
                <span className="font-bold text-amber-300">{telemetry.totalDistanceMeters} Meters</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Flight Classification:</span>
                <span className="font-bold text-zinc-200">{activeTier.title}</span>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
              <button
                onClick={handleDownloadCertificate}
                className="flex-1 bg-zinc-900 hover:bg-zinc-850 border border-amber-500/70 hover:border-amber-400 text-amber-300 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition shadow-lg"
              >
                <Download className="w-4 h-4" />
                <span>Download PNG Diploma</span>
              </button>
              <button
                onClick={handleSaveFlight}
                className="flex-1 bg-cyan-950 hover:bg-cyan-900 border border-cyan-500 text-cyan-200 py-2.5 rounded-xl text-xs font-black flex items-center justify-center gap-2 transition shadow-[0_0_20px_rgba(6,182,212,0.35)]"
              >
                <Award className="w-4 h-4 text-cyan-400" />
                <span>Log to Leaderboard</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tactical Aerospace Footer */}
      <footer className="mt-12 pt-6 border-t border-zinc-900 text-center text-xs text-zinc-500 flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>PROJECT CEILING DRIFT // AT-OFDS MISSION CONTROL</span>
        </div>
        <div>
          <span>Tip: Click any blade tip on the canvas to lock the optical sensor</span>
        </div>
        <div className="text-zinc-600 font-mono text-[10px]">
          SECTOR CEILING GRID // ALL TELEMETRY RECORDED IN-BROWSER
        </div>
      </footer>
    </main>
  );
}
