// src/services/mobileBridge.ts
import { io, Socket } from 'socket.io-client';

interface MobileEvent {
  type: 'incident' | 'unit' | 'sensor' | 'dispatch';
  action: 'create' | 'update' | 'delete';
  data: any;
  timestamp: string;
}

class MobileBridge {
  private socket: Socket | null = null;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private eventListeners: Map<string, ((data: any) => void)[]> = new Map();

  constructor() {
    this.initSocket();
  }

  private initSocket() {
    const wsUrl = import.meta.env.VITE_WS_URL || 'http://localhost:5000';
    
    this.socket = io(wsUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });

    this.socket.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log('✅ Connected to mobile bridge');
      this.emitEvent('bridge_connected', { status: 'connected' });
    });

    this.socket.on('disconnect', () => {
      this.connected = false;
      console.log('❌ Disconnected from mobile bridge');
    });

    this.socket.on('mobile_event', (event: MobileEvent) => {
      this.handleMobileEvent(event);
    });

    this.socket.on('reconnect_attempt', (attempt: number) => {
      this.reconnectAttempts = attempt;
      console.log(`🔄 Reconnection attempt ${attempt}`);
    });
  }

  private handleMobileEvent(event: MobileEvent) {
    const listeners = this.eventListeners.get(event.type) || [];
    listeners.forEach(callback => {
      callback({ ...event, source: 'mobile' });
    });
  }

  public on(eventType: string, callback: (data: any) => void): () => void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, []);
    }
    this.eventListeners.get(eventType)!.push(callback);
    
    // Return unsubscribe function
    return () => {
      const listeners = this.eventListeners.get(eventType) || [];
      const index = listeners.indexOf(callback);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }

  public emitEvent(event: string, data: any) {
    if (this.socket && this.connected) {
      this.socket.emit(event, data);
    } else {
      console.warn('⚠️ Socket not connected, event not sent:', event);
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
    }
  }
}

export const mobileBridge = new MobileBridge();
export default mobileBridge;