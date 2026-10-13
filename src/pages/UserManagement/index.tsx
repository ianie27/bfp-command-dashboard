// src/pages/UserManagement/index.tsx
import React, { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Table,
  Badge,
  Button,
  Form,
  Modal,
  Spinner,
  Alert,
} from 'react-bootstrap';
import {
  FaUsersCog,
  FaSearch,
  FaUserPlus,
  FaEdit,
  FaCheck,
  FaTimes,
  FaShieldAlt,
  FaMobileAlt,
  FaEnvelope,
  FaUserTag,
  FaKey,
  FaTrash,
  FaExclamationTriangle,
  FaUserCheck,
  FaUserSlash,
} from 'react-icons/fa';
import type { BFPPersonnel } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { 
  firestore, 
  collection, 
  doc, 
  onSnapshot, 
  deleteDoc, 
  updateDoc,
  auth
} from '../../services/firebase';
import { sendPasswordResetEmail } from 'firebase/auth';
import toast from 'react-hot-toast';
import './UserManagement.css';

const PERSONNEL_COLLECTION = 'bfp_personnel';

const UserManagement: React.FC = () => {
  const { user, createUser, updateUser: updateUserAuth, logActivity } = useAuth();
  const [personnel, setPersonnel] = useState<BFPPersonnel[]>([]);
  const [filteredPersonnel, setFilteredPersonnel] = useState<BFPPersonnel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showResetPasswordModal, setShowResetPasswordModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<BFPPersonnel | null>(null);
  const [processing, setProcessing] = useState(false);
  
  // Form states
  const [formData, setFormData] = useState({
    full_name: '',
    email: '',
    username: '',
    mobile_number: '',
    role: 'Dispatcher' as BFPPersonnel['role'],
    station_assignment: 'Gonzaga Fire Station',
    password: '',
  });

  // Subscribe to personnel data from Firestore
  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(firestore, PERSONNEL_COLLECTION),
      (snapshot) => {
        const personnelList: BFPPersonnel[] = snapshot.docs.map((docSnapshot) => {
          const data = docSnapshot.data();
          return {
            ...data,
            personnel_id: docSnapshot.id,
          } as BFPPersonnel;
        });
        setPersonnel(personnelList);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('Error fetching personnel:', err);
        setError('Failed to load user data from the database.');
        setPersonnel([]);
        setFilteredPersonnel([]);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  // Apply filters whenever filter criteria change
  useEffect(() => {
    applyFilters(personnel, searchTerm, roleFilter, statusFilter);
  }, [personnel, searchTerm, roleFilter, statusFilter]);

  const applyFilters = (
    data: BFPPersonnel[],
    search: string,
    role: string,
    status: string
  ) => {
    let filtered = [...data];

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(p =>
        p.full_name.toLowerCase().includes(searchLower) ||
        p.email.toLowerCase().includes(searchLower) ||
        p.username.toLowerCase().includes(searchLower) ||
        (p.mobile_number && p.mobile_number.includes(search))
      );
    }

    if (role !== 'ALL') {
      filtered = filtered.filter(p => p.role === role);
    }

    if (status !== 'ALL') {
      filtered = filtered.filter(p => p.account_status === status);
    }

    filtered.sort((a, b) => a.full_name.localeCompare(b.full_name));

    setFilteredPersonnel(filtered);
  };

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  };

  const handleRoleFilter = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setRoleFilter(e.target.value);
  };

  const handleStatusFilter = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatusFilter(e.target.value);
  };

  const getRoleBadge = (role: string): React.ReactElement => {
    const variants: Record<string, string> = {
      Administrator: 'danger',
      Dispatcher: 'primary',
      Responder: 'success',
      Coordinator: 'warning',
      IoT_Technician: 'info',
    };
    const labels: Record<string, string> = {
      IoT_Technician: 'IoT Technician',
    };
    return <Badge bg={variants[role] || 'secondary'} className="role-badge">{labels[role] || role}</Badge>;
  };

  const getStatusBadge = (status: string): React.ReactElement => {
    return status === 'Active' 
      ? <Badge bg="success" className="status-badge"><FaCheck className="me-1" />Active</Badge>
      : <Badge bg="secondary" className="status-badge"><FaTimes className="me-1" />Inactive</Badge>;
  };

  const canManageUser = (targetUser: BFPPersonnel): boolean => {
    if (!user) return false;
    if (user.role === 'Administrator') return true;
    if (user.role === 'Dispatcher') {
      return targetUser.role === 'Responder' || targetUser.role === 'IoT_Technician';
    }
    return false;
  };

  const canEditUser = (targetUser: BFPPersonnel): boolean => {
    if (!user) return false;
    if (user.personnel_id === targetUser.personnel_id) return true;
    if (user.role === 'Administrator') return true;
    if (user.role === 'Dispatcher') {
      return targetUser.role === 'Responder' || targetUser.role === 'IoT_Technician';
    }
    return false;
  };

  const handleAddUser = async () => {
    if (!formData.full_name || !formData.email || !formData.password) {
      toast.error('Please fill in all required fields');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      toast.error('Please enter a valid email address');
      return;
    }

    if (formData.password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }

    setProcessing(true);
    try {
      const success = await createUser({
        full_name: formData.full_name,
        email: formData.email,
        username: formData.username || formData.email.split('@')[0],
        mobile_number: formData.mobile_number,
        role: formData.role,
        station_assignment: formData.station_assignment,
      }, formData.password);

      if (success) {
        await logActivity('create_user', 'user', null);
        setShowAddModal(false);
        resetForm();
        toast.success('User created successfully');
      }
    } catch (error: any) {
      console.error('Add user error:', error);
      toast.error(error.message || 'Failed to create user');
    } finally {
      setProcessing(false);
    }
  };

  const handleEditUser = async () => {
    if (!selectedUser) return;

    if (!formData.full_name) {
      toast.error('Full name is required');
      return;
    }

    setProcessing(true);
    try {
      const updatedUserData: Partial<BFPPersonnel> = {
        full_name: formData.full_name,
        mobile_number: formData.mobile_number,
        station_assignment: formData.station_assignment,
        updated_at: new Date().toISOString(),
      };

      if (user?.role === 'Administrator' && selectedUser.personnel_id !== user?.personnel_id) {
        updatedUserData.role = formData.role;
        updatedUserData.permission_level = formData.role === 'Administrator' ? 100 : 50;
      }

      const success = await updateUserAuth(selectedUser.personnel_id, updatedUserData);

      if (success) {
        await logActivity('update_user', 'user', selectedUser.personnel_id);
        if (selectedUser.personnel_id === user?.personnel_id) {
          toast.success('Your profile has been updated. Some changes may require re-login.');
        } else {
          toast.success('User updated successfully');
        }
        setShowEditModal(false);
        setSelectedUser(null);
        resetForm();
      }
    } catch (error: any) {
      console.error('Edit user error:', error);
      toast.error(error.message || 'Failed to update user');
    } finally {
      setProcessing(false);
    }
  };

  // FIXED: Delete user from Firestore only (email becomes available again)
  const handleDeleteUser = async () => {
    if (!selectedUser) return;

    if (selectedUser.personnel_id === user?.personnel_id) {
      toast.error('You cannot delete your own account');
      return;
    }

    setProcessing(true);
    try {
      // Delete from Firestore
      await deleteDoc(doc(firestore, PERSONNEL_COLLECTION, selectedUser.personnel_id));
      
      // Log the activity
      await logActivity('delete_user', 'user', selectedUser.personnel_id);
      
      toast.success(`User ${selectedUser.full_name} deleted successfully. The email is now available for new accounts.`);
      setShowDeleteModal(false);
      setSelectedUser(null);
    } catch (error: any) {
      console.error('Delete user error:', error);
      toast.error(error.message || 'Failed to delete user');
    } finally {
      setProcessing(false);
    }
  };

  const handleToggleStatus = async (person: BFPPersonnel) => {
    if (person.personnel_id === user?.personnel_id) {
      toast.error('You cannot change your own account status');
      return;
    }

    const newStatus: 'Active' | 'Inactive' = person.account_status === 'Active' ? 'Inactive' : 'Active';
    const action = newStatus === 'Active' ? 'activated' : 'deactivated';
    
    try {
      await updateDoc(doc(firestore, PERSONNEL_COLLECTION, person.personnel_id), {
        account_status: newStatus,
        updated_at: new Date().toISOString(),
      });
      await logActivity(`${action}_user`, 'user', person.personnel_id);
      toast.success(`User ${person.full_name} ${action} successfully`);
    } catch (error: any) {
      console.error('Toggle status error:', error);
      toast.error(error.message || `Failed to ${action} user`);
    }
  };

  const handleResetPassword = async () => {
    if (!selectedUser) {
      toast.error('No user selected');
      return;
    }

    if (!selectedUser.email) {
      toast.error('User has no email address');
      return;
    }

    setProcessing(true);
    try {
      await sendPasswordResetEmail(auth, selectedUser.email, {
        url: `${window.location.origin}/login`,
        handleCodeInApp: false,
      });
      
      await logActivity('reset_password', 'user', selectedUser.personnel_id);
      
      toast.success(`Password reset email sent to ${selectedUser.email}`);
      setShowResetPasswordModal(false);
      setSelectedUser(null);
    } catch (error: any) {
      console.error('Reset password error:', error);
      
      const errorMessages: Record<string, string> = {
        'auth/user-not-found': 'No user found with this email address. Please check the email and try again.',
        'auth/too-many-requests': 'Too many password reset requests. Please wait a few minutes before trying again.',
        'auth/invalid-email': 'The email address is invalid. Please check and try again.',
        'auth/network-request-failed': 'Network error. Please check your internet connection and try again.',
        'auth/internal-error': 'An internal error occurred. Please try again later.',
      };
      
      const errorMessage = errorMessages[error.code] || 'Failed to send password reset email. Please try again.';
      toast.error(errorMessage);
    } finally {
      setProcessing(false);
    }
  };

  const resetForm = () => {
    setFormData({
      full_name: '',
      email: '',
      username: '',
      mobile_number: '',
      role: 'Dispatcher',
      station_assignment: 'Gonzaga Fire Station',
      password: '',
    });
  };

  const openEditModal = (person: BFPPersonnel) => {
    setSelectedUser(person);
    setFormData({
      full_name: person.full_name,
      email: person.email,
      username: person.username,
      mobile_number: person.mobile_number || '',
      role: person.role,
      station_assignment: person.station_assignment,
      password: '',
    });
    setShowEditModal(true);
  };

  const openResetPasswordModal = (person: BFPPersonnel) => {
    setSelectedUser(person);
    setShowResetPasswordModal(true);
  };

  const uniqueRoles = [...new Set(personnel.map(p => p.role))];

  const stats = {
    total: personnel.length,
    active: personnel.filter(p => p.account_status === 'Active').length,
    inactive: personnel.filter(p => p.account_status === 'Inactive').length,
    roles: uniqueRoles.length,
  };

  if (loading) {
    return (
      <div className="user-management-loading">
        <Spinner animation="border" variant="danger" />
        <p>Loading user data...</p>
      </div>
    );
  }

  return (
    <div className="user-management-page">
      <div className="container-fluid px-4 py-4">
        {error && (
          <Alert variant="warning" className="mb-3">
            <FaExclamationTriangle className="me-2" />
            {error}
          </Alert>
        )}

        <Row className="mb-4">
          <Col>
            <div className="page-header">
              <div className="header-icon">
                <FaUsersCog className="text-danger" size={24} />
              </div>
              <div className="header-text">
                <h2>User Management</h2>
                <p>Manage BFP personnel accounts and permissions</p>
              </div>
            </div>
          </Col>
          <Col xs="auto">
            <Button variant="danger" onClick={() => setShowAddModal(true)}>
              <FaUserPlus className="me-2" /> Add New User
            </Button>
          </Col>
        </Row>

        {/* Filters */}
        <Card className="filter-card mb-4">
          <Card.Body className="p-4">
            <Row className="g-3">
              <Col md={5}>
                <div className="search-wrapper">
                  <FaSearch className="search-icon" />
                  <Form.Control
                    type="text"
                    placeholder="Search by name, email, username, or mobile..."
                    value={searchTerm}
                    onChange={handleSearch}
                    className="search-input"
                  />
                </div>
              </Col>
              <Col md={3}>
                <Form.Select 
                  value={roleFilter} 
                  onChange={handleRoleFilter}
                  className="filter-select"
                >
                  <option value="ALL">All Roles</option>
                  {uniqueRoles.map(role => (
                    <option key={role} value={role}>
                      {role === 'IoT_Technician' ? 'IoT Technician' : role}
                    </option>
                  ))}
                </Form.Select>
              </Col>
              <Col md={2}>
                <Form.Select 
                  value={statusFilter} 
                  onChange={handleStatusFilter}
                  className="filter-select"
                >
                  <option value="ALL">All Status</option>
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </Form.Select>
              </Col>
              <Col md={2}>
                <div className="total-count">
                  <small>Total: {filteredPersonnel.length} users</small>
                </div>
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* Users Table */}
        <Card className="table-card">
          <Card.Header className="table-header">
            <h5 className="mb-0">Personnel Directory</h5>
            <small>
              <FaShieldAlt className="me-1" />
              Role-based access control
            </small>
          </Card.Header>
          <div className="table-responsive">
            <Table bordered hover className="users-table mb-0">
              <thead>
                <tr>
                  <th>Name & Contact</th>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Station</th>
                  <th>Status</th>
                  <th className="text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredPersonnel.map((person) => {
                  const canEdit = canEditUser(person);
                  const canManage = canManageUser(person);
                  const isSelf = user?.personnel_id === person.personnel_id;
                  
                  return (
                    <tr key={person.personnel_id}>
                      <td>
                        <div>
                          <strong>{person.full_name}</strong>
                          {isSelf && <Badge bg="info" className="ms-2">You</Badge>}
                        </div>
                        <div className="contact-info">
                          <FaMobileAlt className="contact-icon" />
                          <small>{person.mobile_number || 'N/A'}</small>
                        </div>
                      </td>
                      <td>
                        <code className="username-code">@{person.username}</code>
                      </td>
                      <td>
                        <FaEnvelope className="contact-icon" />
                        <small>{person.email}</small>
                      </td>
                      <td>{getRoleBadge(person.role)}</td>
                      <td>
                        <FaUserTag className="contact-icon" />
                        <span>{person.station_assignment}</span>
                      </td>
                      <td>{getStatusBadge(person.account_status)}</td>
                      <td className="action-cell">
                        {canEdit && (
                          <Button 
                            variant="outline-primary" 
                            size="sm" 
                            className="action-btn"
                            onClick={() => openEditModal(person)}
                            title="Edit User"
                          >
                            <FaEdit />
                          </Button>
                        )}
                        
                        {(canEdit || user?.role === 'Administrator') && (
                          <Button 
                            variant="outline-info" 
                            size="sm" 
                            className="action-btn"
                            onClick={() => openResetPasswordModal(person)}
                            title="Reset Password"
                          >
                            <FaKey />
                          </Button>
                        )}
                        
                        {!isSelf && canManage && (
                          <>
                            <Button 
                              variant={person.account_status === 'Active' ? 'outline-warning' : 'outline-success'} 
                              size="sm"
                              className="action-btn"
                              onClick={() => handleToggleStatus(person)}
                              title={person.account_status === 'Active' ? 'Deactivate User' : 'Activate User'}
                            >
                              {person.account_status === 'Active' ? <FaUserSlash /> : <FaUserCheck />}
                            </Button>
                            
                            <Button 
                              variant="outline-danger" 
                              size="sm"
                              className="action-btn"
                              onClick={() => {
                                setSelectedUser(person);
                                setShowDeleteModal(true);
                              }}
                              title="Delete User"
                            >
                              <FaTrash />
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filteredPersonnel.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty-table-cell">
                      <FaUsersCog size={48} className="empty-icon" />
                      <p className="empty-text">No users found</p>
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
                  <FaUsersCog className="text-danger" size={24} />
                </div>
                <h3 className="stat-value">{stats.total}</h3>
                <small className="stat-label">Total Personnel</small>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="stat-card">
              <Card.Body className="text-center p-4">
                <div className="stat-icon bg-success bg-opacity-10">
                  <FaUserCheck className="text-success" size={24} />
                </div>
                <h3 className="stat-value text-success">{stats.active}</h3>
                <small className="stat-label">Active Users</small>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="stat-card">
              <Card.Body className="text-center p-4">
                <div className="stat-icon bg-secondary bg-opacity-10">
                  <FaUserSlash className="text-secondary" size={24} />
                </div>
                <h3 className="stat-value text-secondary">{stats.inactive}</h3>
                <small className="stat-label">Inactive Users</small>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="stat-card">
              <Card.Body className="text-center p-4">
                <div className="stat-icon bg-info bg-opacity-10">
                  <FaShieldAlt className="text-info" size={24} />
                </div>
                <h3 className="stat-value">{stats.roles}</h3>
                <small className="stat-label">User Roles</small>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </div>

      {/* Add User Modal */}
      <Modal show={showAddModal} onHide={() => setShowAddModal(false)} centered className="user-modal">
        <Modal.Header closeButton>
          <Modal.Title>
            <FaUserPlus className="me-2 text-danger" />
            Add New User
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Form.Group className="mb-3">
              <Form.Label>Full Name *</Form.Label>
              <Form.Control 
                type="text" 
                placeholder="Enter full name"
                value={formData.full_name}
                onChange={(e) => setFormData({...formData, full_name: e.target.value})}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Email *</Form.Label>
              <Form.Control 
                type="email" 
                placeholder="Enter email"
                value={formData.email}
                onChange={(e) => setFormData({...formData, email: e.target.value})}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Username</Form.Label>
              <Form.Control 
                type="text" 
                placeholder="Enter username (auto-generated if empty)"
                value={formData.username}
                onChange={(e) => setFormData({...formData, username: e.target.value})}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Password *</Form.Label>
              <Form.Control 
                type="password" 
                placeholder="Enter password (min 6 characters)"
                value={formData.password}
                onChange={(e) => setFormData({...formData, password: e.target.value})}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Mobile Number</Form.Label>
              <Form.Control 
                type="tel" 
                placeholder="Enter mobile number"
                value={formData.mobile_number}
                onChange={(e) => setFormData({...formData, mobile_number: e.target.value})}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Role *</Form.Label>
              <Form.Select 
                value={formData.role}
                onChange={(e) => setFormData({...formData, role: e.target.value as BFPPersonnel['role']})}
              >
                <option value="Dispatcher">Dispatcher</option>
                {user?.role === 'Administrator' && (
                  <option value="Administrator">Administrator</option>
                )}
              </Form.Select>
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Station Assignment</Form.Label>
              <Form.Control 
                type="text" 
                placeholder="Enter station"
                value={formData.station_assignment}
                onChange={(e) => setFormData({...formData, station_assignment: e.target.value})}
              />
            </Form.Group>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowAddModal(false)} disabled={processing}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleAddUser} disabled={processing}>
            {processing ? <Spinner animation="border" size="sm" /> : 'Add User'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Edit User Modal */}
      <Modal show={showEditModal} onHide={() => setShowEditModal(false)} centered className="user-modal">
        <Modal.Header closeButton>
          <Modal.Title>
            <FaEdit className="me-2 text-warning" />
            Edit User: {selectedUser?.full_name}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Form.Group className="mb-3">
              <Form.Label>Full Name *</Form.Label>
              <Form.Control 
                type="text" 
                value={formData.full_name}
                onChange={(e) => setFormData({...formData, full_name: e.target.value})}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Email</Form.Label>
              <Form.Control 
                type="email" 
                value={formData.email}
                disabled
              />
              <Form.Text className="text-muted">Email cannot be changed</Form.Text>
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Mobile Number</Form.Label>
              <Form.Control 
                type="tel" 
                value={formData.mobile_number}
                onChange={(e) => setFormData({...formData, mobile_number: e.target.value})}
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Role *</Form.Label>
              <Form.Select 
                value={formData.role}
                onChange={(e) => setFormData({...formData, role: e.target.value as BFPPersonnel['role']})}
                disabled={selectedUser?.personnel_id === user?.personnel_id || (user?.role !== 'Administrator')}
              >
                <option value="Dispatcher">Dispatcher</option>
                <option value="Responder">Responder</option>
                <option value="Coordinator">Coordinator</option>
                <option value="IoT_Technician">IoT Technician</option>
                {user?.role === 'Administrator' && (
                  <option value="Administrator">Administrator</option>
                )}
              </Form.Select>
              {selectedUser?.personnel_id === user?.personnel_id && (
                <Form.Text className="text-muted">You cannot change your own role</Form.Text>
              )}
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Station Assignment</Form.Label>
              <Form.Control 
                type="text" 
                value={formData.station_assignment}
                onChange={(e) => setFormData({...formData, station_assignment: e.target.value})}
              />
            </Form.Group>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowEditModal(false)} disabled={processing}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleEditUser} disabled={processing}>
            {processing ? <Spinner animation="border" size="sm" /> : 'Save Changes'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete User Modal */}
      <Modal show={showDeleteModal} onHide={() => setShowDeleteModal(false)} centered className="user-modal">
        <Modal.Header closeButton>
          <Modal.Title>
            <FaTrash className="me-2 text-danger" />
            Delete User
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>Are you sure you want to delete user <strong>{selectedUser?.full_name}</strong>?</p>
          <p className="text-danger">This action cannot be undone.</p>
          <p className="text-muted small">The user's email will become available for new accounts.</p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowDeleteModal(false)} disabled={processing}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDeleteUser} disabled={processing}>
            {processing ? <Spinner animation="border" size="sm" /> : 'Delete User'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Reset Password Modal */}
      <Modal show={showResetPasswordModal} onHide={() => setShowResetPasswordModal(false)} centered className="user-modal">
        <Modal.Header closeButton>
          <Modal.Title>
            <FaKey className="me-2 text-info" />
            Reset Password
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>Send a password reset email to <strong>{selectedUser?.full_name}</strong>?</p>
          <p className="text-muted">
            <FaEnvelope className="me-1" />
            Email: <strong>{selectedUser?.email}</strong>
          </p>
          <p className="text-muted small">The user will receive an email with instructions to reset their password. The link will expire in 1 hour.</p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowResetPasswordModal(false)} disabled={processing}>
            Cancel
          </Button>
          <Button 
            variant="info" 
            onClick={handleResetPassword} 
            disabled={processing}
          >
            {processing ? (
              <>
                <Spinner animation="border" size="sm" className="me-2" />
                Sending...
              </>
            ) : (
              <>
                <FaKey className="me-2" />
                Send Reset Email
              </>
            )}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default UserManagement;