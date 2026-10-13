// src/components/ConnectionStatus.tsx
import React, { useEffect, useState } from 'react';
import { Badge } from 'react-bootstrap';
import { FaWifi, FaExclamationTriangle, FaSync } from 'react-icons/fa';
import { firestore } from '../services/firebase';
import { doc, getDoc } from 'firebase/firestore';

interface ConnectionStatusProps {
  showLabel?: boolean;
  compact?: boolean;
}

const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  showLabel = true,
  compact = false,
}) => {
  const [isConnected, setIsConnected] = useState<boolean>(true);
  const [lastCheck, setLastCheck] = useState<Date>(new Date());
  const [checking, setChecking] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    const checkConnection = async () => {
      if (checking) return;
      setChecking(true);

      try {
        // Use a real Firestore doc reference (2 args only)
        const testRef = doc(firestore, 'test/connection_test');
        await getDoc(testRef);
        if (!cancelled) {
          setIsConnected(true);
          setLastCheck(new Date());
        }
      } catch (error) {
        console.warn('Firestore connection check failed:', error);
        if (!cancelled) {
          setIsConnected(false);
          setLastCheck(new Date());
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    };

    checkConnection();
    const interval = setInterval(checkConnection, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (compact) {
    return (
      <div className="d-flex align-items-center">
        <div
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            backgroundColor: isConnected ? '#28a745' : '#dc3545',
            marginRight: '6px',
            boxShadow: isConnected
              ? '0 0 10px rgba(40, 167, 69, 0.5)'
              : '0 0 10px rgba(220, 53, 69, 0.5)',
          }}
        />
        {showLabel && (
          <span
            style={{
              fontSize: '12px',
              color: isConnected ? '#28a745' : '#dc3545',
            }}
          >
            {isConnected ? 'Online' : 'Offline'}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="d-flex align-items-center">
      {isConnected ? (
        <Badge bg="success" className="px-3 py-2 d-flex align-items-center gap-2">
          <FaWifi />
          {showLabel ? 'Connected to Mobile App' : 'Online'}
        </Badge>
      ) : (
        <Badge bg="danger" className="px-3 py-2 d-flex align-items-center gap-2">
          <FaExclamationTriangle />
          {showLabel ? 'Disconnected from Mobile App' : 'Offline'}
        </Badge>
      )}
      {showLabel && (
        <small className="text-muted ms-2" style={{ fontSize: '11px' }}>
          <FaSync className={`me-1 ${checking ? 'spin' : ''}`} />
          Last sync: {lastCheck.toLocaleTimeString()}
        </small>
      )}
    </div>
  );
};

export default ConnectionStatus;