'use client';
import { useState } from 'react';

const TYPE_COLORS = {
  elevation:       '#7c3aed',
  floor_plan:      '#0891b2',
  unit_schedule:   '#0d9488',
  amenity:         '#ea580c',
  finish_schedule: '#d97706',
  cover_sheet:     '#6b7280',
  site_plan:       '#6b7280',
  detail:          '#9ca3af',
  other:           '#d1d5db',
};

const TYPE_LABELS = {
  elevation:       'Elevations',
  floor_plan:      'Floor Plans',
  unit_schedule:   'Unit Schedules',
  amenity:         'Amenity Areas',
  finish_schedule: 'Finish Schedules',
  cover_sheet:     'Cover Sheets',
  site_plan:       'Site Plans',
  detail:          'Details',
  other:           'Other',
};

export default function PageClassifier({ pdfBase64, onComplete }) {
  const [loading, setLoading]   = useState(false);
  const [result,  setResult]    = useState(null);
  const [error,   setError]     = useState(null);
  const [filter,  setFilter]    = useState('all');

  const runClassification = async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/takeoff/classify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ pdfBase64 }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Classification failed');
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const filteredPages = result
    ? filter === 'all'
      ? result.classification
      : result.classification.filter(p => p.type === filter)
    : [];

  return (
    <div style={{ padding: '24px', fontFamily: 'sans-serif', maxWidth: '960px', margin: '0 auto' }}>

      <h2 style={{ marginBottom: '6px', color: '#111827' }}>Step 1 — Classify Plan Pages</h2>
      <p style={{ color: '#6b7280', marginBottom: '28px', lineHeight: '1.5' }}>
        The AI scans every page and identifies elevations, floor plans, schedules, and amenity areas.
        Downstream agents will only receive the pages they need — keeping each call fast and accurate.
      </p>

      {/* Run button */}
      {!result && (
        <button
          onClick={runClassification}
          disabled={loading}
          style={{
            background:    loading ? '#9ca3af' : '#7c3aed',
            color:         'white',
            border:        'none',
            borderRadius:  '8px',
            padding:       '13px 32px',
            fontSize:      '15px',
            fontWeight:    '600',
            cursor:        loading ? 'not-allowed' : 'pointer',
            letterSpacing: '0.01em',
          }}
        >
          {loading ? '⏳ Classifying pages — this takes about 30 seconds…' : '🔍 Run Page Classification'}
        </button>
      )}

      {/* Error state */}
      {error && (
        <div style={{
          background:   '#fef2f2',
          border:       '1px solid #fca5a5',
          borderRadius: '8px',
          padding:      '16px',
          marginTop:    '16px',
          color:        '#dc2626',
        }}>
          ❌ {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div>

          {/* Summary cards */}
          <div style={{
            display:             'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap:                 '12px',
            marginBottom:        '28px',
          }}>
            {Object.entries(result.summary).map(([type, count]) => (
              <div
                key={type}
                onClick={() => setFilter(filter === type ? 'all' : type)}
                style={{
                  background:   filter === type ? `${TYPE_COLORS[type]}15` : 'white',
                  border:       `2px solid ${filter === type ? TYPE_COLORS[type] : '#e5e7eb'}`,
                  borderRadius: '10px',
                  padding:      '14px 10px',
                  textAlign:    'center',
                  cursor:       'pointer',
                  transition:   'border-color 0.15s',
                }}
              >
                <div style={{ fontSize: '26px', fontWeight: '700', color: TYPE_COLORS[type] || '#374151' }}>
                  {count}
                </div>
                <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
                  {TYPE_LABELS[type] || type}
                </div>
              </div>
            ))}
          </div>

          {/* Unit types banner */}
          {result.unitTypesFound.length > 0 && (
            <div style={{
              background:   '#f5f3ff',
              border:       '1px solid #ddd6fe',
              borderRadius: '8px',
              padding:      '14px 18px',
              marginBottom: '24px',
              fontSize:     '14px',
            }}>
              <strong style={{ color: '#5b21b6' }}>
                {result.unitTypesFound.length} unit types found:
              </strong>{' '}
              <span style={{ color: '#374151' }}>{result.unitTypesFound.join(', ')}</span>
            </div>
          )}

          {/* Filter pills */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
            {['all', ...Object.keys(result.summary)].map(type => (
              <button
                key={type}
                onClick={() => setFilter(type)}
                style={{
                  background:   filter === type ? (TYPE_COLORS[type] || '#374151') : '#f9fafb',
                  color:        filter === type ? 'white' : '#374151',
                  border:       `1px solid ${filter === type ? (TYPE_COLORS[type] || '#374151') : '#e5e7eb'}`,
                  borderRadius: '20px',
                  padding:      '5px 14px',
                  fontSize:     '13px',
                  cursor:       'pointer',
                }}
              >
                {type === 'all' ? `All (${result.totalPages})` : `${TYPE_LABELS[type] || type} (${result.summary[type]})`}
              </button>
            ))}
          </div>

          {/* Classification table */}
          <div style={{ overflowX: 'auto', marginBottom: '32px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ textAlign: 'left', padding: '10px 14px', borderBottom: '2px solid #e5e7eb', color: '#374151' }}>Page</th>
                  <th style={{ textAlign: 'left', padding: '10px 14px', borderBottom: '2px solid #e5e7eb', color: '#374151' }}>Type</th>
                  <th style={{ textAlign: 'left', padding: '10px 14px', borderBottom: '2px solid #e5e7eb', color: '#374151' }}>Label</th>
                  <th style={{ textAlign: 'left', padding: '10px 14px', borderBottom: '2px solid #e5e7eb', color: '#374151' }}>Unit Type</th>
                </tr>
              </thead>
              <tbody>
                {filteredPages.map((page) => (
                  <tr key={page.page} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 14px', fontWeight: '600', color: '#111827' }}>
                      {page.page}
                    </td>
                    <td style={{ padding: '8px 14px' }}>
                      <span style={{
                        background:   `${TYPE_COLORS[page.type] || '#e5e7eb'}18`,
                        color:        TYPE_COLORS[page.type] || '#374151',
                        border:       `1px solid ${TYPE_COLORS[page.type] || '#e5e7eb'}`,
                        borderRadius: '4px',
                        padding:      '2px 9px',
                        fontSize:     '12px',
                        fontWeight:   '600',
                      }}>
                        {page.type}
                      </span>
                    </td>
                    <td style={{ padding: '8px 14px', color: '#374151' }}>{page.label}</td>
                    <td style={{ padding: '8px 14px', color: '#7c3aed', fontWeight: '600' }}>
                      {page.unit_type || <span style={{ color: '#d1d5db' }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Continue button */}
          <button
            onClick={() => onComplete(result)}
            style={{
              background:    '#16a34a',
              color:         'white',
              border:        'none',
              borderRadius:  '8px',
              padding:       '13px 36px',
              fontSize:      '15px',
              fontWeight:    '600',
              cursor:        'pointer',
              letterSpacing: '0.01em',
            }}
          >
            Continue to Takeoff →
          </button>
          <p style={{ color: '#9ca3af', fontSize: '13px', marginTop: '10px' }}>
            The takeoff agents will only read the elevation and schedule pages identified above.
          </p>

        </div>
      )}
    </div>
  );
}
