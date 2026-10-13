// src/pages/AuditLogs/index.tsx
import React, { useState, useEffect, useMemo } from 'react';
import {
  Card,
  Row,
  Col,
  Table,
  Badge,
  Button,
  Form,
  Spinner,
  Alert,
  InputGroup,
} from 'react-bootstrap';
import {
  FaClipboardList,
  FaSearch,
  FaDownload,
  FaCheckCircle,
  FaTimesCircle,
  FaCalendarAlt,
  FaSync,
  FaExclamationTriangle,
} from 'react-icons/fa';
import type { AuditLog } from '../../types';
import { firestore, collection, onSnapshot, query, orderBy, limitToLast, doc, getDoc } from '../../services/firebase';
import toast from 'react-hot-toast';
import './AuditLogs.css';

const AUDIT_LOGS_COLLECTION = 'audit_logs';
const USERS_COLLECTION = 'users'; // Adjust to your users collection name

const AuditLogs: React.FC = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [userEmails, setUserEmails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [actionFilter, setActionFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [refreshing, setRefreshing] = useState(false);

  // Fetch user emails for all unique user_ids
  const fetchUserEmails = async (userIds: string[]) => {
    const uniqueUserIds = [...new Set(userIds.filter(id => id && id !== 'System'))];
    const emailMap: Record<string, string> = {};
    
    for (const userId of uniqueUserIds) {
      try {
        const userDoc = await getDoc(doc(firestore, USERS_COLLECTION, userId));
        if (userDoc.exists()) {
          const userData = userDoc.data();
          // Try different possible email field names
          emailMap[userId] = userData.email || userData.user_email || userData.emailAddress || userId;
        } else {
          emailMap[userId] = userId; // Fallback to user_id if user not found
        }
      } catch (error) {
        console.error(`Failed to fetch user email for ${userId}:`, error);
        emailMap[userId] = userId;
      }
    }
    
    return emailMap;
  };

  // Subscribe to real-time audit logs from Firestore
  useEffect(() => {
    const logsRef = collection(firestore, AUDIT_LOGS_COLLECTION);
    const logsQuery = query(logsRef, orderBy('created_at', 'desc'), limitToLast(500));

    const unsubscribe = onSnapshot(
      logsQuery,
      async (snapshot) => {
        const logsList: AuditLog[] = snapshot.docs.map((docSnapshot) => {
          const data = docSnapshot.data();
          return {
            ...data,
            log_id: docSnapshot.id, // Use document ID as log_id if not present
          } as AuditLog;
        });
        
        logsList.sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        setLogs(logsList);
        setLastUpdated(new Date());
        
        // Fetch user emails for all unique user_ids in the logs
        const userIds = logsList.map(log => log.user_id).filter((id): id is string => Boolean(id));
        const emails = await fetchUserEmails(userIds);
        setUserEmails(emails);
        
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('Error fetching audit logs:', err);
        setError('Failed to load audit logs from the database.');
        setLogs([]);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  const filteredLogs = useMemo(() => {
    let filtered = [...logs];

    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      filtered = filtered.filter(log => {
        const userEmail = (log.user_id ? userEmails[log.user_id] : null) || log.user_id || 'System';
        return (
          userEmail.toLowerCase().includes(searchLower) ||
          log.action.toLowerCase().includes(searchLower) ||
          (log.entity_type?.toLowerCase().includes(searchLower)) ||
          (log.entity_id?.toLowerCase().includes(searchLower))
        );
      });
    }

    if (actionFilter !== 'ALL') {
      filtered = filtered.filter(log => log.action === actionFilter);
    }

    if (statusFilter !== 'ALL') {
      filtered = filtered.filter(log => log.status === statusFilter);
    }

    return filtered;
  }, [logs, userEmails, searchTerm, actionFilter, statusFilter]);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  };

  const handleActionFilter = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setActionFilter(e.target.value);
  };

  const handleStatusFilter = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatusFilter(e.target.value);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    setLastUpdated(new Date());
    setTimeout(() => setRefreshing(false), 500);
  };

  const handleClearFilters = () => {
    setSearchTerm('');
    setActionFilter('ALL');
    setStatusFilter('ALL');
  };

  const getStatusBadge = (status: string): React.ReactElement => {
    return status === 'success' 
      ? <Badge bg="success" className="status-badge-success"><FaCheckCircle className="me-1" />Success</Badge>
      : <Badge bg="danger" className="status-badge-failure"><FaTimesCircle className="me-1" />Failure</Badge>;
  };

  const getActionBadge = (action: string): React.ReactElement => {
    const variants: Record<string, string> = {
      login: 'info',
      logout: 'secondary',
      verify_incident: 'warning',
      dispatch_units: 'primary',
      update_incident_status: 'success',
      generate_report: 'dark',
      create_user: 'danger',
      update_user: 'danger',
      delete_user: 'danger',
      toggle_user_status: 'warning',
      reset_password: 'info',
      update_sensor: 'info',
      create_incident: 'primary',
      update_unit_status: 'primary',
    };
    
    const labels: Record<string, string> = {
      verify_incident: 'Verify Incident',
      dispatch_units: 'Dispatch Units',
      update_incident_status: 'Update Status',
      generate_report: 'Generate Report',
      create_user: 'Create User',
      update_user: 'Update User',
      delete_user: 'Delete User',
      toggle_user_status: 'Toggle Status',
      reset_password: 'Reset Password',
      update_sensor: 'Update Sensor',
      create_incident: 'Create Incident',
      update_unit_status: 'Update Unit',
    };
    
    return (
      <Badge bg={variants[action] || 'secondary'} className="action-badge">
        {labels[action] || action.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
      </Badge>
    );
  };

  const getUserDisplay = (userId: string | null | undefined): string => {
    if (!userId || userId === 'System') return 'System';
    return userEmails[userId] || userId;
  };

  const handleExport = (): void => {
    if (filteredLogs.length === 0) {
      toast.error('No logs to export');
      return;
    }

    const headers = ['Timestamp', 'User Email', 'Action', 'Entity Type', 'Entity ID', 'Status', 'Error Message'];
    const rows = filteredLogs.map(log => [
      new Date(log.created_at).toLocaleString(),
      getUserDisplay(log.user_id),
      log.action,
      log.entity_type || '',
      log.entity_id || '',
      log.status,
      log.error_message || '',
    ]);
    
    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${cell}"`).join(','))
      .join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit_logs_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    toast.success(`Exported ${filteredLogs.length} log entries`);
  };

  const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const formatRelativeTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };

  // Format entity type for display
  const formatEntityType = (entityType: string): string => {
    if (!entityType) return '';
    return entityType
      .replace(/_/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  };

  const uniqueActions = [...new Set(logs.map(log => log.action))].sort();

  const stats = {
    total: logs.length,
    success: logs.filter(l => l.status === 'success').length,
    failure: logs.filter(l => l.status === 'failure').length,
    uniqueActions: uniqueActions.length,
  };

  if (loading) {
    return (
      <div className="audit-logs-loading">
        <Spinner animation="border" variant="danger" />
        <p>Loading audit logs...</p>
      </div>
    );
  }

  return (
    <div className="audit-logs-page">
      <div className="container-fluid px-4 py-4">
        {/* Error Alert */}
        {error && (
          <Alert variant="warning" className="mb-3">
            <FaExclamationTriangle className="me-2" />
            {error}
          </Alert>
        )}

        {/* Real-time Indicator */}
        <Alert variant="success" className="mb-3 realtime-indicator">
          <FaSync className={`me-2 ${refreshing ? 'spin' : ''}`} />
          Live from the database • Last updated: {lastUpdated.toLocaleTimeString()}
        </Alert>

        <Row className="mb-4">
          <Col>
            <div className="page-header">
              <div className="header-icon">
                <FaClipboardList className="text-danger" size={24} />
              </div>
              <div className="header-text">
                <h2>Audit Logs</h2>
                <p>View system audit trails and activity logs in real-time</p>
              </div>
            </div>
          </Col>
          <Col xs="auto">
            <div className="header-actions">
              <Button 
                variant="outline-light" 
                className="me-2"
                onClick={handleRefresh}
                disabled={refreshing}
              >
                <FaSync className={`me-2 ${refreshing ? 'spin' : ''}`} />
                Refresh
              </Button>
              <Button 
                variant="outline-danger" 
                onClick={handleExport}
                disabled={filteredLogs.length === 0}
              >
                <FaDownload className="me-2" /> Export CSV
              </Button>
            </div>
          </Col>
        </Row>

        {/* Filters Card */}
        <Card className="filter-card mb-4">
          <Card.Body className="p-4">
            <Row className="g-3 align-items-end">
              <Col md={5}>
                <Form.Label className="filter-label">Search</Form.Label>
                <InputGroup>
                  <InputGroup.Text className="search-icon-wrapper">
                    <FaSearch />
                  </InputGroup.Text>
                  <Form.Control
                    type="text"
                    placeholder="Search by user email, action, entity type, or entity ID..."
                    value={searchTerm}
                    onChange={handleSearch}
                    className="search-input"
                  />
                </InputGroup>
              </Col>
              <Col md={2}>
                <Form.Label className="filter-label">Action</Form.Label>
                <Form.Select 
                  value={actionFilter} 
                  onChange={handleActionFilter}
                  className="filter-select"
                >
                  <option value="ALL">All Actions</option>
                  {uniqueActions.map(action => (
                    <option key={action} value={action}>
                      {action.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </option>
                  ))}
                </Form.Select>
              </Col>
              <Col md={2}>
                <Form.Label className="filter-label">Status</Form.Label>
                <Form.Select 
                  value={statusFilter} 
                  onChange={handleStatusFilter}
                  className="filter-select"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="success">Success</option>
                  <option value="failure">Failure</option>
                </Form.Select>
              </Col>
              <Col md={2}>
                <Button 
                  variant="outline-secondary" 
                  onClick={handleClearFilters}
                  className="w-100"
                >
                  Clear Filters
                </Button>
              </Col>
              <Col md={1}>
                <div className="result-count">
                  <Badge bg="primary" className="count-badge">
                    {filteredLogs.length} results
                  </Badge>
                </div>
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* Logs Table */}
        <Card className="table-card">
          <Card.Header className="table-header">
            <div className="d-flex align-items-center">
              <FaClipboardList className="me-2 text-danger" />
              <h5 className="mb-0">Activity Logs ({filteredLogs.length})</h5>
            </div>
            <small className="last-updated">
              <FaCalendarAlt className="me-1" />
              Last updated: {lastUpdated.toLocaleString()}
            </small>
          </Card.Header>
          <div className="table-responsive">
            <Table bordered hover className="logs-table mb-0">
              <thead>
                <tr>
                  <th style={{ width: '160px' }}>Timestamp</th>
                  <th style={{ width: '200px' }}>User Email</th>
                  <th style={{ width: '150px' }}>Action</th>
                  <th style={{ width: '200px' }}>Entity</th>
                  <th style={{ width: '100px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => (
                  <tr key={log.log_id} className={log.status === 'failure' ? 'row-failure' : ''}>
                    <td className="timestamp-cell">
                      <div className="timestamp-main">{formatTimestamp(log.created_at)}</div>
                      <div className="timestamp-relative">{formatRelativeTime(log.created_at)}</div>
                    </td>
                    <td>
                      <code className="user-code">{getUserDisplay(log.user_id)}</code>
                    </td>
                    <td>{getActionBadge(log.action)}</td>
                    <td>
                      {log.entity_type || log.entity_id ? (
                        <div className="entity-info">
                          {log.entity_type && (
                            <Badge bg="info" text="white" className="entity-type-badge me-1">
                              {formatEntityType(log.entity_type)}
                            </Badge>
                          )}
                          {log.entity_id && (
                            <code className="entity-id-code">
                              {log.entity_id.length > 20 ? `${log.entity_id.substring(0, 20)}...` : log.entity_id}
                            </code>
                          )}
                          {!log.entity_type && log.entity_id && (
                            <code className="entity-id-code">
                              {log.entity_id.length > 20 ? `${log.entity_id.substring(0, 20)}...` : log.entity_id}
                            </code>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td>{getStatusBadge(log.status)}</td>
                  </tr>
                ))}
                {filteredLogs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-table-cell">
                      <FaClipboardList size={48} className="empty-icon" />
                      <p className="empty-text">No audit logs found</p>
                      <small className="empty-subtext">Try adjusting your search filters</small>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>
        </Card>

        {/* Stats Summary */}
        <Row className="stats-row g-3 mt-4">
          <Col md={3}>
            <Card className="stat-card">
              <Card.Body className="text-center p-4">
                <div className="stat-icon bg-danger bg-opacity-10">
                  <FaClipboardList className="text-danger" size={24} />
                </div>
                <h3 className="stat-value">{stats.total}</h3>
                <small className="stat-label">Total Logs</small>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="stat-card">
              <Card.Body className="text-center p-4">
                <div className="stat-icon bg-success bg-opacity-10">
                  <FaCheckCircle className="text-success" size={24} />
                </div>
                <h3 className="stat-value text-success">{stats.success}</h3>
                <small className="stat-label">Successful Actions</small>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="stat-card">
              <Card.Body className="text-center p-4">
                <div className="stat-icon bg-danger bg-opacity-10">
                  <FaTimesCircle className="text-danger" size={24} />
                </div>
                <h3 className="stat-value text-danger">{stats.failure}</h3>
                <small className="stat-label">Failed Actions</small>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="stat-card">
              <Card.Body className="text-center p-4">
                <div className="stat-icon bg-info bg-opacity-10">
                  <FaCalendarAlt className="text-info" size={24} />
                </div>
                <h3 className="stat-value">{stats.uniqueActions}</h3>
                <small className="stat-label">Unique Actions</small>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </div>
    </div>
  );
};

export default AuditLogs;