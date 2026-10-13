// src/pages/Login.tsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Form, Button, Alert, Modal } from 'react-bootstrap';
import { useAuth } from '../../hooks/useAuth';
import {
  FaFireExtinguisher,
  FaEnvelope,
  FaLock,
  FaShieldAlt,
  FaMapMarkedAlt,
  FaUserShield,
  FaPaperPlane,
  FaClock,
} from 'react-icons/fa';
import { resolveLandingRoute } from '../../utils/roles';
import './Login.scss';

const Login: React.FC = () => {
  const navigate = useNavigate();
  const { user, login, resetPassword, loading, error } = useAuth();
  const [credentials, setCredentials] = useState({ email: '', password: '' });
  const [validated, setValidated] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Forgot password modal
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSending, setResetSending] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  // Anti-spam
  const RESET_COOLDOWN_SECONDS = 60;
  const LOGIN_MAX_ATTEMPTS = 5;
  const LOGIN_LOCK_SECONDS = 60;

  const readResetCooldown = (): number => {
    const lastReset = Number(sessionStorage.getItem('embernet_reset_ts') || 0);
    if (!lastReset) return 0;
    const elapsed = Math.floor((Date.now() - lastReset) / 1000);
    return Math.max(0, RESET_COOLDOWN_SECONDS - elapsed);
  };
  const readFailedAttempts = (): number => {
    const lastFailTs = Number(
      sessionStorage.getItem('embernet_login_fail_ts') || 0
    );
    const storedFails = Number(
      sessionStorage.getItem('embernet_login_fails') || 0
    );
    if (lastFailTs && Date.now() - lastFailTs >= LOGIN_LOCK_SECONDS * 1000) {
      return 0;
    }
    return storedFails;
  };
  const readLoginLock = (): number => {
    const lastFailTs = Number(
      sessionStorage.getItem('embernet_login_fail_ts') || 0
    );
    if (!lastFailTs) return 0;
    return Math.max(
      0,
      LOGIN_LOCK_SECONDS - Math.floor((Date.now() - lastFailTs) / 1000)
    );
  };

  const [resetCooldown, setResetCooldown] = useState<number>(readResetCooldown);
  const [failedAttempts, setFailedAttempts] =
    useState<number>(readFailedAttempts);
  const [loginLock, setLoginLock] = useState<number>(readLoginLock);

  const countdownActive = resetCooldown > 0 || loginLock > 0;

  useEffect(() => {
    if (!countdownActive) return;
    const timer = window.setInterval(() => {
      setResetCooldown((c) => (c > 0 ? c - 1 : 0));
      setLoginLock((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdownActive]);

  // Role-aware redirect once user is populated
  useEffect(() => {
    if (!user) return;
    const target = resolveLandingRoute(user);

    // Dev-only diagnostic — never rendered into the DOM.
    if (import.meta.env.DEV) {
      console.log('🔀 [Login] User detected → landing on', target, user);
    }

    navigate(target, { replace: true });
  }, [user, navigate]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (loginLock > 0) return;

    const form = e.currentTarget;
    if (form.checkValidity() === false) {
      e.stopPropagation();
      setValidated(true);
      return;
    }

    const ok = await login(credentials);

    if (ok) {
      setFailedAttempts(0);
      sessionStorage.removeItem('embernet_login_fails');
      sessionStorage.removeItem('embernet_login_fail_ts');
      // Redirect effect above handles navigation once `user` is set.
    } else {
      const fails = failedAttempts + 1;
      setFailedAttempts(fails);
      sessionStorage.setItem('embernet_login_fails', String(fails));
      sessionStorage.setItem('embernet_login_fail_ts', String(Date.now()));
      if (fails >= LOGIN_MAX_ATTEMPTS) {
        setLoginLock(LOGIN_LOCK_SECONDS);
      }
    }
  };

  const handleForgotPassword = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    setResetEmail(credentials.email || '');
    setResetSent(false);
    setShowResetModal(true);
  };

  const handleSendReset = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (resetCooldown > 0) return;

    const form = e.currentTarget;
    if (form.checkValidity() === false) {
      e.stopPropagation();
      setValidated(true);
      return;
    }

    setResetSending(true);
    const ok = await resetPassword(resetEmail);
    setResetSending(false);

    setResetCooldown(RESET_COOLDOWN_SECONDS);
    sessionStorage.setItem('embernet_reset_ts', String(Date.now()));

    if (ok) setResetSent(true);
  };

  return (
    <div className="login-container">
      {/* Animated Background */}
      <div className="login-background">
        <div className="bg-gradient"></div>
        <div className="bg-pattern"></div>
        <div className="bg-glow bg-glow-1"></div>
        <div className="bg-glow bg-glow-2"></div>
        <div className="bg-glow bg-glow-3"></div>
      </div>

      {/* Floating Particles */}
      <div className="particles">
        {[...Array(20)].map((_, i) => (
          <div key={i} className={`particle particle-${i + 1}`}></div>
        ))}
      </div>

      <Container className="login-wrapper">
        <div className="login-card-wrapper">
          {/* Left Side */}
          <div className="login-hero">
            <div className="hero-content">
              <div className="hero-logo">
                <div className="logo-icon">
                  <FaFireExtinguisher />
                </div>
                <h1 className="logo-text">
                  Ember<span>Net</span>
                </h1>
              </div>

              <div className="hero-tagline">
                <h2>BFP Command Dashboard</h2>
                <p>Gonzaga Fire Station</p>
              </div>

              <div className="hero-features">
                <div className="feature-item">
                  <div className="feature-icon">
                    <FaShieldAlt />
                  </div>
                  <div className="feature-text">
                    <h4>Real-Time Monitoring</h4>
                    <p>Live incident tracking and response coordination</p>
                  </div>
                </div>
                <div className="feature-item">
                  <div className="feature-icon">
                    <FaMapMarkedAlt />
                  </div>
                  <div className="feature-text">
                    <h4>GeoMap Integration</h4>
                    <p>Precise location tracking and visualization</p>
                  </div>
                </div>
                <div className="feature-item">
                  <div className="feature-icon">
                    <FaUserShield />
                  </div>
                  <div className="feature-text">
                    <h4>Secure Access</h4>
                    <p>Role-based authentication and encryption</p>
                  </div>
                </div>
              </div>

              <div className="hero-footer">
                <div className="security-badge">
                  <FaShieldAlt className="badge-icon" />
                  <span>Secure • Encrypted Connection</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Side */}
          <div className="login-form-wrapper">
            <div className="login-form-container">
              <div className="form-header">
                <h3>Welcome Back</h3>
                <p>Sign in to access your dashboard</p>
              </div>

              {loginLock > 0 && (
                <Alert variant="warning" className="login-alert">
                  <FaLock className="alert-icon" />
                  Too many failed attempts. Login locked - try again in{' '}
                  {loginLock} seconds.
                </Alert>
              )}

              {error && (
                <Alert variant="danger" className="login-alert">
                  <FaFireExtinguisher className="alert-icon" />
                  <span>{error}</span>
                </Alert>
              )}

              <Form noValidate validated={validated} onSubmit={handleSubmit}>
                <Form.Group className="form-group" controlId="email">
                  <Form.Label>Email Address</Form.Label>
                  <div className="input-wrapper">
                    <span className="input-icon">
                      <FaEnvelope />
                    </span>
                    <Form.Control
                      type="email"
                      placeholder="Enter your BFP email"
                      value={credentials.email}
                      onChange={(e) =>
                        setCredentials({ ...credentials, email: e.target.value })
                      }
                      required
                      disabled={loading}
                      className="form-input"
                    />
                  </div>
                  <Form.Control.Feedback type="invalid">
                    Please enter a valid email address.
                  </Form.Control.Feedback>
                  <Form.Text className="input-hint">
                    Use your official BFP email address
                  </Form.Text>
                </Form.Group>

                <Form.Group className="form-group" controlId="password">
                  <Form.Label>Password</Form.Label>
                  <div className="input-wrapper">
                    <span className="input-icon">
                      <FaLock />
                    </span>
                    <Form.Control
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Enter your password"
                      value={credentials.password}
                      onChange={(e) =>
                        setCredentials({
                          ...credentials,
                          password: e.target.value,
                        })
                      }
                      required
                      disabled={loading}
                      className="form-input"
                    />
                    <button
                      type="button"
                      className="password-toggle"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <Form.Control.Feedback type="invalid">
                    Please enter your password.
                  </Form.Control.Feedback>
                </Form.Group>

                <div className="form-options">
                  <Form.Check
                    type="checkbox"
                    id="remember"
                    label="Remember me"
                    className="remember-checkbox"
                  />
                  <a
                    href="#"
                    className="forgot-link"
                    onClick={handleForgotPassword}
                  >
                    Forgot password?
                  </a>
                </div>

                <Button
                  variant="primary"
                  type="submit"
                  className="login-button"
                  disabled={loading || loginLock > 0}
                >
                  {loading ? (
                    <>
                      <span className="spinner"></span>
                      Authenticating...
                    </>
                  ) : loginLock > 0 ? (
                    <>
                      <FaLock className="me-2" />
                      Locked - try again in {loginLock}s
                    </>
                  ) : (
                    <>
                      Sign In
                      <span className="btn-arrow">→</span>
                    </>
                  )}
                </Button>
              </Form>
            </div>
          </div>
        </div>
      </Container>

      {/* Forgot Password Modal */}
      <Modal
        show={showResetModal}
        onHide={() => setShowResetModal(false)}
        centered
        className="forgot-modal"
      >
        <Modal.Header closeButton>
          <Modal.Title>
            <FaEnvelope className="me-2 text-danger" />
            Reset Password
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {resetSent ? (
            <Alert variant="success" className="mb-0 reset-success-box">
              <div className="reset-success-content">
                <div className="reset-success-title">
                  <FaPaperPlane className="me-2" />
                  <span>Email Sent!</span>
                </div>
                <p className="reset-success-message mb-0">
                  If an account exists for{' '}
                  <strong className="email-highlight">{resetEmail}</strong>, a
                  password reset link has been sent. Check your inbox (and spam
                  folder) to continue.
                </p>
              </div>
            </Alert>
          ) : (
            <Form noValidate validated={validated} onSubmit={handleSendReset}>
              <p className="text-muted">
                Enter your BFP email address and we'll send you a link to reset
                your password.
              </p>
              <Form.Group controlId="reset-email">
                <Form.Control
                  type="email"
                  placeholder="Enter your BFP email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                  className="mb-3"
                />
                <Form.Control.Feedback type="invalid">
                  Please enter a valid email address.
                </Form.Control.Feedback>
              </Form.Group>
              <div className="d-flex justify-content-end gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setShowResetModal(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={resetSending || resetCooldown > 0}
                >
                  {resetSending ? (
                    <>
                      <span className="spinner"></span>
                      Sending...
                    </>
                  ) : resetCooldown > 0 ? (
                    <>
                      <FaClock className="me-2" />
                      Resend in {resetCooldown}s
                    </>
                  ) : (
                    <>
                      <FaPaperPlane className="me-2" />
                      Send Reset Link
                    </>
                  )}
                </Button>
              </div>
            </Form>
          )}
        </Modal.Body>
      </Modal>
    </div>
  );
};

export default Login;