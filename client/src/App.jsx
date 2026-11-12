import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { get, post, onConnectionChange } from './api.js';
import { ToastProvider } from './ui.jsx';
import { ROLE_LABEL } from './format.js';
import Login from './pages/Login.jsx';
import Setup from './pages/Setup.jsx';
import Invite from './pages/Invite.jsx';
import Overview from './pages/Overview.jsx';
import Upload from './pages/Upload.jsx';
import Zones from './pages/Zones.jsx';
import Queue from './pages/Queue.jsx';
import ReviewTable from './pages/ReviewTable.jsx';
import Accredit from './pages/Accredit.jsx';
import Reconcile from './pages/Reconcile.jsx';
import Users from './pages/Users.jsx';
import Settings from './pages/Settings.jsx';
import Audit from './pages/Audit.jsx';

const SessionCtx = createContext(null);
export const useSession = () => useContext(SessionCtx);

const HOME = { admin: '/overview', reviewer: '/review', accreditor: '/accredit' };

const NAV = [
  { to: '/overview', label: 'Overview', roles: ['admin'] },
  { to: '/upload', label: 'Upload', roles: ['admin'] },
  { to: '/zones', label: 'Zones', roles: ['admin', 'reviewer'] },
  { to: '/review', label: 'Review', roles: ['admin', 'reviewer'] },
  { to: '/accredit', label: 'Accredit', roles: ['admin', 'reviewer', 'accreditor'] },
  { to: '/reconcile', label: 'Reconciliation', roles: ['admin', 'reviewer'] },
  { to: '/users', label: 'Users', roles: ['admin'] },
  { to: '/settings', label: 'Event', roles: ['admin'] },
  { to: '/audit', label: 'Audit log', roles: ['admin'] },
];

function ConnectionBanner() {
  const [offline, setOffline] = useState(false);
  useEffect(() => onConnectionChange(setOffline), []);
  if (!offline) return null;
  return <div className="conn-banner" role="alert">Weak or no connection. Your last action may not have saved — check the card and try again.</div>;
}

export default function App() {
  const [state, setState] = useState(null);
  const [eventCtx, setEventCtx] = useState(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    const s = await get('/auth/state');
    // Load the event before rendering signed-in screens so they never see a missing context.
    const ev = s.user ? await get('/event') : null;
    setEventCtx(ev);
    setState(s);
  }, []);

  useEffect(() => {
    refresh().catch(() => setState({ error: true }));
    const onExpired = () => refresh();
    window.addEventListener('auth-expired', onExpired);
    return () => window.removeEventListener('auth-expired', onExpired);
  }, [refresh]);

  const reloadEvent = useCallback(async () => setEventCtx(await get('/event')), []);

  if (!state) return <div className="boot">Loading…</div>;
  if (state.error) return <div className="boot">Cannot reach the server. <button className="btn" onClick={() => location.reload()}>Retry</button></div>;

  if (location.pathname.startsWith('/invite/')) {
    return <ToastProvider><Routes><Route path="/invite/:token" element={<Invite onDone={refresh} />} /></Routes></ToastProvider>;
  }
  if (state.needsSetup) return <ToastProvider><Setup onDone={refresh} tokenRequired={state.setupTokenRequired} /></ToastProvider>;
  if (!state.user) return <ToastProvider><Login onDone={refresh} /></ToastProvider>;

  if (!eventCtx) return <div className="boot">Loading…</div>;
  const user = state.user;
  const logout = async () => { await post('/auth/logout'); navigate('/'); refresh(); };
  const items = NAV.filter((n) => n.roles.includes(user.role));

  return (
    <SessionCtx.Provider value={{ user, event: eventCtx, reloadEvent }}>
      <ToastProvider>
        <ConnectionBanner />
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden>✓</span>
            <span className="brand-name">{eventCtx?.event?.name || 'Accreditation'}</span>
          </div>
          <nav className="nav">
            {items.map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}
          </nav>
          <div className="me">
            <span className="me-name" title={user.email}>{user.name || user.email}</span>
            <span className="me-role">{ROLE_LABEL[user.role]}</span>
            <button className="btn btn-ghost btn-sm" onClick={logout}>Sign out</button>
          </div>
        </header>
        <main className="main">
          {!eventCtx?.event && user.role !== 'admin' ? (
            <div className="empty">The event has not been set up yet. Ask an Admin.</div>
          ) : (
            <Routes>
              <Route path="/" element={<Navigate to={HOME[user.role]} replace />} />
              {can(user, 'admin') && <Route path="/overview" element={<Overview />} />}
              {can(user, 'admin') && <Route path="/upload" element={<Upload />} />}
              {can(user, 'reviewer') && <Route path="/zones" element={<Zones />} />}
              {can(user, 'reviewer') && <Route path="/review" element={<Queue />} />}
              {can(user, 'reviewer') && <Route path="/review/:id" element={<ReviewTable />} />}
              <Route path="/accredit" element={<Accredit />} />
              {can(user, 'reviewer') && <Route path="/reconcile" element={<Reconcile />} />}
              {can(user, 'admin') && <Route path="/users" element={<Users />} />}
              {can(user, 'admin') && <Route path="/settings" element={<Settings />} />}
              {can(user, 'admin') && <Route path="/audit" element={<Audit />} />}
              <Route path="*" element={<Navigate to={HOME[user.role]} replace />} />
            </Routes>
          )}
        </main>
      </ToastProvider>
    </SessionCtx.Provider>
  );
}

function can(user, role) {
  return user.role === 'admin' || user.role === role;
}
