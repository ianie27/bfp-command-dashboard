// src/services/fireAlarmService.ts
class FireAlarmService {
  private static instance: FireAlarmService;
  private alarmSound: HTMLAudioElement | null = null;
  private sirenInterval: number | null = null;
  private isPlaying: boolean = false;
  private onAlarmStateChange?: (isActive: boolean) => void;

  private constructor() {
    this.initAudio();
  }

  public static getInstance(): FireAlarmService {
    if (!FireAlarmService.instance) {
      FireAlarmService.instance = new FireAlarmService();
    }
    return FireAlarmService.instance;
  }

  private initAudio(): void {
    // Create realistic siren sound using Web Audio API
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Create oscillator for the siren
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      // Siren parameters - realistic fire truck siren
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
      
      // Create a custom audio element with the siren
      this.alarmSound = new Audio();
      
      // Generate siren using Web Audio API and export to AudioBuffer
      const sampleRate = 44100;
      const duration = 60; // 1 minute
      const numSamples = sampleRate * duration;
      const audioBuffer = audioContext.createBuffer(1, numSamples, sampleRate);
      const data = audioBuffer.getChannelData(0);
      
      // Generate realistic siren sound
      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        // Siren sweep: alternates between two frequencies
        const sweep = Math.sin(t * 2 * Math.PI * 0.8); // 0.8 Hz sweep
        const frequency = 400 + 200 * sweep;
        // Add harmonics for realistic sound
        let sample = 0;
        for (let harmonic = 1; harmonic <= 5; harmonic += 2) {
          sample += Math.sin(2 * Math.PI * frequency * harmonic * t) / harmonic;
        }
        // Add amplitude modulation for realism
        const amplitude = 0.3 + 0.2 * Math.sin(2 * Math.PI * 2 * t);
        data[i] = sample * amplitude * 0.3;
      }
      
      // Convert to audio element
      const blob = this.audioBufferToBlob(audioBuffer);
      const url = URL.createObjectURL(blob);
      this.alarmSound.src = url;
      this.alarmSound.loop = true;
      this.alarmSound.volume = 0.8;
      
    } catch (error) {
      console.warn('Web Audio API not fully supported, using fallback:', error);
      this.createFallbackSound();
    }
  }

  private audioBufferToBlob(buffer: AudioBuffer): Blob {
    // Convert AudioBuffer to WAV blob
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length * numChannels * 2;
    const data = new DataView(new ArrayBuffer(44 + length));
    
    // Write WAV header
    this.writeString(data, 0, 'RIFF');
    data.setUint32(4, 36 + length, true);
    this.writeString(data, 8, 'WAVE');
    this.writeString(data, 12, 'fmt ');
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, numChannels, true);
    data.setUint32(24, sampleRate, true);
    data.setUint32(28, sampleRate * numChannels * 2, true);
    data.setUint16(32, numChannels * 2, true);
    data.setUint16(34, 16, true);
    this.writeString(data, 36, 'data');
    data.setUint32(40, length, true);
    
    // Write audio data
    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let channel = 0; channel < numChannels; channel++) {
        const sample = buffer.getChannelData(channel)[i];
        const intSample = Math.max(-1, Math.min(1, sample)) * 0x7FFF;
        data.setInt16(offset, intSample, true);
        offset += 2;
      }
    }
    
    return new Blob([data.buffer], { type: 'audio/wav' });
  }

  private writeString(data: DataView, offset: number, string: string): void {
    for (let i = 0; i < string.length; i++) {
      data.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  private createFallbackSound(): void {
    // Fallback using oscillator-based sound
    this.alarmSound = new Audio();
    // Use an online siren sound as fallback
    this.alarmSound.src = 'data:audio/wav;base64,UklGRlwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQwAAACAgICA/////////////////////////////////////////////////////////////////////////8DAwP8='; // Simple beep as fallback
    this.alarmSound.loop = true;
    this.alarmSound.volume = 0.5;
  }

  public triggerAlarm(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    
    if (this.alarmSound) {
      this.alarmSound.currentTime = 0;
      this.alarmSound.play().catch(() => {
        // If autoplay fails, try to resume with user interaction
        document.addEventListener('click', () => {
          this.alarmSound?.play();
        }, { once: true });
      });
    }
    
    // Vibrate for mobile devices
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200, 100, 200, 500]);
    }
    
    if (this.onAlarmStateChange) {
      this.onAlarmStateChange(true);
    }
  }

  public stopAlarm(): void {
    if (this.alarmSound) {
      this.alarmSound.pause();
      this.alarmSound.currentTime = 0;
    }
    this.isPlaying = false;
    
    if (this.onAlarmStateChange) {
      this.onAlarmStateChange(false);
    }
  }

  public isAlarmActive(): boolean {
    return this.isPlaying;
  }

  public setOnAlarmStateChange(callback: (isActive: boolean) => void): void {
    this.onAlarmStateChange = callback;
  }
}

export default FireAlarmService;