export const fmtDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
export const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
export const ROLE_LABEL = { admin: 'Admin', reviewer: 'Reviewer', accreditor: 'Accreditor' };
export const STATUS_LABEL = { uploaded: 'Uploaded', in_review: 'In review', published: 'Published', pending: 'Pending', zoned: 'Zoned', removed: 'Removed' };
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
