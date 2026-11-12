import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../api.js';
import { ErrorNote } from '../ui.jsx';
import { ROLE_LABEL } from '../format.js';

export default function Invite({ onDone }) {
  const { token } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    get(`/invite/${token}`).then((d) => { setInfo(d); setName(d.name || ''); }).catch(setError);
  }, [token]);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await post(`/invite/${token}`, { name, password });
      navigate('/', { replace: true });
      await onDone();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Welcome</h1>
        {info ? (
          <>
            <p className="muted">{info.email} · {ROLE_LABEL[info.role]}</p>
            <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
            <label>Choose a password<input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" /></label>
            <ErrorNote error={error} />
            <button className="btn btn-primary btn-block">Set password and sign in</button>
          </>
        ) : (
          <ErrorNote error={error} />
        )}
      </form>
    </div>
  );
}
