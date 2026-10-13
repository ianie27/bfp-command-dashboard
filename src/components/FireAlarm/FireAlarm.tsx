// src/components/FireAlarm/FireAlarm.tsx
import React, { useEffect, useState, useRef } from 'react';
import { Button, Container } from 'react-bootstrap';
import { 
  FaFire, FaExclamationTriangle, FaVolumeMute, FaBullhorn,
  FaPhone, FaMapMarkerAlt, FaClock, FaUsers, FaTruck
} from 'react-icons/fa';
import FireAlarmService from '../../services/fireAlarmService';
import './FireAlarm.scss';

interface FireAlarmProps {
  onSilence?: () => void;
  onTrigger?: () => void;
  autoStart?: boolean;
}

const FireAlarm: React.FC<FireAlarmProps> = ({ 
  onSilence, 
  onTrigger,
  autoStart = false 
}) => {
  const [isActive, setIsActive] = useState(false);
  const [timeLeft, setTimeLeft] = useState(60);
  const [blink, setBlink] = useState(true);
  const [flashIntensity, setFlashIntensity] = useState(1);
  const intervalRef = useRef<number | null>(null);
  const flashRef = useRef<number | null>(null);
  const alarmService = FireAlarmService.getInstance();

  useEffect(() => {
    // Set up alarm state listener
    alarmService.setOnAlarmStateChange((active) => {
      setIsActive(active);
      if (!active) {
        setTimeLeft(0);
        clearInterval(intervalRef.current!);
        clearInterval(flashRef.current!);
      }
    });

    // Auto-start if enabled
    if (autoStart) {
      triggerAlarm();
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (flashRef.current) clearInterval(flashRef.current);
      alarmService.stopAlarm();
    };
  }, [autoStart]);

  useEffect(() => {
    if (isActive) {
      // Start countdown
      intervalRef.current = window.setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            // Auto-stop after 1 minute
            handleSilence();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      // Blink effect for UI
      flashRef.current = window.setInterval(() => {
        setBlink((prev) => !prev);
        setFlashIntensity((prev) => prev === 1 ? 0.3 : 1);
      }, 500);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (flashRef.current) clearInterval(flashRef.current);
    };
  }, [isActive]);

  const triggerAlarm = () => {
    alarmService.triggerAlarm();
    setIsActive(true);
    setTimeLeft(60);
    if (onTrigger) onTrigger();
  };

  const handleSilence = () => {
    alarmService.stopAlarm();
    setIsActive(false);
    setTimeLeft(0);
    if (onSilence) onSilence();
  };

  if (!isActive) {
    return (
      <div className="fire-alarm-trigger">
        <Button 
          onClick={triggerAlarm}
          className="trigger-btn"
          size="lg"
        >
          <FaBullhorn className="me-2" />
          TRIGGER STATION ALARM
        </Button>
        <p className="mt-3 text-muted small">
          ⚠️ Emergency evacuation will be initiated
        </p>
      </div>
    );
  }

  return (
    <div className="fire-alarm-fullscreen">
      {/* Background Flash Effect */}
      <div className={`flash-overlay ${blink ? 'flash' : ''}`} />
      
      {/* Rotating Red Alert Bars */}
      <div className="alert-bars">
        <div className="alert-bar bar-1" />
        <div className="alert-bar bar-2" />
        <div className="alert-bar bar-3" />
        <div className="alert-bar bar-4" />
      </div>

      {/* Main Content */}
      <Container className="alarm-content">
        <div className="alarm-icon">
          <FaFire className="fire-icon" />
          <div className="pulse-ring ring-1" />
          <div className="pulse-ring ring-2" />
          <div className="pulse-ring ring-3" />
        </div>

        <h1 className="alarm-title">
          <span className="blink-text">🚨</span> FIRE STATION ALARM
          <span className="blink-text">🚨</span>
        </h1>

        <div className="alarm-status">
          <div className="status-indicator">
            <span className={`status-dot ${blink ? 'active' : ''}`} />
            ACTIVE
          </div>
          <div className="countdown">
            <FaClock className="me-2" />
            {timeLeft}s
          </div>
        </div>

        <div className="alarm-message">
          <FaExclamationTriangle className="me-2" />
          EMERGENCY EVACUATION PROCEDURE INITIATED
        </div>

        <div className="alarm-actions">
          <Button 
            variant="danger" 
            className="silence-btn"
            onClick={handleSilence}
          >
            <FaVolumeMute className="me-2" />
            SILENCE ALARM
          </Button>
        </div>

        <div className="alarm-info">
          <div className="info-item">
            <FaMapMarkerAlt className="me-2" />
            Gonzaga Fire Station
          </div>
          <div className="info-item">
            <FaTruck className="me-2" />
            All Units Responding
          </div>
          <div className="info-item">
            <FaUsers className="me-2" />
            Emergency Personnel En Route
          </div>
          <div className="info-item">
            <FaPhone className="me-2" />
            Call 911 for Assistance
          </div>
        </div>
      </Container>

      {/* Siren Wave Animation */}
      <div className="siren-waves">
        <div className="wave wave-1" />
        <div className="wave wave-2" />
        <div className="wave wave-3" />
        <div className="wave wave-4" />
      </div>
    </div>
  );
};

export default FireAlarm;