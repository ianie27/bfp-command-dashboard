// ============================================================
// ThreatBadge.jsx
// Small pill that renders a threat level with the right color.
// ============================================================

import React from 'react';

const STYLES = {
  RED:    { background: 'rgba(239, 68, 68, 0.2)',   color: '#f87171' },
  YELLOW: { background: 'rgba(234, 179, 8, 0.2)',   color: '#facc15' },
  NORMAL: { background: 'rgba(16, 185, 129, 0.2)',  color: '#34d399' },
};

export default function ThreatBadge({ level }) {
  if (!level) {
    return <span style={{ color: '#64748b' }}>N/A</span>;
  }

  const style = STYLES[level] || {
    background: 'rgba(100, 116, 139, 0.2)',
    color: '#94a3b8',
  };

  return (
    <span
      style={{
        display: 'inline-block',
        borderRadius: 9999,
        padding: '2px 10px',
        fontSize: '0.75rem',
        fontWeight: 600,
        ...style,
      }}
    >
      {level}
    </span>
  );
}