// src/components/CallManagement/CallManagement.tsx
import React, { useEffect, useState, useRef } from 'react';
import { Card, Badge, Button, Alert, Row, Col, Spinner } from 'react-bootstrap';
import { 
  FaPhone, FaPhoneAlt, FaPhoneSlash, FaMapMarkerAlt, 
  FaUser, FaClock, FaExclamationTriangle, FaSpinner,
  FaHeadset, FaMobile, FaGlobe, FaCheckCircle
} from 'react-icons/fa';
import { firestore, collection, doc, onSnapshot, updateDoc, addDoc } from '../../services/firebase';
import toast from 'react-hot-toast';

interface CallData {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  hotline: string;
  status: 'initiating' | 'connecting' | 'connected' | 'ended' | 'failed' | 'cancelled';
  startTime: number;
  endTime?: number;
  connectedAt?: string;
  latitude: number;
  longitude: number;
  location?: any;
  dispatcherId?: string;
  dispatcherName?: string;
  source: 'mobile_app' | 'web';
  reportId?: string;
  lastLocationUpdate?: number;
}

interface CallManagementProps {
  onCallAccepted?: (callId: string) => void;
  onCallEnded?: (callId: string) => void;
  onCallLocationUpdate?: (callId: string, lat: number, lng: number) => void;
}

const CALL_STATUS_COLLECTION = 'active_calls';

const CallManagement: React.FC<CallManagementProps> = ({ 
  onCallAccepted, 
  onCallEnded,
  onCallLocationUpdate 
}) => {
  const [activeCalls, setActiveCalls] = useState<CallData[]>([]);
  const [selectedCall, setSelectedCall] = useState<CallData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRinging, setIsRinging] = useState(false);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [oscillator, setOscillator] = useState<OscillatorNode | null>(null);
  const [gainNode, setGainNode] = useState<GainNode | null>(null);

  useEffect(() => {
    // Subscribe to active calls
    const unsubscribe = onSnapshot(
      collection(firestore, CALL_STATUS_COLLECTION),
      (snapshot) => {
        const calls: CallData[] = [];
        snapshot.forEach((docSnapshot) => {
          const data = docSnapshot.data();
          calls.push({
            id: docSnapshot.id,
            ...data,
            status: data.status || 'initiating',
            latitude: data.latitude || 0,
            longitude: data.longitude || 0,
          } as CallData);
        });

        calls.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        setActiveCalls(calls);
        setLoading(false);

        // Check for incoming calls
        const incomingCalls = calls.filter(c => c.status === 'initiating' || c.status === 'connecting');
        if (incomingCalls.length > 0 && !isRinging) {
          setIsRinging(true);
          playRingtone();
        } else if (incomingCalls.length === 0 && isRinging) {
          setIsRinging(false);
          stopRingtone();
        }

        // Auto-accept emergency calls
        const autoAcceptCalls = calls.filter(
          call => call.status === 'initiating' && 
          call.latitude && call.longitude && 
          call.source === 'mobile_app'
        );

        autoAcceptCalls.forEach(call => {
          setTimeout(() => {
            acceptCall(call);
            toast.success(`📞 Auto-connected to ${call.userName || 'Citizen'}`, {
              icon: '🚨',
              duration: 5000,
            });
          }, 1000);
        });
      },
      (error) => {
        console.error('Error listening to calls:', error);
        setLoading(false);
      }
    );

    return () => {
      unsubscribe();
      stopRingtone();
      if (audioContext) {
        audioContext.close();
      }
    };
  }, []);

  const playRingtone = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      setAudioContext(ctx);

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime);

      let isActive = true;
      const ringPattern = () => {
        if (!isActive) return;
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        setTimeout(() => {
          gain.gain.setValueAtTime(0, ctx.currentTime);
          setTimeout(ringPattern, 500);
        }, 1000);
      };

      osc.start();
      ringPattern();

      setOscillator(osc);
      setGainNode(gain);

      (osc as any)._stop = () => {
        isActive = false;
        osc.stop();
        osc.disconnect();
      };

    } catch (error) {
      console.warn('Audio play failed:', error);
    }
  };

  const stopRingtone = () => {
    if (oscillator) {
      (oscillator as any)._stop?.();
      setOscillator(null);
    }
    if (gainNode) {
      gainNode.disconnect();
      setGainNode(null);
    }
    if (audioContext) {
      audioContext.close();
      setAudioContext(null);
    }
  };

  const acceptCall = async (call: CallData) => {
    try {
      await updateDoc(doc(firestore, CALL_STATUS_COLLECTION, call.id), {
        status: 'connected',
        dispatcherId: 'dispatcher',
        dispatcherName: 'BFP Dispatcher',
        connectedAt: new Date().toISOString(),
      });

      setSelectedCall(call);
      toast.success(`✅ Connected to ${call.userName || 'Citizen'}`);
      
      if (onCallAccepted) {
        onCallAccepted(call.id);
      }

      await addDoc(collection(firestore, 'audit_logs'), {
        action: 'accept_call',
        entity_type: 'call',
        entity_id: call.id,
        user_id: 'dispatcher',
        timestamp: new Date().toISOString(),
        details: {
          callerName: call.userName,
          callerEmail: call.userEmail,
          location: { lat: call.latitude, lng: call.longitude },
        }
      });

    } catch (error) {
      console.error('Error accepting call:', error);
      toast.error('Failed to accept call');
    }
  };

  const endCall = async (call: CallData) => {
    try {
      await updateDoc(doc(firestore, CALL_STATUS_COLLECTION, call.id), {
        status: 'ended',
        endTime: new Date().toISOString(),
      });

      toast.success(`📞 Call with ${call.userName || 'Citizen'} ended`, {
        icon: '📴',
        duration: 3000,
      });
      
      if (onCallEnded) {
        onCallEnded(call.id);
      }

      setSelectedCall(null);

      await addDoc(collection(firestore, 'audit_logs'), {
        action: 'end_call',
        entity_type: 'call',
        entity_id: call.id,
        user_id: 'dispatcher',
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      console.error('Error ending call:', error);
      toast.error('Failed to end call');
    }
  };

  const openInMap = (lat: number, lng: number) => {
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, string> = {
      initiating: 'warning',
      connecting: 'info',
      connected: 'success',
      ended: 'secondary',
      failed: 'danger',
      cancelled: 'danger',
    };
    const labels: Record<string, string> = {
      initiating: '📞 Calling...',
      connecting: '🔄 Connecting',
      connected: '✅ Connected',
      ended: '📴 Ended',
      failed: '❌ Failed',
      cancelled: '🚫 Cancelled',
    };
    return <Badge bg={variants[status] || 'secondary'}>{labels[status] || status}</Badge>;
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getCallDuration = (call: CallData) => {
    const start = call.startTime;
    const end = call.endTime || Date.now();
    const diff = Math.floor((end - start) / 1000);
    const mins = Math.floor(diff / 60);
    const secs = diff % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getSourceIcon = (source: string) => {
    if (source === 'mobile_app') {
      return <FaMobile className="me-1" />;
    }
    return <FaGlobe className="me-1" />;
  };

  if (loading) {
    return (
      <div className="text-center py-4">
        <FaSpinner className="spin" size={30} />
        <p className="mt-2 text-muted">Loading calls...</p>
      </div>
    );
  }

  const incomingCalls = activeCalls.filter(c => c.status === 'initiating' || c.status === 'connecting');
  const activeCallsList = activeCalls.filter(c => c.status === 'connected');

  return (
    <div className="call-management">
      <style>{`
        .pulse-text {
          animation: pulse 1s ease-in-out infinite;
          color: #dc3545;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .call-card {
          transition: all 0.3s ease;
          border: 1px solid rgba(255,255,255,0.1);
          cursor: pointer;
        }
        .call-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 25px rgba(0,0,0,0.3);
        }
        .call-card.incoming {
          border-color: #dc3545;
          border-width: 2px;
          animation: glow 1.5s ease-in-out infinite;
        }
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 10px rgba(220,53,69,0.2); }
          50% { box-shadow: 0 0 30px rgba(220,53,69,0.4); }
        }
        .call-card.active {
          border-color: #28a745;
          border-width: 2px;
        }
        .location-badge {
          cursor: pointer;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
        }
        .location-badge:hover {
          color: #0d6efd !important;
          transform: scale(1.05);
        }
        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .call-source {
          font-size: 0.75rem;
          color: rgba(255,255,255,0.5);
        }
      `}</style>

      {/* Incoming Calls Alert */}
      {incomingCalls.length > 0 && (
        <Alert variant="danger" className="mb-3">
          <div className="d-flex align-items-center">
            <FaExclamationTriangle className="me-2" size={24} />
            <div>
              <strong>{incomingCalls.length} Incoming Emergency Call{incomingCalls.length > 1 ? 's' : ''}</strong>
              <span className="ms-2 pulse-text">🔴 LIVE</span>
            </div>
            <div className="ms-auto">
              <Badge bg="light" text="dark">
                {incomingCalls.length} waiting
              </Badge>
            </div>
          </div>
        </Alert>
      )}

      <Row className="g-3">
        {/* Incoming Calls */}
        {incomingCalls.map(call => (
          <Col key={call.id} md={6} lg={4}>
            <Card className="call-card incoming">
              <Card.Body>
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <h6 className="mb-1 text-white">
                      <FaUser className="me-2 text-info" />
                      {call.userName || 'Citizen'}
                    </h6>
                    <div className="text-muted small">
                      <FaPhone className="me-1" />
                      Emergency Call
                    </div>
                  </div>
                  {getStatusBadge(call.status)}
                </div>

                <div className="mt-3">
                  <div className="d-flex align-items-center text-muted small">
                    <FaClock className="me-2" />
                    {formatTime(call.startTime)}
                  </div>
                  {call.latitude && call.longitude && (
                    <div 
                      className="d-flex align-items-center text-primary small mt-1 location-badge"
                      onClick={() => openInMap(call.latitude, call.longitude)}
                    >
                      <FaMapMarkerAlt className="me-2" />
                      📍 View Location
                    </div>
                  )}
                  <div className="mt-2 call-source">
                    {getSourceIcon(call.source)}
                    Source: {call.source === 'mobile_app' ? 'Mobile App' : 'Web'}
                  </div>
                </div>

                <div className="d-flex gap-2 mt-3">
                  <Button
                    variant="success"
                    size="sm"
                    className="flex-grow-1"
                    onClick={() => acceptCall(call)}
                  >
                    <FaPhoneAlt className="me-2" />
                    Answer
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => endCall(call)}
                  >
                    <FaPhoneSlash />
                  </Button>
                </div>
              </Card.Body>
            </Card>
          </Col>
        ))}

        {/* Active Calls */}
        {activeCallsList.map(call => (
          <Col key={call.id} md={6} lg={4}>
            <Card className="call-card active border-success">
              <Card.Body>
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <h6 className="mb-1 text-white">
                      <FaHeadset className="me-2 text-success" />
                      {call.userName || 'Citizen'}
                    </h6>
                    <div className="text-muted small">
                      <FaPhone className="me-1" />
                      Active Call
                    </div>
                  </div>
                  {getStatusBadge(call.status)}
                </div>

                <div className="mt-3">
                  <div className="d-flex align-items-center text-muted small">
                    <FaClock className="me-2" />
                    Duration: {getCallDuration(call)}
                  </div>
                  {call.latitude && call.longitude && (
                    <div 
                      className="d-flex align-items-center text-success small mt-1 location-badge"
                      onClick={() => openInMap(call.latitude, call.longitude)}
                    >
                      <FaMapMarkerAlt className="me-2" />
                      📍 Live Location
                    </div>
                  )}
                  <div className="mt-2 call-source">
                    {getSourceIcon(call.source)}
                    Source: {call.source === 'mobile_app' ? 'Mobile App' : 'Web'}
                  </div>
                </div>

                <div className="d-flex gap-2 mt-3">
                  <Button
                    variant="outline-danger"
                    size="sm"
                    className="flex-grow-1"
                    onClick={() => endCall(call)}
                  >
                    <FaPhoneSlash className="me-2" />
                    End Call
                  </Button>
                </div>
              </Card.Body>
            </Card>
          </Col>
        ))}

        {/* No Calls */}
        {activeCalls.length === 0 && (
          <Col xs={12}>
            <div className="text-center py-5">
              <FaPhone size={48} className="text-muted mb-3" />
              <h5 className="text-muted">No Active Calls</h5>
              <p className="text-muted small">Waiting for incoming emergency calls...</p>
              <div className="mt-3">
                <Badge bg="secondary" className="me-2">📱 Mobile App</Badge>
                <Badge bg="secondary">🌐 Web Dashboard</Badge>
              </div>
            </div>
          </Col>
        )}
      </Row>

      {/* Call Statistics */}
      {activeCalls.length > 0 && (
        <div className="mt-4">
          <Row className="g-2">
            <Col xs={4}>
              <div className="bg-dark p-2 rounded text-center">
                <small className="text-muted">Total Calls</small>
                <h6 className="text-white">{activeCalls.length}</h6>
              </div>
            </Col>
            <Col xs={4}>
              <div className="bg-dark p-2 rounded text-center">
                <small className="text-muted">Active</small>
                <h6 className="text-success">{activeCallsList.length}</h6>
              </div>
            </Col>
            <Col xs={4}>
              <div className="bg-dark p-2 rounded text-center">
                <small className="text-muted">Incoming</small>
                <h6 className="text-warning">{incomingCalls.length}</h6>
              </div>
            </Col>
          </Row>
        </div>
      )}
    </div>
  );
};

export default CallManagement;