import { fmtDate } from '../format.js';

/** Pick a start date and number of days, or edit dates one by one. */
export default function DaysEditor({ dates, onChange }) {
  const setFromRange = (start, count) => {
    if (!start || !count) return;
    const out = [];
    const d = new Date(start + 'T00:00:00Z');
    for (let i = 0; i < count; i++) {
      out.push(new Date(d.getTime() + i * 864e5).toISOString().slice(0, 10));
    }
    onChange(out);
  };
  return (
    <div className="days-editor">
      <div className="row gap">
        <label>First day<input type="date" value={dates[0] || ''} onChange={(e) => setFromRange(e.target.value, dates.length || 1)} /></label>
        <label>Number of days<input type="number" min="1" max="31" value={dates.length || ''} onChange={(e) => setFromRange(dates[0], Math.max(1, Math.min(31, Number(e.target.value))))} /></label>
      </div>
      {dates.length > 0 && (
        <div className="chips">
          {dates.map((d, i) => (
            <span className="chip" key={i}>
              Day {i + 1}:
              <input type="date" value={d} onChange={(e) => onChange(dates.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Day ${i + 1} date`} />
              <button type="button" className="btn-icon" aria-label="Remove day" onClick={() => onChange(dates.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      {dates.length > 0 && <p className="muted small">{fmtDate(dates[0])} – {fmtDate(dates[dates.length - 1])}</p>}
    </div>
  );
}
