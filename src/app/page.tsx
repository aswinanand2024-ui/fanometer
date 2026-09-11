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
  UserPlus
} from 'lucide-react';
import confetti from 'canvas-confetti';

import { KinematicsData, FlightRecord, TrackingRoi, CalibrationMode } from '@/lib/types';
import { initTrackerState, sampleRoiLuma, evaluatePulse } from '@/lib/cvEngine';
import { calculateKinematics } from '@/lib/kinematics';
import { resolveTier } from '@/lib/characterMatrix';
import { getPersistedStandings, saveFlightRecord, clearStandings, exportStandingsCsv } from '@/lib/storage';
import { missionAudio } from '@/lib/soundFx';

type InputFeedMode = 'synthetic' | 'camera' | 'upload';

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
  const [boxSize, setBoxSize] = useState<number>(16);
  const [showCalibration, setShowCalibration] = useState<boolean>(false);

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

  // Canvas Click: Set ROI Coordinates
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
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

          // Tactical Reticle Rendering
          const halfBox = Math.floor(boxSize / 2);
          ctx.save();
          ctx.strokeStyle = pulseDetectedFlash ? '#10b981' : '#06b6d4';
          ctx.lineWidth = pulseDetectedFlash ? 3 : 1.5;

          // Corner brackets
          const bracketLen = Math.max(4, halfBox - 2);
          // Top Left
          ctx.beginPath();
          ctx.moveTo(roi.x - halfBox, roi.y - halfBox + bracketLen);
          ctx.lineTo(roi.x - halfBox, roi.y - halfBox);
          ctx.lineTo(roi.x - halfBox + bracketLen, roi.y - halfBox);
          ctx.stroke();
          // Top Right
          ctx.beginPath();
          ctx.moveTo(roi.x + halfBox - bracketLen, roi.y - halfBox);
          ctx.lineTo(roi.x + halfBox, roi.y - halfBox);
          ctx.lineTo(roi.x + halfBox, roi.y - halfBox + bracketLen);
          ctx.stroke();
          // Bottom Left
          ctx.beginPath();
          ctx.moveTo(roi.x - halfBox, roi.y + halfBox - bracketLen);
          ctx.lineTo(roi.x - halfBox, roi.y + halfBox);
          ctx.lineTo(roi.x - halfBox + bracketLen, roi.y + halfBox);
          ctx.stroke();
          // Bottom Right
          ctx.beginPath();
          ctx.moveTo(roi.x + halfBox - bracketLen, roi.y + halfBox);
          ctx.lineTo(roi.x + halfBox, roi.y + halfBox);
          ctx.lineTo(roi.x + halfBox, roi.y + halfBox - bracketLen);
          ctx.stroke();

          // Center crosshair dot
          ctx.beginPath();
          ctx.arc(roi.x, roi.y, 2, 0, 2 * Math.PI);
          ctx.fillStyle = pulseDetectedFlash ? '#34d399' : '#06b6d4';
          ctx.fill();

          // Pulse expansion ring animation
          if (pulseDetectedFlash) {
            ctx.beginPath();
            ctx.arc(roi.x, roi.y, halfBox + 8, 0, 2 * Math.PI);
            ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
            ctx.lineWidth = 2;
            ctx.stroke();
          }

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
    pilotScale
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

  return (
    <main className="min-h-screen bg-[#030712] text-zinc-100 p-4 md:p-6 lg:p-8 font-mono select-none">
      {/* Top Aerospace Header */}
      <header className="border-b border-cyan-900/40 pb-5 mb-6 flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-3.5">
          <div className="p-3 bg-cyan-950/80 border border-cyan-500/50 rounded-lg text-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.3)]">
            <Rocket className="w-7 h-7 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl md:text-2xl lg:text-3xl font-black tracking-widest text-zinc-100 uppercase">
                PROJECT CEILING DRIFT
              </h1>
              <span className="text-[10px] bg-cyan-950 text-cyan-400 border border-cyan-700/60 px-2 py-0.5 rounded font-bold">
                v2.0 HUD
              </span>
            </div>
            <p className="text-xs text-zinc-400 tracking-wider">
              AERODYNAMIC TELEMETRY & ORBITAL DISPLACEMENT OPTICAL TACHOMETER
            </p>
          </div>
        </div>

        {/* Global Controls & Status Bar */}
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          {/* Mission Elapsed Time */}
          <div className="bg-zinc-900/90 border border-zinc-700/70 px-3 py-1.5 rounded flex items-center gap-2">
            <span className="text-zinc-500 font-bold">MET:</span>
            <span className="text-cyan-400 font-black">{formatTime(missionElapsedTime)}</span>
          </div>

          {/* Sound Controls */}
          <div className="flex items-center bg-zinc-900/90 border border-zinc-700/70 rounded px-2 py-1 gap-2">
            <button
              id="sfx-toggle-btn"
              onClick={() => setAudioEnabled(!audioEnabled)}
              className="hover:text-cyan-300 transition flex items-center gap-1"
              title="Toggle Audio FX"
            >
              {audioEnabled ? <Volume2 className="w-3.5 h-3.5 text-emerald-400" /> : <VolumeX className="w-3.5 h-3.5 text-rose-400" />}
              <span className="text-[11px]">SFX: {audioEnabled ? 'ON' : 'OFF'}</span>
            </button>

            {audioEnabled && (
              <>
                <div className="h-3 w-px bg-zinc-700" />
                <button
                  id="turbine-audio-btn"
                  onClick={() => setTurbineAudioEnabled(!turbineAudioEnabled)}
                  className={`text-[11px] px-1.5 py-0.5 rounded transition font-bold ${
                    turbineAudioEnabled ? 'bg-cyan-950 text-cyan-300 border border-cyan-600' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Turbine drone sound follows live RPM pitch"
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

          {/* Live Status Indicator */}
          <div className="bg-zinc-900/90 border border-zinc-700/70 px-3 py-1.5 rounded flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${pulseDetectedFlash ? 'bg-emerald-400 scale-125' : 'bg-cyan-500 animate-ping'} transition-all`} />
            <span className="text-zinc-300 font-bold">{systemStatus}</span>
          </div>

          {/* STOP FAN (E-STOP) */}
          <button
            id="stop-fan-header-btn"
            onClick={handleStopFan}
            className="bg-rose-950 hover:bg-rose-900 border border-rose-600/80 hover:border-rose-400 text-rose-200 px-3 py-1.5 rounded flex items-center gap-1.5 font-black transition shadow-[0_0_15px_rgba(244,63,94,0.35)]"
            title="Emergency Fan Brake / Stop Fan Immediately"
          >
            <Power className="w-3.5 h-3.5 text-rose-400" />
            <span>STOP FAN</span>
          </button>

          {/* Calibration Drawer Toggle */}
          <button
            id="calibration-toggle-btn"
            onClick={() => setShowCalibration(!showCalibration)}
            className={`px-3 py-1.5 rounded border transition flex items-center gap-1.5 font-bold ${
              showCalibration 
                ? 'bg-amber-950 border-amber-600 text-amber-300' 
                : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-700 text-zinc-300'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>Calibration</span>
          </button>
        </div>
      </header>

      {/* Camera Permission Alert Banner */}
      {cameraError && (
        <div className="mb-6 p-3 bg-rose-950/70 border border-rose-600/60 rounded-lg text-xs text-rose-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{cameraError}</span>
          </div>
          <button
            onClick={() => setCameraError(null)}
            className="text-zinc-400 hover:text-zinc-100 font-bold px-2 py-0.5 bg-zinc-900 rounded"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Calibration Panel Drawer */}
      {showCalibration && (
        <section className="mb-6 bg-zinc-950 border border-amber-500/30 rounded-lg p-4 shadow-[0_0_20px_rgba(245,158,11,0.08)]">
          <div className="flex flex-wrap items-center justify-between pb-3 border-b border-zinc-800/80 mb-4 gap-2">
            <div className="flex items-center gap-2 text-amber-400 font-bold text-xs uppercase">
              <Sliders className="w-4 h-4" />
              <span>Optical Receptor Calibration & Waveform Tuning</span>
            </div>
            <span className="text-[11px] text-zinc-500">Tune sensitivity to eliminate false positives in varied room lighting</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 text-xs">
            {/* Blade Mode Selector */}
            <div>
              <label className="block text-zinc-400 mb-1.5 font-bold">Tracking Mode</label>
              <div className="flex flex-col gap-1.5">
                <button
                  onClick={() => setCalibrationMode('single_marker')}
                  className={`text-left px-2.5 py-1.5 rounded border transition ${
                    calibrationMode === 'single_marker'
                      ? 'bg-cyan-950 border-cyan-500 text-cyan-300 font-bold'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  Single Marker / Neon Tape (1 pulse = 1 rev)
                </button>
                <button
                  onClick={() => setCalibrationMode('symmetrical_blades')}
                  className={`text-left px-2.5 py-1.5 rounded border transition ${
                    calibrationMode === 'symmetrical_blades'
                      ? 'bg-cyan-950 border-cyan-500 text-cyan-300 font-bold'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  Symmetrical Blades (Divide by {bladeCount})
                </button>
              </div>

              {calibrationMode === 'symmetrical_blades' && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-zinc-500">Blades:</span>
                  {[3, 4, 5].map((cnt) => (
                    <button
                      key={cnt}
                      onClick={() => setBladeCount(cnt)}
                      className={`px-2 py-0.5 rounded border text-xs font-bold ${
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

            {/* Threshold & Sensitivity Slider */}
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
                Lower = More sensitive (good for low contrast). Higher = Rejects room flickers.
              </span>
            </div>

            {/* Refractory Period Slider */}
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

            {/* Sampling Aperture Box Size */}
            <div>
              <div className="flex justify-between text-zinc-400 mb-1.5">
                <span className="font-bold">Aperture Size</span>
                <span className="text-emerald-400 font-bold">{boxSize}×{boxSize} px</span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {[8, 16, 24, 32].map((sz) => (
                  <button
                    key={sz}
                    onClick={() => setBoxSize(sz)}
                    className={`py-1 rounded border text-center font-bold ${
                      boxSize === sz
                        ? 'bg-emerald-950 border-emerald-500 text-emerald-300'
                        : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    {sz}px
                  </button>
                ))}
              </div>

              {/* Mini Luma Oscilloscope */}
              <div className="mt-2">
                <div className="flex justify-between text-[10px] text-zinc-500 mb-0.5">
                  <span>LUMA SCOPE</span>
                  <span className="text-amber-500">-- TRIGGER THRESHOLD</span>
                </div>
                <canvas
                  ref={lumaScopeCanvasRef}
                  width={200}
                  height={32}
                  className="w-full h-8 bg-black/60 rounded border border-zinc-800"
                />
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Main Mission Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Optical Sensor Viewport & Simulation Controls */}
        <div className="lg:col-span-7 flex flex-col gap-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 shadow-[0_0_25px_rgba(0,0,0,0.6)]">
            <div className="flex flex-wrap justify-between items-center mb-3 text-xs gap-2">
              <span className="text-zinc-300 flex items-center gap-1.5 font-bold">
                <Crosshair className="w-4 h-4 text-cyan-400" />
                OPTICAL SENSOR VIEWPORT
              </span>
              <div className="flex items-center gap-3">
                <span className="text-zinc-400 text-[11px]">
                  {roi ? `TARGET: [X:${roi.x}, Y:${roi.y}]` : 'TARGET UNLOCKED (CLICK VIDEO)'}
                </span>
                <span className="text-[10px] bg-zinc-900 text-cyan-300 border border-zinc-700 px-2 py-0.5 rounded font-bold">
                  MODE: {feedMode.toUpperCase()}
                </span>
              </div>
            </div>

            {/* Canvas Viewport */}
            <div className="relative aspect-video bg-black rounded-lg border border-zinc-800 overflow-hidden flex items-center justify-center group">
              <canvas
                id="viewport-canvas"
                ref={canvasRef}
                width={640}
                height={360}
                onClick={handleCanvasClick}
                className="w-full h-full object-contain cursor-crosshair z-0"
              />
              <div className="pointer-events-none absolute inset-0 scanlines opacity-40 z-10" />

              {/* Live Target Reticle Indicator overlay */}
              {roi && (
                <div className="absolute top-2 left-2 z-20 pointer-events-none text-[10px] text-cyan-400/80 font-bold bg-black/50 px-2 py-0.5 rounded border border-cyan-900/50">
                  RECEPTOR LOCK ACTIVE // CLICK TO REPOSITION
                </div>
              )}

              {/* Hidden Video Feed */}
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

            {/* Quick Reticle Preset Repositioners */}
            <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-400">
              <span>Quick Reticle Reposition:</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setRoi({ x: 320, y: 180 })}
                  className="px-2 py-0.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded transition text-zinc-300"
                >
                  Center Hub
                </button>
                <button
                  onClick={() => setRoi({ x: 410, y: 180 })}
                  className="px-2 py-0.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded transition text-zinc-300"
                >
                  Right Blade Tip
                </button>
                <button
                  onClick={() => setRoi({ x: 320, y: 90 })}
                  className="px-2 py-0.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded transition text-zinc-300"
                >
                  Top Blade Tip
                </button>
              </div>
            </div>

            {/* Optical Sensor Inputs & Controls Toolbar */}
            <div className="mt-4 pt-3 border-t border-zinc-900 flex flex-wrap gap-2.5 items-center justify-between text-xs">
              <div className="flex flex-wrap items-center gap-2">
                {/* Live Webcam Engagement */}
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
                  className={`px-3 py-1.5 rounded flex items-center gap-1.5 font-bold transition border ${
                    feedMode === 'camera'
                      ? 'bg-rose-950 border-rose-600 text-rose-300'
                      : 'bg-cyan-950 hover:bg-cyan-900 border-cyan-600/60 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.15)]'
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
                    className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 px-2.5 py-1.5 rounded flex items-center gap-1 transition font-bold"
                    title="Flip camera between environment and front"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Flip: {cameraFacing === 'environment' ? 'Back' : 'Front'}</span>
                  </button>
                )}

                {/* Upload MP4 Video */}
                <label className="flex items-center gap-1.5 cursor-pointer bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 px-3 py-1.5 rounded transition text-zinc-300 font-bold">
                  <Upload className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Upload Video</span>
                  <input type="file" accept="video/mp4,video/webm" onChange={handleFileUpload} className="hidden" />
                </label>

                {/* Switch to Synthetic Matrix */}
                {feedMode !== 'synthetic' && (
                  <button
                    onClick={handleSwitchToSynthetic}
                    className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 px-3 py-1.5 rounded transition font-bold"
                  >
                    Simulation Mode
                  </button>
                )}
              </div>

              {/* Blade Diameter Input */}
              <div className="flex items-center gap-2 text-zinc-300 bg-zinc-900/80 px-2.5 py-1 rounded border border-zinc-800">
                <span className="text-zinc-500 font-bold">Span:</span>
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
                <span className="text-zinc-500 font-bold">m</span>
              </div>
            </div>

            {/* Video Play/Pause Control (if uploaded) */}
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
                  className="bg-emerald-950 hover:bg-emerald-900 border border-emerald-600 text-emerald-300 px-4 py-1.5 rounded flex items-center gap-2 transition text-xs font-bold"
                >
                  {isProcessing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  <span>{isProcessing ? 'Halt Telemetry' : 'Commence Analysis'}</span>
                </button>
                <span className="text-[11px] text-zinc-500">Video source loop ready</span>
              </div>
            )}
          </div>

          {/* Synthetic Simulation Controls (When in Synthetic Mode) */}
          {feedMode === 'synthetic' && (
            <div className="bg-zinc-950 border border-cyan-950/70 rounded-lg p-4">
              <div className="flex justify-between items-center mb-2.5 text-xs">
                <span className="text-zinc-300 flex items-center gap-1.5 font-bold">
                  <Zap className="w-4 h-4 text-cyan-400" />
                  SYNTHETIC FAN MOTOR CONTROLS
                </span>
                <span className="text-cyan-400 font-black">{syntheticTargetRpm} RPM TARGET</span>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="450"
                  step="5"
                  value={syntheticTargetRpm}
                  onChange={(e) => setSyntheticTargetRpm(parseInt(e.target.value, 10))}
                  className="w-full h-2 accent-cyan-400 bg-zinc-800 rounded cursor-pointer"
                />
              </div>

              {/* Speed Presets & Blade Configuration */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500 text-[11px]">Presets:</span>
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
                          ? 'bg-cyan-900 border-cyan-400 text-cyan-200'
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
                    <span>STOP FAN</span>
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500 text-[11px]">Synthetic Blades:</span>
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

          {/* Fan Leaf Passenger / Custom Picture Customizer Card */}
          <div className="bg-zinc-950 border border-purple-950/70 rounded-lg p-4 shadow-[0_0_15px_rgba(168,85,247,0.06)]">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3 text-xs">
              <div className="flex items-center gap-2 text-purple-400 font-bold">
                <UserPlus className="w-4 h-4" />
                <span className="uppercase tracking-wider">Fan Leaf Passenger / Custom Picture</span>
              </div>
              <span className="text-[11px] text-zinc-500">Clings to outer tip of blade #0</span>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs">
              {/* Passenger Avatar Thumbnail */}
              <div className="w-14 h-14 rounded-lg bg-zinc-900 border border-zinc-700 flex items-center justify-center overflow-hidden p-1 shrink-0 relative">
                <img
                  src={customPilotUrl}
                  alt="Blade Passenger"
                  className="w-full h-full object-contain"
                />
              </div>

              <div className="flex-1 flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Upload Custom Picture Button */}
                  <label className="bg-purple-950 hover:bg-purple-900 border border-purple-600/70 text-purple-200 px-3 py-1.5 rounded cursor-pointer flex items-center gap-1.5 font-bold transition shadow-[0_0_12px_rgba(168,85,247,0.15)]">
                    <Upload className="w-3.5 h-3.5 text-purple-400" />
                    <span>Upload Leaf Picture</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleCustomPilotUpload}
                      className="hidden"
                    />
                  </label>

                  {/* Reset to Default Picture */}
                  <button
                    onClick={handleResetPilotPic}
                    className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200 px-2.5 py-1.5 rounded transition text-[11px] font-bold"
                  >
                    Reset Pic
                  </button>

                  {/* Quick Projector Size Presets */}
                  <div className="flex flex-wrap items-center gap-1 bg-zinc-900/90 border border-zinc-800 p-1 rounded">
                    <span className="text-[10px] text-zinc-400 px-1 font-bold">PROJECTOR ZOOM:</span>
                    {[
                      { label: 'Normal (1x)', scale: 1.0 },
                      { label: 'Large (1.5x)', scale: 1.5 },
                      { label: '📽️ Projector (2.0x)', scale: 2.0 },
                      { label: 'Jumbo (2.5x)', scale: 2.5 },
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
                    <span className="text-zinc-400 font-bold">Custom Zoom:</span>
                    <input
                      type="range"
                      min="0.8"
                      max="2.8"
                      step="0.1"
                      value={pilotScale}
                      onChange={(e) => setPilotScale(parseFloat(e.target.value))}
                      className="w-28 h-1.5 accent-purple-400 bg-zinc-850 rounded cursor-pointer"
                      title="Adjust passenger photo scale for projector visibility"
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

          {/* Telemetry Frequency Oscillogram */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 shadow-[0_0_15px_rgba(0,0,0,0.5)]">
            <div className="flex justify-between items-center mb-2 text-xs">
              <span className="text-zinc-300 flex items-center gap-1.5 font-bold">
                <Activity className="w-4 h-4 text-cyan-400" />
                FREQUENCY OSCILLOGRAM
              </span>
              <div className="flex items-center gap-3">
                <span className="text-zinc-500">PEAK: <strong className="text-amber-400">{peakSessionRpm} RPM</strong></span>
                <span className="text-cyan-400 font-bold">{telemetry.rpm} RPM CURRENT</span>
              </div>
            </div>
            <canvas 
              ref={graphCanvasRef} 
              width={540} 
              height={75} 
              className="w-full h-18 bg-black/70 rounded border border-zinc-800/80" 
            />
          </div>
        </div>

        {/* Right Column: Aerospace Gauges & Mission Telemetry */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          {/* Radial SVG Tachometer Gauge Card */}
          <div className="bg-zinc-950 border border-zinc-800 p-5 rounded-lg shadow-[0_0_20px_rgba(0,0,0,0.5)] relative overflow-hidden">
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs text-zinc-400 flex items-center gap-1 font-bold">
                <RotateCw className="w-3.5 h-3.5 text-cyan-400" />
                ROTATIONAL VELOCITY TACHOMETER
              </span>
              <span className="text-[10px] bg-zinc-900 text-zinc-400 border border-zinc-700/80 px-2 py-0.5 rounded font-bold">
                ACCURACY: 99.4%
              </span>
            </div>

            {/* Radial Tachometer Dial Display */}
            <div className="relative flex flex-col items-center justify-center my-3">
              <svg viewBox="0 0 200 120" className="w-56 h-32 overflow-visible">
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

              <div className="text-center -mt-4">
                <div id="rpm-display" className="text-5xl font-black text-cyan-400 tracking-tight drop-shadow-[0_0_15px_rgba(6,182,212,0.4)]">
                  {telemetry.rpm}
                </div>
                <div className="text-[11px] text-zinc-400 font-bold uppercase tracking-wider">
                  REVOLUTIONS / MINUTE
                </div>
              </div>
            </div>
          </div>

          {/* Aerodynamic Speed & G-Force Twin Cards */}
          <div className="grid grid-cols-2 gap-4">
            {/* Linear Tip Speed */}
            <div className="bg-zinc-950 border border-zinc-800 p-4 rounded-lg shadow-[0_0_15px_rgba(0,0,0,0.5)]">
              <span className="text-xs text-zinc-400 flex items-center gap-1 font-bold">
                <Gauge className="w-3.5 h-3.5 text-emerald-400" />
                PERIPHERAL SPEED
              </span>
              <div className="my-2">
                <div id="speed-display" className="text-3xl font-black text-emerald-400 drop-shadow-[0_0_10px_rgba(16,185,129,0.4)]">
                  {telemetry.linearVelocityKmh}
                </div>
                <div className="text-[10px] text-zinc-500 font-bold">KM/H // {telemetry.linearVelocityMph} MPH</div>
              </div>
              <div className="w-full bg-zinc-900 h-1.5 rounded overflow-hidden">
                <div 
                  className="bg-emerald-500 h-full transition-all duration-200" 
                  style={{ width: `${Math.min((telemetry.linearVelocityKmh / 65) * 100, 100)}%` }} 
                />
              </div>
            </div>

            {/* Centripetal G-Force Stress Gauge */}
            <div className="bg-zinc-950 border border-zinc-800 p-4 rounded-lg shadow-[0_0_15px_rgba(0,0,0,0.5)]">
              <span className="text-xs text-zinc-400 flex items-center gap-1 font-bold">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                CENTRIPETAL G-FORCE
              </span>
              <div className="my-2">
                <div id="gforce-display" className="text-3xl font-black text-amber-400 drop-shadow-[0_0_10px_rgba(245,158,11,0.4)]">
                  {telemetry.centripetalG} G
                </div>
                <div className="text-[10px] text-zinc-500 font-bold">
                  {telemetry.centripetalG > 30 ? 'CRITICAL BLADE STRESS' : 'MOUNT INTEGRITY OK'}
                </div>
              </div>
              <div className="w-full bg-zinc-900 h-1.5 rounded overflow-hidden">
                <div 
                  className={`h-full transition-all duration-200 ${
                    telemetry.centripetalG > 30 ? 'bg-rose-500' : 'bg-amber-500'
                  }`} 
                  style={{ width: `${Math.min((telemetry.centripetalG / 50) * 100, 100)}%` }} 
                />
              </div>
            </div>
          </div>

          {/* Pointless Odometry Progression Card */}
          <div className="bg-zinc-950 border border-zinc-800 p-4 rounded-lg">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-zinc-400 flex items-center gap-1.5 font-bold">
                <Compass className="w-4 h-4 text-amber-400" />
                ACCUMULATED POINTLESS ODOMETRY
              </span>
              <span className="text-[10px] text-zinc-500 font-bold">{telemetry.cumulativeRotations} ROTATIONS</span>
            </div>

            <div className="flex items-baseline gap-2">
              <span id="meters-display" className="text-4xl font-black text-amber-400 drop-shadow-[0_0_12px_rgba(245,158,11,0.3)]">
                {telemetry.totalDistanceMeters}
              </span>
              <span className="text-xs text-zinc-500 font-bold">METERS FLOWN IN PLACE</span>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 text-xs border-t border-zinc-800/80 pt-3 text-zinc-400">
              <div>
                <span className="text-zinc-500 text-[10px] block">Everest Climbs:</span>
                <span className="text-zinc-200 font-bold">{telemetry.everestClimbsEquivalent} summits</span>
              </div>
              <div>
                <span className="text-zinc-500 text-[10px] block">Lunar Transit:</span>
                <span className="text-cyan-400 font-bold">{telemetry.moonProgressPct.toFixed(6)}%</span>
              </div>
              <div>
                <span className="text-zinc-500 text-[10px] block">Mach Number:</span>
                <span className="text-emerald-400 font-bold">M {telemetry.machNumber}</span>
              </div>
            </div>
          </div>

          {/* Aerodynamic Hazard Tier & Certificate Trigger */}
          <div className="bg-zinc-950 border border-cyan-900/40 p-4 rounded-lg relative overflow-hidden">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1 text-[10px] uppercase text-cyan-400 font-bold">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Aero Rating: {activeTier.hazardLevel}</span>
              </div>
              <span className="text-[10px] text-zinc-500 font-mono">CALLSIGN: {activeTier.callsign}</span>
            </div>
            
            <h3 id="tier-title" className="text-lg font-black text-zinc-100">{activeTier.title}</h3>
            <p className="text-xs text-zinc-400 mt-1 italic">"{activeTier.description}"</p>

            <button 
              id="log-flight-btn"
              onClick={handleOpenCertificateModal}
              className="mt-4 w-full bg-cyan-950 hover:bg-cyan-900 border border-cyan-600/60 hover:border-cyan-400 text-xs py-2.5 rounded text-cyan-200 transition font-bold flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(6,182,212,0.2)]"
            >
              <Award className="w-4 h-4 text-cyan-400" />
              <span>Log Mission & Issue Flight Diploma</span>
            </button>
          </div>
        </div>
      </div>

      {/* Global Standings & Flight Records Table */}
      <section className="mt-8 bg-zinc-950 border border-zinc-800 rounded-lg p-4 md:p-6 shadow-[0_0_20px_rgba(0,0,0,0.5)]">
        <div className="flex flex-wrap items-center justify-between mb-4 gap-3">
          <div className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-amber-400" />
            <h2 className="text-sm font-bold tracking-wider uppercase text-zinc-200">
              Global Orbital Ceiling Standings
            </h2>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={handleExportCsv}
              className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 px-3 py-1.5 rounded flex items-center gap-1.5 transition text-zinc-300 font-bold"
              title="Export Standings as CSV file"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span>Export CSV</span>
            </button>
            <button
              onClick={handleClearStandings}
              className="bg-zinc-900 hover:bg-rose-950/60 border border-zinc-700 hover:border-rose-600/60 px-3 py-1.5 rounded flex items-center gap-1.5 transition text-zinc-400 hover:text-rose-300 font-bold"
              title="Purge all logged missions"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
              <span>Clear</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 font-bold">
                <th className="pb-2.5">FAN CODENAME</th>
                <th className="pb-2.5">PILOT CALLSIGN</th>
                <th className="pb-2.5">CLASSIFICATION</th>
                <th className="pb-2.5">PEAK RPM</th>
                <th className="pb-2.5">TIP SPEED</th>
                <th className="pb-2.5">CENTRIPETAL G</th>
                <th className="pb-2.5">DISPLACEMENT</th>
                <th className="pb-2.5">RECORDED AT</th>
              </tr>
            </thead>
            <tbody id="leaderboard-body" className="divide-y divide-zinc-900">
              {leaderboard.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-zinc-500 italic">
                    No flight missions recorded yet. Engage telemetry and click 'Log Mission'!
                  </td>
                </tr>
              ) : (
                leaderboard.map((item) => (
                  <tr key={item.id} className="hover:bg-zinc-900/50 transition">
                    <td className="py-2.5 font-bold text-zinc-100">{item.fanCodename}</td>
                    <td className="py-2.5 text-zinc-400 font-mono">{item.pilotCallsign}</td>
                    <td className="py-2.5 text-cyan-400 font-bold">{item.assignedTier}</td>
                    <td className="py-2.5 text-zinc-300 font-bold">{item.peakRpm} RPM</td>
                    <td className="py-2.5 text-emerald-400">{item.maxSpeedKmh} km/h</td>
                    <td className="py-2.5 text-amber-400">{item.centripetalG ? `${item.centripetalG} G` : 'N/A'}</td>
                    <td className="py-2.5 text-amber-300 font-bold">{item.totalDistanceKm} km</td>
                    <td className="py-2.5 text-zinc-500">{item.recordedAt}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Flight Qualification Certificate Modal */}
      {showCertificateModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-cyan-500/50 rounded-xl max-w-lg w-full p-6 shadow-[0_0_40px_rgba(6,182,212,0.25)] flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Award className="w-5 h-5 text-cyan-400" />
                <h3 className="font-black text-sm uppercase tracking-wider text-zinc-100">
                  Mission Flight Diploma Formulation
                </h3>
              </div>
              <button
                onClick={() => setShowCertificateModal(false)}
                className="text-zinc-500 hover:text-zinc-200 text-xs font-bold"
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
                  className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 rounded text-cyan-300 font-bold focus:outline-none focus:border-cyan-500"
                  placeholder="e.g. Flight Officer Babu"
                />
              </div>

              <div>
                <label className="block text-zinc-400 font-bold mb-1">Ceiling Fan Codename</label>
                <input
                  type="text"
                  value={fanCodename}
                  onChange={(e) => setFanCodename(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 rounded text-zinc-200 font-bold focus:outline-none focus:border-cyan-500"
                  placeholder="e.g. Havells Stealth Air GT-500"
                />
              </div>
            </div>

            {/* Quick Summary Preview */}
            <div className="bg-zinc-900/70 border border-zinc-800 p-3 rounded text-xs space-y-1.5">
              <div className="flex justify-between">
                <span className="text-zinc-500">Achieved Peak RPM:</span>
                <span className="font-bold text-cyan-400">{peakSessionRpm || telemetry.rpm} RPM</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Max Peripheral Velocity:</span>
                <span className="font-bold text-emerald-400">{telemetry.linearVelocityKmh} KM/H</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Centripetal Stress:</span>
                <span className="font-bold text-amber-400">{telemetry.centripetalG} G</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Displacement Flown:</span>
                <span className="font-bold text-amber-300">{telemetry.totalDistanceMeters} Meters</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Flight Classification:</span>
                <span className="font-bold text-zinc-200">{activeTier.title}</span>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              <button
                onClick={handleDownloadCertificate}
                className="flex-1 bg-zinc-900 hover:bg-zinc-800 border border-amber-600/60 hover:border-amber-400 text-amber-300 py-2 rounded text-xs font-bold flex items-center justify-center gap-2 transition"
              >
                <Download className="w-4 h-4" />
                <span>Download PNG Certificate</span>
              </button>
              <button
                onClick={handleSaveFlight}
                className="flex-1 bg-cyan-950 hover:bg-cyan-900 border border-cyan-500 text-cyan-200 py-2 rounded text-xs font-black flex items-center justify-center gap-2 transition shadow-[0_0_15px_rgba(6,182,212,0.3)]"
              >
                <Award className="w-4 h-4 text-cyan-400" />
                <span>Log to Leaderboard</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
