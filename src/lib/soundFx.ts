class MissionAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private droneOsc: OscillatorNode | null = null;
  private droneGain: GainNode | null = null;
  public enabled: boolean = true;
  public turbineAudioEnabled: boolean = false;
  public volume: number = 0.4;

  private init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setVolume(newVol: number) {
    this.volume = Math.max(0, Math.min(1, newVol));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  playBladePassBlip(customPitch = 880) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || !this.masterGain) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(customPitch, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(220, this.ctx.currentTime + 0.035);

      gain.gain.setValueAtTime(0.06, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.035);

      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start();
      osc.stop(this.ctx.currentTime + 0.035);
    } catch {
      // Audio policy catch
    }
  }

  updateTurbineDrone(rpm: number) {
    if (!this.enabled || !this.turbineAudioEnabled) {
      this.stopTurbineDrone();
      return;
    }

    this.init();
    if (!this.ctx || !this.masterGain) return;

    try {
      if (!this.droneOsc) {
        this.droneOsc = this.ctx.createOscillator();
        this.droneGain = this.ctx.createGain();

        this.droneOsc.type = 'sawtooth';
        this.droneGain.gain.setValueAtTime(0.001, this.ctx.currentTime);

        // Low-pass filter for smooth jet turbine timbre
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(320, this.ctx.currentTime);

        this.droneOsc.connect(filter);
        filter.connect(this.droneGain);
        this.droneGain.connect(this.masterGain);

        this.droneOsc.start();
      }

      if (this.droneOsc && this.droneGain) {
        if (rpm <= 10) {
          this.droneGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.2);
        } else {
          // Pitch scales with RPM: 40Hz at 20 RPM up to 380Hz at 400 RPM
          const targetFreq = 40 + Math.min(rpm, 600) * 0.75;
          const targetVol = Math.min(0.08, 0.01 + (rpm / 500) * 0.07);

          this.droneOsc.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.1);
          this.droneGain.gain.setTargetAtTime(targetVol, this.ctx.currentTime, 0.15);
        }
      }
    } catch {
      // Audio policy catch
    }
  }

  stopTurbineDrone() {
    if (this.droneGain && this.ctx) {
      this.droneGain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    }
  }

  playHazardAlarm() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || !this.masterGain) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'square';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.setValueAtTime(600, now + 0.1);
      osc.frequency.setValueAtTime(800, now + 0.2);

      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start();
      osc.stop(now + 0.35);
    } catch {
      // Audio policy catch
    }
  }

  playMissionLoggedChime() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || !this.masterGain) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, this.ctx.currentTime);
      osc.frequency.setValueAtTime(659.25, this.ctx.currentTime + 0.08);
      osc.frequency.setValueAtTime(783.99, this.ctx.currentTime + 0.16);
      osc.frequency.setValueAtTime(1046.5, this.ctx.currentTime + 0.24);

      gain.gain.setValueAtTime(0.09, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.4);

      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start();
      osc.stop(this.ctx.currentTime + 0.4);
    } catch {
      // Audio policy catch
    }
  }
}

export const missionAudio = new MissionAudioEngine();

