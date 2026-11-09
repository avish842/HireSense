import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { io } from 'socket.io-client';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

const host = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
  ? window.location.origin
  : (typeof window !== 'undefined' && window.location.port === '3000' ? 'http://localhost:3000' : null);

const API_AUTH = host || 'http://localhost:3001';
const API_INGESTION = host || 'http://localhost:3002';
const API_WS = host || 'http://localhost:3005';

// ─── Logo SVG ───
const Logo = () => (
  <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
    <rect width="32" height="32" rx="8" fill="var(--accent)" fillOpacity="0.15" />
    <path d="M8 22L16 8L24 22H8Z" fill="var(--accent)" fillOpacity="0.6" />
    <path d="M12 22L16 14L20 22H12Z" fill="var(--accent)" />
  </svg>
);

// ─── Tab Icons ───
const TabIcons = {
  dashboard: '◫',
  recruiter: '◈',
  candidate: '◇'
};

function App() {
  // ── Auth State ──
  const [authState, setAuthState] = useState(() => {
    const stored = localStorage.getItem('autohire_auth');
    return stored ? JSON.parse(stored) : null;
  });
  const [authTab, setAuthTab] = useState('login');
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [registerForm, setRegisterForm] = useState({ email: '', password: '', role: 'CANDIDATE' });
  const [authError, setAuthError] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);

  // ── Theme State ──
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('autohire_theme') || 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('autohire_theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  // ── App State ──
  const [activeTab, setActiveTab] = useState('dashboard');
  const [jobs, setJobs] = useState([]);
  const [users, setUsers] = useState([]);
  const [applications, setApplications] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState(() => localStorage.getItem('selectedJobId') || '');
  const [systemLogs, setSystemLogs] = useState([]);
  const [selectedNotesApp, setSelectedNotesApp] = useState(null);

  const [newJob, setNewJob] = useState({
    title: '', description: '', required_skills: '', required_keywords: '',
    min_skill_hit_ratio: 0.3, ats_threshold: 50, score_threshold: 70, created_by: ''
  });
  const [recruiterMessage, setRecruiterMessage] = useState(null);
  const [newApp, setNewApp] = useState({ candidate_id: '', job_id: '', file: null });
  const [candidateMessage, setCandidateMessage] = useState(null);
  const [uploading, setUploading] = useState(false);

  // ── Helpers ──
  const getToken = useCallback(() => authState?.accessToken || null, [authState]);

  const authFetch = useCallback(async (url, options = {}) => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const headers = { ...options.headers, Authorization: `Bearer ${token}` };
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    const res = await fetch(url, { ...options, headers, credentials: 'include' });
    if (res.status === 401 || res.status === 403) {
      const refreshed = await refreshToken();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${refreshed.accessToken}`;
        return fetch(url, { ...options, headers, credentials: 'include' });
      }
      handleLogout();
      throw new Error('Session expired.');
    }
    return res;
  }, [authState]);

  // ── Auth Actions ──
  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const res = await fetch(`${API_AUTH}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm), credentials: 'include'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      const auth = { accessToken: data.accessToken, user: data.user };
      setAuthState(auth);
      localStorage.setItem('autohire_auth', JSON.stringify(auth));
    } catch (err) { setAuthError(err.message); }
    finally { setAuthLoading(false); }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const res = await fetch(`${API_AUTH}/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registerForm)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      setAuthTab('login');
      setLoginForm({ email: registerForm.email, password: registerForm.password });
      setAuthError(null);
    } catch (err) { setAuthError(err.message); }
    finally { setAuthLoading(false); }
  };

  const refreshToken = async () => {
    try {
      const res = await fetch(`${API_AUTH}/auth/refresh`, { method: 'POST', credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      const auth = { accessToken: data.accessToken, user: authState.user };
      setAuthState(auth);
      localStorage.setItem('autohire_auth', JSON.stringify(auth));
      return auth;
    } catch { return null; }
  };

  const handleLogout = async () => {
    try { await fetch(`${API_AUTH}/auth/logout`, { method: 'POST', credentials: 'include' }); } catch {}
    setAuthState(null);
    localStorage.removeItem('autohire_auth');
    setJobs([]); setUsers([]); setApplications([]); setSystemLogs([]);
  };

  // ── Data Fetching ──
  const fetchJobs = useCallback(async () => {
    if (!authState) return;
    try {
      const res = await authFetch(`${API_AUTH}/auth/jobs`);
      const data = await res.json();
      setJobs(data);
      if (data.length > 0) {
        const saved = localStorage.getItem('selectedJobId');
        if (saved && data.some(j => j.id === saved)) setSelectedJobId(saved);
        else { setSelectedJobId(data[0].id); localStorage.setItem('selectedJobId', data[0].id); }
      }
    } catch (err) { console.error('Error fetching jobs:', err); }
  }, [authState, authFetch]);

  const fetchUsers = useCallback(async () => {
    if (!authState) return;
    if (authState.user.role !== 'ADMIN') {
      setUsers([authState.user]);
      if (authState.user.role === 'RECRUITER') setNewJob(p => ({ ...p, created_by: authState.user.id }));
      if (authState.user.role === 'CANDIDATE') setNewApp(p => ({ ...p, candidate_id: authState.user.id }));
      return;
    }
    try {
      const res = await authFetch(`${API_AUTH}/auth/users`);
      const data = await res.json();
      setUsers(data);
      const recruiters = data.filter(u => u.role === 'RECRUITER');
      if (recruiters.length > 0) setNewJob(p => ({ ...p, created_by: recruiters[0].id }));
      const candidates = data.filter(u => u.role === 'CANDIDATE');
      if (candidates.length > 0) setNewApp(p => ({ ...p, candidate_id: candidates[0].id }));
    } catch (err) { console.error('Error fetching users:', err); }
  }, [authState, authFetch]);

  const fetchApplications = useCallback(async () => {
    if (!authState || authState.user.role === 'CANDIDATE') return;
    try {
      const res = await authFetch(`${API_AUTH}/auth/applications`);
      const data = await res.json();
      setApplications(data);
    } catch (err) { console.error('Error fetching applications:', err); }
  }, [authState, authFetch]);

  useEffect(() => { if (authState) { fetchJobs(); fetchUsers(); fetchApplications(); } }, [authState?.accessToken]);
  useEffect(() => { if (selectedJobId) setNewApp(p => ({ ...p, job_id: selectedJobId })); }, [selectedJobId]);

  // ── WebSocket ──
  useEffect(() => {
    if (!authState) return;
    const socket = io(API_WS);
    socket.on('connect', () => {
      setSystemLogs(p => [{ time: new Date().toLocaleTimeString(), message: 'Connected to pipeline monitor' }, ...p]);
    });
    socket.on('dashboard_update', (data) => {
      if (data.message) {
        setSystemLogs(p => [{ time: new Date().toLocaleTimeString(), message: data.message }, ...p]);
      } else if (data.type === 'LEADERBOARD_UPDATE') {
        setSystemLogs(p => [{ time: new Date().toLocaleTimeString(), message: `Score: ${data.score}%` }, ...p]);
      }
      fetchApplications();
    });
    return () => socket.disconnect();
  }, [authState, users]);

  // ── Polling ──
  useEffect(() => {
    if (!authState || authState.user.role === 'CANDIDATE') return;
    const active = applications.some(a => ['UPLOADED', 'PRE_FILTER_PASSED', 'EXTRACTED'].includes(a.status));
    const interval = setInterval(fetchApplications, active ? 1500 : 8000);
    return () => clearInterval(interval);
  }, [applications, authState]);

  // ── Computed Data ──
  const getProgressInfo = (status) => {
    const map = {
      'UPLOADED': { pct: 15, label: 'Ingested', cls: '' },
      'PRE_FILTER_PASSED': { pct: 40, label: 'Pre-Filter Passed', cls: '' },
      'PRE_FILTER_REJECTED': { pct: 100, label: 'Pre-Filter Fail', cls: 'danger' },
      'ATS_REJECTED': { pct: 100, label: 'ATS Rejected', cls: 'danger' },
      'EXTRACTED': { pct: 65, label: 'Extracted', cls: '' },
      'EXTRACTION_FAILED': { pct: 100, label: 'Extraction Failed', cls: 'danger' },
      'SCORED': { pct: 85, label: 'Scored', cls: '' },
      'INTERVIEW_SCHEDULED': { pct: 100, label: 'Interview Set', cls: 'success' },
    };
    return map[status] || { pct: 10, label: 'Processing', cls: '' };
  };

  const pipelineData = useMemo(() => {
    const filtered = applications.filter(a => a.job_id === selectedJobId);
    const stages = { UPLOADED: [], PRE_FILTER_PASSED: [], EXTRACTED: [], SCORED: [], INTERVIEW_SCHEDULED: [], REJECTED: [] };
    filtered.forEach(a => {
      if (['PRE_FILTER_REJECTED', 'ATS_REJECTED', 'EXTRACTION_FAILED'].includes(a.status)) stages.REJECTED.push(a);
      else if (stages[a.status]) stages[a.status].push(a);
      else stages.UPLOADED.push(a);
    });
    return stages;
  }, [applications, selectedJobId]);

  const leaderboard = useMemo(() =>
    applications.filter(a => a.job_id === selectedJobId && a.final_score !== null)
      .map(a => ({ id: a.id, email: a.candidate_email, score: a.final_score }))
      .sort((a, b) => b.score - a.score),
    [applications, selectedJobId]
  );

  const rejectionData = useMemo(() => {
    const filtered = applications.filter(a => a.job_id === selectedJobId);
    return [
      { name: 'Pre-filter', value: filtered.filter(a => a.status === 'PRE_FILTER_REJECTED').length },
      { name: 'ATS', value: filtered.filter(a => a.status === 'ATS_REJECTED').length },
      { name: 'Extraction', value: filtered.filter(a => a.status === 'EXTRACTION_FAILED').length },
    ];
  }, [applications, selectedJobId]);

  const stats = useMemo(() => {
    const filtered = applications.filter(a => a.job_id === selectedJobId);
    return {
      total: filtered.length,
      active: filtered.filter(a => !['PRE_FILTER_REJECTED', 'ATS_REJECTED', 'EXTRACTION_FAILED'].includes(a.status)).length,
      interviews: filtered.filter(a => a.status === 'INTERVIEW_SCHEDULED').length,
      rejected: filtered.filter(a => ['PRE_FILTER_REJECTED', 'ATS_REJECTED', 'EXTRACTION_FAILED'].includes(a.status)).length,
    };
  }, [applications, selectedJobId]);

  const hasRejections = rejectionData.some(d => d.value > 0);
  const PIE_COLORS = theme === 'dark'
    ? ['#e8a23a', '#e5484d', '#6f6e6b']
    : ['#2563eb', '#991b1b', '#64748b'];

  // ── Form Handlers ──
  const handleRecruiterSubmit = async (e) => {
    e.preventDefault();
    setRecruiterMessage(null);
    const payload = {
      ...newJob,
      required_skills: newJob.required_skills.split(',').map(s => s.trim()).filter(Boolean),
      required_keywords: newJob.required_keywords.split(',').map(k => k.trim()).filter(Boolean)
    };
    try {
      const res = await authFetch(`${API_AUTH}/auth/jobs`, { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json();
      if (res.ok) {
        setRecruiterMessage({ type: 'success', text: `Job "${data.title}" created.` });
        setNewJob(p => ({ title: '', description: '', required_skills: '', required_keywords: '', min_skill_hit_ratio: 0.3, ats_threshold: 50, score_threshold: 70, created_by: p.created_by }));
        fetchJobs();
      } else {
        setRecruiterMessage({ type: 'danger', text: data.error || 'Failed.' });
      }
    } catch (err) { setRecruiterMessage({ type: 'danger', text: err.message }); }
  };

  const handleCandidateSubmit = async (e) => {
    e.preventDefault();
    setCandidateMessage(null);
    if (!newApp.file) { setCandidateMessage({ type: 'danger', text: 'Select a resume PDF.' }); return; }
    setUploading(true);
    const formData = new FormData();
    formData.append('candidate_id', newApp.candidate_id || authState.user.id);
    formData.append('job_id', newApp.job_id);
    formData.append('resume', newApp.file);
    try {
      const res = await authFetch(`${API_INGESTION}/ingestion/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        setCandidateMessage({ type: 'success', text: 'Resume uploaded. Pipeline triggered.' });
        setNewApp(p => ({ ...p, file: null }));
        document.getElementById('resume-file-input').value = '';
        fetchApplications();
      } else { setCandidateMessage({ type: 'danger', text: data.error || 'Failed.' }); }
    } catch (err) { setCandidateMessage({ type: 'danger', text: err.message }); }
    finally { setUploading(false); }
  };

  const userRole = authState?.user?.role;
  const canDash = userRole === 'ADMIN' || userRole === 'RECRUITER';
  const canRecruit = userRole === 'ADMIN' || userRole === 'RECRUITER';
  const canApply = userRole === 'ADMIN' || userRole === 'CANDIDATE';

  // ════════════════════════════════════════════
  //  AUTH SCREEN
  // ════════════════════════════════════════════
  if (!authState) {
    return (
      <div className="auth-wrapper">
        <div className="auth-card">
          <div className="auth-brand">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}><Logo /></div>
            <div className="auth-brand-name">Hire<span>Sense</span></div>
            <div className="auth-brand-tagline">Autonomous Recruitment Pipeline</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <button className="theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
          <div className="auth-panel">
            <div className="auth-tabs">
              <button className={`auth-tab ${authTab === 'login' ? 'active' : ''}`} onClick={() => { setAuthTab('login'); setAuthError(null); }}>Sign In</button>
              <button className={`auth-tab ${authTab === 'register' ? 'active' : ''}`} onClick={() => { setAuthTab('register'); setAuthError(null); }}>Register</button>
            </div>

            {authError && <div className="alert alert-danger">⚠ {authError}</div>}

            {authTab === 'login' && (
              <form onSubmit={handleLogin}>
                <label>Email</label>
                <input type="email" placeholder="you@company.com" value={loginForm.email} onChange={e => setLoginForm(p => ({ ...p, email: e.target.value }))} required />
                <label>Password</label>
                <input type="password" placeholder="••••••••" value={loginForm.password} onChange={e => setLoginForm(p => ({ ...p, password: e.target.value }))} required />
                <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 4 }} disabled={authLoading}>
                  {authLoading ? 'Signing in…' : 'Sign In'}
                </button>
              </form>
            )}

            {authTab === 'register' && (
              <form onSubmit={handleRegister}>
                <label>Email</label>
                <input type="email" placeholder="you@company.com" value={registerForm.email} onChange={e => setRegisterForm(p => ({ ...p, email: e.target.value }))} required />
                <label>Password</label>
                <input type="password" placeholder="Min 6 characters" value={registerForm.password} onChange={e => setRegisterForm(p => ({ ...p, password: e.target.value }))} required minLength={6} />
                <label>Role</label>
                <select value={registerForm.role} onChange={e => setRegisterForm(p => ({ ...p, role: e.target.value }))}>
                  <option value="CANDIDATE">Candidate</option>
                  <option value="RECRUITER">Recruiter</option>
                  <option value="ADMIN">Admin</option>
                </select>
                <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 4 }} disabled={authLoading}>
                  {authLoading ? 'Creating…' : 'Create Account'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════
  //  MAIN APPLICATION
  // ════════════════════════════════════════════
  const selectedJob = jobs.find(j => j.id === selectedJobId);
  const initials = authState.user.email?.substring(0, 2).toUpperCase() || '??';

  return (
    <div className="app-shell">
      {/* ── Top Bar ── */}
      <header className="topbar">
        <div className="topbar-brand">
          <Logo />
          <div className="topbar-logo">Hire<span>Sense</span></div>
        </div>
        <div className="topbar-right">
          <div className="topbar-user">
            <div className="topbar-user-info">
              <div className="topbar-user-email">{authState.user.email}</div>
              <div className="topbar-user-role">{authState.user.role}</div>
            </div>
            <div className="topbar-avatar">{initials}</div>
          </div>
          <button className="theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button className="btn-logout" onClick={handleLogout}>Sign out</button>
        </div>
      </header>

      <main className="container">
        {/* ── Nav Tabs ── */}
        <nav className="nav-tabs">
          {canDash && (
            <button className={`nav-tab ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
              <span className="nav-tab-icon">{TabIcons.dashboard}</span> Dashboard
            </button>
          )}
          {canRecruit && (
            <button className={`nav-tab ${activeTab === 'recruiter' ? 'active' : ''}`} onClick={() => setActiveTab('recruiter')}>
              <span className="nav-tab-icon">{TabIcons.recruiter}</span> Requirements
            </button>
          )}
          {canApply && (
            <button className={`nav-tab ${activeTab === 'candidate' ? 'active' : ''}`} onClick={() => setActiveTab('candidate')}>
              <span className="nav-tab-icon">{TabIcons.candidate}</span> Apply
            </button>
          )}
        </nav>

        {/* ════════ DASHBOARD ════════ */}
        {activeTab === 'dashboard' && canDash && (
          <>
            {/* Job Selector */}
            <div className="card">
              <div className="job-selector">
                <div className="job-selector-main">
                  <label>Active Job Profile</label>
                  <select value={selectedJobId} onChange={e => { setSelectedJobId(e.target.value); localStorage.setItem('selectedJobId', e.target.value); }}>
                    {jobs.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
                  </select>
                </div>
                {selectedJob && (
                  <div className="job-selector-meta">
                    <strong>Skills:</strong> {JSON.stringify(selectedJob.required_skills)}<br />
                    <strong>ATS:</strong> {selectedJob.ats_threshold}% &nbsp;·&nbsp; <strong>Score:</strong> {selectedJob.score_threshold}%
                  </div>
                )}
              </div>
            </div>

            {/* Stats */}
            <div className="stats-row">
              <div className="stat-card">
                <div className="stat-label">Total Candidates</div>
                <div className="stat-value">{stats.total}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">In Pipeline</div>
                <div className="stat-value accent">{stats.active}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Interviews</div>
                <div className="stat-value success">{stats.interviews}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Rejected</div>
                <div className="stat-value danger">{stats.rejected}</div>
              </div>
            </div>

            {/* Kanban */}
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title"><span className="card-title-icon">◫</span> Pipeline</div>
                  <div className="card-subtitle">Real-time candidate flow across screening stages</div>
                </div>
                <span className="badge badge-accent pulse">● Live</span>
              </div>
              <div className="kanban-board">
                {Object.entries(pipelineData).map(([stage, apps]) => (
                  <div className="kanban-col" key={stage}>
                    <div className="kanban-col-header">
                      <span className="kanban-col-title">{stage.replace(/_/g, ' ')}</span>
                      <span className="kanban-col-count">{apps.length}</span>
                    </div>
                    {apps.map(app => {
                      const pi = getProgressInfo(app.status);
                      return (
                        <div className="kanban-card" key={app.id}>
                          <div className="kanban-card-email">{app.candidate_email}</div>
                          <div className="kanban-card-time">{new Date(app.created_at).toLocaleTimeString()}</div>
                          {app.pre_filter_hit_ratio !== null && (
                            <div className="kanban-card-metric">Pre-filter: <strong>{(app.pre_filter_hit_ratio * 100).toFixed(0)}%</strong></div>
                          )}
                          {app.ats_score !== null && (
                            <div className="kanban-card-metric">ATS: <strong>{app.ats_score}/100</strong></div>
                          )}
                          {app.final_score !== null && (
                            <div style={{ marginTop: 6 }}><span className="badge badge-success">Match {app.final_score}%</span></div>
                          )}
                          {app.rejection_reason && (
                            <div className="kanban-card-rejection">
                              <strong>Rejected:</strong> {app.rejection_reason} ({app.rejection_stage})
                            </div>
                          )}
                          <div className="progress-track">
                            <div className={`progress-fill ${pi.cls}`} style={{ width: `${pi.pct}%` }} />
                          </div>
                          <div className="progress-label"><span>{pi.label}</span><span>{pi.pct}%</span></div>

                          {app.interviewer_notes && app.status === 'INTERVIEW_SCHEDULED' && (
                            <button className="btn-briefing" onClick={() => setSelectedNotesApp(app)}>
                              📋 Interviewer Briefing
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {apps.length === 0 && <div className="kanban-empty">No candidates</div>}
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom Grid */}
            <div className="grid-2">
              {/* Leaderboard */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title"><span className="card-title-icon">▲</span> Leaderboard</div>
                </div>
                {leaderboard.length === 0 ? (
                  <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>No scored candidates yet.</p>
                ) : (
                  <table>
                    <thead><tr><th>#</th><th>Candidate</th><th>Score</th></tr></thead>
                    <tbody>
                      {leaderboard.map((c, i) => (
                        <tr key={c.id}>
                          <td><span className={`rank-cell ${i < 3 ? 'top' : ''}`}>#{i + 1}</span></td>
                          <td style={{ color: 'var(--text-primary)' }}>{c.email}</td>
                          <td><span className="badge badge-success">{c.score}%</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Events + Analytics */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title"><span className="card-title-icon">⚡</span> Pipeline Events</div>
                </div>
                <div className="event-log">
                  {systemLogs.length === 0 ? (
                    <div className="event-log-empty">Awaiting pipeline activity…</div>
                  ) : (
                    systemLogs.slice(0, 30).map((log, i) => (
                      <div className="event-log-entry" key={i}>
                        <span className="event-log-time">{log.time}</span>
                        <span className={`event-log-msg ${log.message.toLowerCase().includes('fail') || log.message.toLowerCase().includes('reject') ? 'error' : ''}`}>
                          {log.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                <div style={{ marginTop: 24 }}>
                  <div className="card-title" style={{ marginBottom: 12 }}><span className="card-title-icon">◔</span> Rejection Breakdown</div>
                  {!hasRejections ? (
                    <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>No rejections recorded.</p>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                      <div style={{ width: 130, height: 130 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={rejectionData.filter(d => d.value > 0)} cx="50%" cy="50%" innerRadius={35} outerRadius={55} paddingAngle={4} dataKey="value" strokeWidth={0}>
                              {rejectionData.filter(d => d.value > 0).map((_, i) => (
                                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 2 }}>
                        {rejectionData.filter(d => d.value > 0).map((d, i) => (
                          <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: PIE_COLORS[i], display: 'inline-block' }} />
                            {d.name}: <strong style={{ color: 'var(--text-primary)' }}>{d.value}</strong>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ════════ RECRUITER ════════ */}
        {activeTab === 'recruiter' && canRecruit && (
          <div style={{ maxWidth: 580, margin: '0 auto' }}>
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title"><span className="card-title-icon">◈</span> New Job Requirement</div>
                  <div className="card-subtitle">AI agents will evaluate candidates against this profile</div>
                </div>
              </div>

              {recruiterMessage && (
                <div className={`alert alert-${recruiterMessage.type}`}>
                  {recruiterMessage.type === 'success' ? '✓' : '⚠'} {recruiterMessage.text}
                </div>
              )}

              <form onSubmit={handleRecruiterSubmit}>
                {userRole === 'ADMIN' && (
                  <>
                    <label>Recruiter</label>
                    <select value={newJob.created_by} onChange={e => setNewJob(p => ({ ...p, created_by: e.target.value }))}>
                      {users.filter(u => u.role === 'RECRUITER' || u.role === 'ADMIN').map(u => (
                        <option key={u.id} value={u.id}>{u.email} ({u.role})</option>
                      ))}
                    </select>
                  </>
                )}

                <label>Job Title</label>
                <input type="text" placeholder="e.g. Senior Backend Engineer" value={newJob.title} onChange={e => setNewJob(p => ({ ...p, title: e.target.value }))} required />

                <label>Description</label>
                <textarea rows="4" placeholder="Job description and duties…" value={newJob.description} onChange={e => setNewJob(p => ({ ...p, description: e.target.value }))} required />

                <label>Required Skills</label>
                <input type="text" placeholder="Node.js, Express, Kafka, PostgreSQL" value={newJob.required_skills} onChange={e => setNewJob(p => ({ ...p, required_skills: e.target.value }))} required />

                <label>ATS Keywords</label>
                <input type="text" placeholder="API, Backend, Scalable, Architect" value={newJob.required_keywords} onChange={e => setNewJob(p => ({ ...p, required_keywords: e.target.value }))} required />

                <div className="form-row">
                  <div>
                    <label>Min Skill Ratio</label>
                    <input type="number" step="0.1" min="0" max="1" value={newJob.min_skill_hit_ratio} onChange={e => setNewJob(p => ({ ...p, min_skill_hit_ratio: parseFloat(e.target.value) }))} required />
                  </div>
                  <div>
                    <label>ATS Threshold</label>
                    <input type="number" min="0" max="100" value={newJob.ats_threshold} onChange={e => setNewJob(p => ({ ...p, ats_threshold: parseInt(e.target.value) }))} required />
                  </div>
                  <div>
                    <label>Score Threshold</label>
                    <input type="number" min="0" max="100" value={newJob.score_threshold} onChange={e => setNewJob(p => ({ ...p, score_threshold: parseInt(e.target.value) }))} required />
                  </div>
                </div>

                <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>Create Requirement Profile</button>
              </form>
            </div>
          </div>
        )}

        {/* ════════ CANDIDATE ════════ */}
        {activeTab === 'candidate' && canApply && (
          <div style={{ maxWidth: 580, margin: '0 auto' }}>
            <div className="card">
              <div className="card-header">
                <div>
                  <div className="card-title"><span className="card-title-icon">◇</span> Submit Application</div>
                  <div className="card-subtitle">Upload your resume to trigger the autonomous screening pipeline</div>
                </div>
              </div>

              {candidateMessage && (
                <div className={`alert alert-${candidateMessage.type}`}>
                  {candidateMessage.type === 'success' ? '✓' : '⚠'} {candidateMessage.text}
                </div>
              )}

              <form onSubmit={handleCandidateSubmit}>
                {userRole === 'ADMIN' && (
                  <>
                    <label>Candidate</label>
                    <select value={newApp.candidate_id} onChange={e => setNewApp(p => ({ ...p, candidate_id: e.target.value }))}>
                      {users.filter(u => u.role === 'CANDIDATE').map(u => (
                        <option key={u.id} value={u.id}>{u.email}</option>
                      ))}
                    </select>
                  </>
                )}

                <label>Vacancy</label>
                <select value={newApp.job_id} onChange={e => setNewApp(p => ({ ...p, job_id: e.target.value }))}>
                  {jobs.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
                </select>

                <label>Resume (PDF)</label>
                <input id="resume-file-input" type="file" accept=".pdf" onChange={e => setNewApp(p => ({ ...p, file: e.target.files[0] }))} required />

                <div className="tip-box">
                  💡 Test with sample resumes:
                  <ul>
                    <li><code>strong_match.pdf</code> — passes all checks</li>
                    <li><code>borderline.pdf</code> — borderline ATS score</li>
                    <li><code>clear_reject.pdf</code> — immediate rejection</li>
                  </ul>
                </div>

                <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={uploading}>
                  {uploading ? 'Uploading & Encrypting…' : 'Submit Application'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Candidate fallback */}
        {activeTab === 'dashboard' && !canDash && (
          <div className="card welcome-panel">
            <h2>Welcome, {authState.user.email}</h2>
            <p>Use the <strong>Apply</strong> tab to submit your resume.</p>
          </div>
        )}
      </main>

      {/* ════════ MODAL ════════ */}
      {selectedNotesApp && (
        <div className="modal-overlay" onClick={() => setSelectedNotesApp(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title">Interviewer Briefing</div>
                <div className="modal-desc">{selectedNotesApp.candidate_email} · {selectedNotesApp.job_title} · Match {selectedNotesApp.final_score}%</div>
              </div>
              <button className="modal-x" onClick={() => setSelectedNotesApp(null)}>×</button>
            </div>
            <div className="modal-body">
              <div className="briefing-meta">
                📅 <strong>Scheduled:</strong> {new Date(selectedNotesApp.scheduled_at).toLocaleString()}<br />
                🔗 <strong>Link:</strong> <a href={selectedNotesApp.meeting_link} target="_blank" rel="noopener noreferrer">{selectedNotesApp.meeting_link}</a>
              </div>
              <div className="briefing-text">{selectedNotesApp.interviewer_notes}</div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setSelectedNotesApp(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
