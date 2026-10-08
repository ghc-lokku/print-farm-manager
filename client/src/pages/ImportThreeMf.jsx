import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../useToast';

const COLOR_NAME_TO_HEX = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF',
  yellow: '#FFFF00', orange: '#FFA500', purple: '#800080', pink: '#FFC0CB', brown: '#A52A2A',
  gray: '#808080', grey: '#808080', silver: '#C0C0C0', cyan: '#00FFFF', magenta: '#FF00FF',
  teal: '#008080', maroon: '#800000', navy: '#000080', olive: '#808000', lime: '#00FF00',
  fuchsia: '#FF00FF', aqua: '#00FFFF', tan: '#D2B48C', gold: '#FFD700', beige: '#F5F5DC',
};

function normalizeHexColor(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hex = trimmed.replace(/^#/, '').split(',')[0].trim();
  if (/^[0-9A-Fa-f]{6}$/.test(hex)) return `#${hex.toUpperCase()}`;
  return null;
}

function resolveColorSwatches(value) {
  if (!value) return [];
  const swatches = [];
  const seen = new Set();
  for (const candidate of String(value).split(',').map(s => s.trim()).filter(Boolean)) {
    const hex = normalizeHexColor(candidate) || COLOR_NAME_TO_HEX[candidate.toLowerCase()] || null;
    if (hex && !seen.has(hex)) {
      seen.add(hex);
      swatches.push(hex);
    }
  }
  return swatches;
}

function detectSizeRankFromFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  let base = filename.trim();
  base = base.replace(/\.3mf$/i, '');
  base = base.replace(/\.(?:b?gcode)$/i, '');

  let m = /_(\d{2,3})_[a-z0-9-]+$/i.exec(base);
  if (!m) m = /_(\d{2,3})$/i.exec(base);
  if (!m) return null;

  const size = parseInt(m[1], 10);
  if (!Number.isFinite(size) || size < 1) return null;
  return size;
}

function buildProjectNameForSize(baseName, sizeRank) {
  const trimmed = String(baseName || '').trim();
  if (!trimmed) return trimmed;
  if (sizeRank === 100) return trimmed;
  return `${trimmed} - ${sizeRank} Percent`;
}

function inferProjectNameFromFilename(filename) {
  if (!filename || typeof filename !== 'string') return '';

  let base = filename.trim();
  base = base.replace(/\.3mf$/i, '');
  base = base.replace(/\.(?:b?gcode)$/i, '');

  // Prefer stripping the common _<size>_<model> slicer suffix first.
  let stem = base.replace(/_(\d{2,3})_[a-z0-9-]+$/i, '');
  // Fallback to stripping only model suffix when no explicit size token exists.
  if (stem === base) stem = base.replace(/_[a-z0-9-]+$/i, '');
  if (!stem) stem = base;

  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export default function ImportThreeMf() {
  const navigate = useNavigate();
  const [showToast, toastEl] = useToast();

  const [models, setModels] = useState([]);
  const [projects, setProjects] = useState([]);
  const [importMode, setImportMode] = useState('new');
  const [existingProjectId, setExistingProjectId] = useState('');
  const [obsoleteAction, setObsoleteAction] = useState('keep');
  const [selectedModels, setSelectedModels] = useState([]);
  const [assignmentMode, setAssignmentMode] = useState('global');
  const [fileModels, setFileModels] = useState({});
  const [projectName, setProjectName] = useState('');
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(data => {
        const bambu = data.filter(m => m.connector === 'bambu');
        setModels(bambu);
        if (bambu.length === 1) setSelectedModels([bambu[0].model_id]);
      })
      .catch(() => {});

    fetch('/api/projects')
      .then(r => r.json())
      .then(data => {
        const sorted = [...data].sort((a, b) => b.id - a.id);
        setProjects(sorted);
        if (sorted.length > 0) setExistingProjectId(String(sorted[0].id));
      })
      .catch(() => {});
  }, []);

  function onFileChange(e) {
    const selected = Array.from(e.target.files || []);
    if (selected.length === 0) return;
    setFiles(selected);
    setFileModels({});
    setResult(null);
    if (!projectName) {
      const inferredNames = selected
        .map((f) => inferProjectNameFromFilename(f.name))
        .filter(Boolean);

      if (inferredNames.length > 0) {
        const uniqueNames = [...new Set(inferredNames)];
        setProjectName(uniqueNames.length === 1 ? uniqueNames[0] : inferredNames[0]);
      } else if (selected.length === 1) {
        setProjectName(selected[0].name.replace(/\.3mf$/i, '').replace(/[_-]/g, ' ').trim());
      } else {
        setProjectName('Batch 3MF Import');
      }
    }
  }

  function handleImport() {
    if (files.length === 0) return showToast('Select one or more .3mf files first', 'error');
    if (importMode === 'new' && !projectName.trim()) return showToast('Project name is required', 'error');
    if (importMode === 'existing' && !existingProjectId) return showToast('Select a project to re-import into', 'error');

    const inferredSizes = files.map(f => detectSizeRankFromFilename(f.name));
    const distinctSizes = [...new Set(inferredSizes.filter(s => s != null))];

    if (importMode === 'new' && distinctSizes.length > 1) {
      const groups = distinctSizes
        .sort((a, b) => b - a)
        .map((sizeRank) => ({
          sizeRank,
          indexes: inferredSizes
            .map((s, idx) => ({ s, idx }))
            .filter((x) => x.s === sizeRank)
            .map((x) => x.idx),
        }));

      setUploading(true);
      setProgress(0);
      setResult(null);

      const runBatchImport = async () => {
        const imported = [];
        try {
          for (let i = 0; i < groups.length; i += 1) {
            const group = groups[i];
            const fd = new FormData();

            for (const idx of group.indexes) {
              fd.append('files', files[idx]);
            }

            const sizeProjectName = buildProjectNameForSize(projectName.trim(), group.sizeRank);
            fd.append('project_name', sizeProjectName);

            if (assignmentMode === 'per_file') {
              const perFile = group.indexes.map((idx) => (fileModels[idx] || '').trim().toLowerCase());
              fd.append('file_printer_models', JSON.stringify(perFile));
            } else if (selectedModels.length > 0) {
              fd.append('printer_models', JSON.stringify(selectedModels));
            }

            const res = await fetch('/api/projects/import-3mf', {
              method: 'POST',
              body: fd,
            });

            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(`Import failed for ${group.sizeRank}%: ${body.error || res.status}`);
            }

            imported.push({ sizeRank: group.sizeRank, body });
            setProgress(Math.round(((i + 1) / groups.length) * 100));
          }

          if (imported.length > 0) {
            const last = imported[imported.length - 1].body;
            setResult(last);
            const names = imported.map((x) => x.body?.project?.name).filter(Boolean).join(', ');
            showToast(`Imported ${imported.length} size variants: ${names}`, 'success');
          }

          fetch('/api/projects')
            .then(r => r.json())
            .then(data => {
              const sorted = [...data].sort((a, b) => b.id - a.id);
              setProjects(sorted);
            })
            .catch(() => {});
        } catch (err) {
          showToast(err.message || 'Import failed', 'error');
        } finally {
          setUploading(false);
        }
      };

      runBatchImport();
      return;
    }

    const fd = new FormData();
    for (const file of files) fd.append('files', file);
    if (importMode === 'new') fd.append('project_name', projectName.trim());
    if (importMode === 'existing') fd.append('obsolete_action', obsoleteAction);

    if (assignmentMode === 'per_file') {
      const perFile = files.map((_f, idx) => (fileModels[idx] || '').trim().toLowerCase());
      fd.append('file_printer_models', JSON.stringify(perFile));
    } else if (selectedModels.length > 0) {
      fd.append('printer_models', JSON.stringify(selectedModels));
    }

    setUploading(true);
    setProgress(0);

    const xhr = new XMLHttpRequest();
    const endpoint = importMode === 'new'
      ? '/api/projects/import-3mf'
      : `/api/projects/${existingProjectId}/reimport-3mf`;
    xhr.open('POST', endpoint);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      setUploading(false);
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status === 201) {
        setResult(body);
        showToast(`Imported ${body.plates.length} plate(s) into project "${body.project.name}"`, 'success');
      } else if (xhr.status === 200) {
        setResult(body);
        const s = body.summary || {};
        const status = String(body?.project?.status || '').toLowerCase();
        const hiddenByDefault = status === 'draft' || status === 'paused' || status === 'completed';
        showToast(
          hiddenByDefault
            ? `Re-imported "${body.project.name}" (${status}). It can be hidden on Projects until Draft/Paused/Completed filters are shown.`
            : `Re-imported into "${body.project.name}": ${s.updated_parts || 0} updated, ${s.created_parts || 0} added`,
          'success'
        );
      } else {
        showToast('Import failed: ' + (body.error || xhr.status), 'error');
      }
    };

    xhr.onerror = () => {
      setUploading(false);
      showToast('Import failed: network error', 'error');
    };

    xhr.send(fd);
  }

  const card = { background: '#131720', border: '1px solid #1e2433', borderRadius: 8, padding: '20px 24px', marginBottom: 16 };
  const label = { display: 'block', color: '#94a3b8', fontSize: 13, marginBottom: 6 };
  const input = { width: '100%', background: '#0a0f1a', border: '1px solid #2d3748', borderRadius: 6, padding: '8px 12px', color: '#e2e8f0', fontSize: 14, boxSizing: 'border-box' };
  const btn   = (disabled) => ({ background: disabled ? '#1e2433' : '#2563eb', color: disabled ? '#64748b' : '#fff', border: 'none', borderRadius: 6, padding: '9px 20px', fontSize: 14, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' });

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ color: '#e2e8f0', fontSize: 22, fontWeight: 700, margin: 0 }}>Import 3MF</h1>
        <p style={{ color: '#94a3b8', fontSize: 14, margin: '8px 0 0' }}>
          Upload sliced .3mf files from Bambu Studio or OrcaSlicer. Create a new project, or re-import into an existing project and update only changed plates.
        </p>
      </div>

      {models.length === 0 && (
        <div style={{ ...card, borderColor: '#713f12', background: '#1c1208', color: '#fcd34d', fontSize: 14 }}>
          No Bambu printer models configured. Add a model with connector "bambu" in Settings first.
        </div>
      )}

      <div style={card}>
        <div style={{ marginBottom: 16 }}>
          <label style={label}>Import Target</label>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, color: '#cbd5e1', fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                name="import-mode"
                checked={importMode === 'new'}
                onChange={() => setImportMode('new')}
              />
              Create new project
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                name="import-mode"
                checked={importMode === 'existing'}
                onChange={() => setImportMode('existing')}
              />
              Re-import into existing project
            </label>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={label}>3MF Files</label>
          <input
            ref={fileRef}
            type="file"
            accept=".3mf"
            multiple
            onChange={onFileChange}
            style={{ ...input, padding: '7px 12px', cursor: 'pointer' }}
          />
          {files.length > 0 && (
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>
              {files.length} file(s), {(files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(1)} MB total
            </div>
          )}
          <div style={{
            marginTop: 8,
            background: '#0f172a',
            border: '1px solid #2d3748',
            borderRadius: 6,
            padding: '8px 10px',
            color: '#94a3b8',
            fontSize: 12,
            lineHeight: 1.5,
          }}>
            Filename template (recommended): <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>&lt;project&gt;_&lt;size&gt;_&lt;model&gt;.gcode.3mf</span><br />
            Example: <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>chunky_jessie_100_x1c.gcode.3mf</span><br />
            The <span style={{ color: '#cbd5e1' }}>model</span> suffix enables auto model detection, and the <span style={{ color: '#cbd5e1' }}>size</span> suffix (for example <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>80</span> or <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>100</span>) is used for project size variant safety.
            {importMode === 'new' && files.length > 1 && (
              <>
                <br />
                Mixed-size uploads are split automatically into separate size projects.
              </>
            )}
          </div>
        </div>

        {importMode === 'new' ? (
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Project Name</label>
            <input
              type="text"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder="e.g. Owl Parts"
              style={input}
            />
          </div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Existing Project</label>
            <select
              value={existingProjectId}
              onChange={e => setExistingProjectId(e.target.value)}
              style={{ ...input, cursor: 'pointer' }}
            >
              {projects.map(p => (
                <option key={p.id} value={String(p.id)}>{p.name} (#{p.id})</option>
              ))}
            </select>
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>
              Re-import matches existing parts by plate number (gcode `plate_no`) first, then by part name prefix like "Plate 6".
              If filenames include size suffixes, re-import also checks that filename size matches the selected project's size variant.
            </div>
          </div>
        )}

        {importMode === 'existing' && (
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Obsolete Plates</label>
            <select
              value={obsoleteAction}
              onChange={e => setObsoleteAction(e.target.value)}
              style={{ ...input, cursor: 'pointer' }}
            >
              <option value="keep">Keep untouched (preserve all existing unmatched plates)</option>
              <option value="archive">Archive unmatched (close plates, keep history)</option>
              <option value="remove">Remove unmatched (delete parts, gcodes, and jobs)</option>
            </select>
          </div>
        )}

        <div style={{ marginBottom: 20 }}>
          <label style={label}>Model Assignment</label>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, color: '#cbd5e1', fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                name="assignment-mode"
                checked={assignmentMode === 'global'}
                onChange={() => setAssignmentMode('global')}
              />
              Apply selected models to every file
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                name="assignment-mode"
                checked={assignmentMode === 'per_file'}
                onChange={() => setAssignmentMode('per_file')}
              />
              One model per file
            </label>
          </div>

          {assignmentMode === 'global' ? (
            <>
              <select
                multiple
                value={selectedModels}
                onChange={e => setSelectedModels(Array.from(e.target.selectedOptions).map(o => o.value))}
                style={{ ...input, cursor: 'pointer', minHeight: 110 }}
              >
                {models.map(m => (
                  <option key={m.model_id} value={m.model_id}>{m.label}</option>
                ))}
              </select>
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>
                Select none to auto-detect from filename suffix, like <span style={{ color: '#94a3b8' }}>widget_100_x1c.gcode.3mf</span>.
                Use Cmd/Ctrl-click to select multiple models.
              </div>
            </>
          ) : (
            <>
              {files.length === 0 ? (
                <div style={{ color: '#64748b', fontSize: 12 }}>Choose files first, then set model per file.</div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {files.map((f, idx) => (
                    <div key={`${f.name}-${idx}`} style={{ display: 'grid', gridTemplateColumns: '1fr 190px', gap: 10, alignItems: 'center' }}>
                      <div style={{ color: '#94a3b8', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                      <select
                        value={fileModels[idx] || ''}
                        onChange={e => setFileModels(prev => ({ ...prev, [idx]: e.target.value }))}
                        style={{ ...input, cursor: 'pointer', padding: '6px 10px' }}
                      >
                        <option value="">Auto from filename suffix</option>
                        {models.map(m => (
                          <option key={m.model_id} value={m.model_id}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {uploading ? (
          <div>
            <div style={{ background: '#0a0f1a', border: '1px solid #2d3748', borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ background: '#2563eb', height: 6, width: `${progress}%`, transition: 'width 0.2s' }} />
            </div>
            <div style={{ color: '#94a3b8', fontSize: 13 }}>{progress}% uploading...</div>
          </div>
        ) : (
          <button
            onClick={handleImport}
            disabled={
              files.length === 0
              || models.length === 0
              || (importMode === 'new' && !projectName.trim())
              || (importMode === 'existing' && !existingProjectId)
            }
            style={btn(
              files.length === 0
              || models.length === 0
              || (importMode === 'new' && !projectName.trim())
              || (importMode === 'existing' && !existingProjectId)
            )}
          >
            {importMode === 'new' ? 'Import' : 'Re-import'}
          </button>
        )}
      </div>

      {result && (
        <div style={card}>
          <div style={{ color: '#4ade80', fontWeight: 700, fontSize: 15, marginBottom: 12 }}>
            {result.summary ? 'Re-import complete' : 'Import complete'}
          </div>
          <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>
            {result.summary ? (
              <>
                Updated project <strong style={{ color: '#e2e8f0' }}>{result.project.name}</strong> with {result.plates.length} imported plate group(s).{' '}
                {result.summary.updated_parts} part(s) updated, {result.summary.created_parts} added, {result.summary.untouched_parts} untouched.
              </>
            ) : (
              <>
                Created project <strong style={{ color: '#e2e8f0' }}>{result.project.name}</strong> with {result.plates.length} plate(s).
                The project is in <em>draft</em> status. Activate it from the Projects page when ready to print.
              </>
            )}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Source', 'Plate', 'Parts/plate', 'Print time', 'Material'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: '#64748b', borderBottom: '1px solid #1e2433', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.plates.map(p => (
                <tr key={`${(p.source_files || ['file']).join(',')}-${p.part_id}-${p.plate_index}`}>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>{(p.source_files || [p.source_file || '-']).join(', ')}</td>
                  <td style={{ padding: '6px 8px', color: '#e2e8f0' }}>Plate {p.plate_index}</td>
                  <td style={{ padding: '6px 8px', color: '#e2e8f0' }}>{p.parts_per_plate}</td>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>{p.est_print_secs ? formatSecs(p.est_print_secs) : '-'}</td>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>
                    {p.required_material || '-'}
                    {p.material_grams ? ` (${p.material_grams.toFixed(1)}g)` : ''}
                    {(() => {
                      const swatches = resolveColorSwatches(p.required_color);
                      if (swatches.length === 0) return null;
                      return (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6, verticalAlign: 'middle' }}>
                          {swatches.map((swatch, idx) => (
                            <span key={`${swatch}-${idx}`} title={swatch} style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: swatch, border: '1px solid #2d3748' }} />
                          ))}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              onClick={() => {
                const projectId = result?.project?.id;
                if (projectId) {
                  navigate(`/projects?revealHidden=1&focusProject=${projectId}`);
                } else {
                  navigate('/projects');
                }
              }}
              style={btn(false)}
            >
              Go to Projects
            </button>
            <button
              onClick={() => {
                setResult(null);
                setFiles([]);
                setFileModels({});
                setProjectName('');
                if (fileRef.current) fileRef.current.value = '';
              }}
              style={{ ...btn(false), background: '#1e2433', color: '#94a3b8' }}
            >
              Import another
            </button>
          </div>
        </div>
      )}

      {toastEl}
    </div>
  );
}

function formatSecs(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
