import { useState } from 'react';
import { post } from '../api.js';
import { ErrorNote } from '../ui.jsx';
import DaysEditor from './DaysEditor.jsx';

export default function Setup({ onDone, tokenRequired }) {
  const [f, setF] = useState({ name: '', email: '', password: '', eventName: 'Flytime Fest 2026', setupToken: '' });
  const [dates, setDates] = useState(['2026-12-20', '2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25']);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await post('/auth/setup', { ...f, dates });
      await onDone();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="auth-page">
      <form className="card auth-card auth-card-wide" onSubmit={submit}>
        <h1>Set up the platform</h1>
        <p className="muted">Create the first Admin account and the event.</p>
        {tokenRequired && (
          <label>Setup code<input value={f.setupToken} onChange={set('setupToken')} required autoComplete="off" /><span className="hint">The SETUP_TOKEN value from the server's .env file</span></label>
        )}
        <fieldset>
          <legend>Your Admin account</legend>
          <label>Name<input value={f.name} onChange={set('name')} required /></label>
          <label>Email<input type="email" value={f.email} onChange={set('email')} required /></label>
          <label>Password<input type="password" minLength={8} value={f.password} onChange={set('password')} required /><span className="hint">At least 8 characters</span></label>
        </fieldset>
        <fieldset>
          <legend>Event</legend>
          <label>Event name<input value={f.eventName} onChange={set('eventName')} required /></label>
          <DaysEditor dates={dates} onChange={setDates} />
        </fieldset>
        <ErrorNote error={error} />
        <button className="btn btn-primary btn-block">Create Admin and event</button>
      </form>
    </div>
  );
}
