import React, { useEffect, useState } from 'react';
import AppHeader from '../components/AppHeader.jsx';
import { projectApi, teamApi } from '../services/api.js';

export default function ProjectPage({ onLogout, navigateTo, selectedProjectId, setSelectedProjectId }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [datasets, setDatasets] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewDatasetKey, setPreviewDatasetKey] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewHeaders, setPreviewHeaders] = useState([]);
  const [previewRows, setPreviewRows] = useState([]);

  const userStr = localStorage.getItem('user');
  const me = userStr ? JSON.parse(userStr) : null;
  const myName = me?.name || '';
  const myEmail = me?.email || '';
  const myDisplayName = (myName || myEmail || 'User').trim();
  const myInitial = (myDisplayName?.[0] || 'U').toUpperCase();

  // Create project UI state
  const [teams, setTeams] = useState([]);
  const [adminTeams, setAdminTeams] = useState([]);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDesc, setNewProjectDesc] = useState('');
  const [newProjectTeamId, setNewProjectTeamId] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [{ data: projRes }, { data: teamRes }] = await Promise.all([
          projectApi.getProjects(),
          teamApi.getTeams(),
        ]);
        const list = (projRes?.projects || []).map((p) => ({ _id: p._id, name: p.name, description: p.description, chats: p.chats || [] }));
        setProjects(list);
        setLoading(false);
        if (!selectedProjectId && list.length) setSelectedProjectId?.(list[0]._id);

        const teamsList = teamRes?.teams || [];
        setTeams(teamsList);
        // derive admin teams
        const userStr = localStorage.getItem('user');
        const me = userStr ? JSON.parse(userStr) : null;
        const myId = me?.id || me?._id;
        const admins = teamsList.filter(t => (t.members || []).some(m => (m.user === myId || m.user?._id === myId) && m.role === 'team_admin'));        
        setAdminTeams(admins);
        if (admins.length === 1) setNewProjectTeamId(admins[0]._id);
      } catch (e) {
        console.error('Failed to load projects/teams', e);
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return setDatasets([]);
    (async () => {
      try {
        const { data } = await projectApi.listDatasets(selectedProjectId);
        setDatasets(data?.datasets || []);
      } catch (e) {
        console.error('Failed to load datasets', e);
      }
    })();
  }, [selectedProjectId]);

  useEffect(() => {
    if (!datasets.length) {
      setPreviewDatasetKey('');
      return;
    }
    if (!previewDatasetKey) {
      const first = datasets[0];
      setPreviewDatasetKey(first?._id || first?.url || '');
      return;
    }
    const exists = datasets.some((d) => (d?._id || d?.url) === previewDatasetKey);
    if (!exists) {
      const first = datasets[0];
      setPreviewDatasetKey(first?._id || first?.url || '');
    }
  }, [datasets, previewDatasetKey]);

  useEffect(() => {
    if (!previewDatasetKey) {
      setPreviewError('');
      setPreviewHeaders([]);
      setPreviewRows([]);
      return;
    }

    const dataset = datasets.find((d) => (d?._id || d?.url) === previewDatasetKey);
    const url = dataset?.url || '';
    if (!url) {
      setPreviewError('No preview available.');
      setPreviewHeaders([]);
      setPreviewRows([]);
      return;
    }

    const parseCsv = (csvText, maxRows = 25, maxCols = 12) => {
      const rows = [];
      let row = [];
      let field = '';
      let inQuotes = false;

      const pushField = () => {
        row.push(field);
        field = '';
      };

      const pushRow = () => {
        if (row.length) rows.push(row);
        row = [];
      };

      for (let i = 0; i < csvText.length; i++) {
        const ch = csvText[i];
        const next = csvText[i + 1];

        if (ch === '"') {
          if (inQuotes && next === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
          continue;
        }

        if (!inQuotes && (ch === ',')) {
          pushField();
          continue;
        }

        if (!inQuotes && (ch === '\n' || ch === '\r')) {
          if (ch === '\r' && next === '\n') i++;
          pushField();
          pushRow();
          if (rows.length >= maxRows + 1) break;
          continue;
        }

        field += ch;
      }

      if (field.length || row.length) {
        pushField();
        pushRow();
      }

      const trimmed = rows.map((r) => r.slice(0, maxCols));
      const headers = trimmed[0] || [];
      const body = trimmed.slice(1, maxRows + 1);
      return { headers, rows: body };
    };

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      setPreviewLoading(true);
      setPreviewError('');
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error('Failed to fetch');
        const text = await res.text();
        if (cancelled) return;
        const limited = text.length > 200000 ? `${text.slice(0, 200000)}\n` : text;
        const parsed = parseCsv(limited);
        setPreviewHeaders(parsed.headers);
        setPreviewRows(parsed.rows);
      } catch (e) {
        if (cancelled) return;
        setPreviewHeaders([]);
        setPreviewRows([]);
        setPreviewError('Failed to preview CSV.');
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [datasets, previewDatasetKey]);

  const handleUpload = async (evt) => {
    const files = evt.target.files;
    if (!files || !files.length || !selectedProjectId) return;
    setError('');
    setUploading(true);
    try {
      await projectApi.uploadDatasets(selectedProjectId, files);
      const { data } = await projectApi.listDatasets(selectedProjectId);
      setDatasets(data?.datasets || []);
    } catch (e) {
      const msg = e?.response?.data?.error || 'Upload failed.';
      setError(msg);
    } finally {
      setUploading(false);
      evt.target.value = '';
    }
  };

  const openCreateProject = () => {
    setCreateError('');
    setNewProjectName('');
    setNewProjectDesc('');
    setShowCreateProject(true);
  };

  const confirmCreateProject = async () => {
    if (!newProjectName.trim() || !newProjectTeamId) {
      setCreateError('Project name and team are required.');
      return;
    }
    try {
      setCreatingProject(true);
      setCreateError('');
      const payload = { name: newProjectName.trim(), description: newProjectDesc.trim(), team: newProjectTeamId };
      const { data } = await projectApi.createProject(payload);
      const proj = data?.project;
      if (proj?._id) {
        const newEntry = { _id: proj._id, name: proj.name, description: proj.description, chats: [] };
        setProjects(prev => [newEntry, ...prev]);
        setSelectedProjectId?.(proj._id);
      }
      setShowCreateProject(false);
    } catch (e)
      {
      const msg = e?.response?.data?.error || 'Failed to create project.';
      setCreateError(msg);
    } finally {
      setCreatingProject(false);
    }
  };

  return (
    // UPDATED: Changed bg-gray-100 to bg-slate-50 for the light, clean background
    <div className="min-h-screen w-full bg-white overflow-x-hidden">
      <AppHeader
      onLogout={onLogout}
      monochrome
      extraActions={(
        <button
          type="button"
          className="w-9 h-9 rounded-full bg-black text-white flex items-center justify-center text-sm font-semibold"
          onClick={() => navigateTo?.('userTeam')}
          title={myDisplayName}
          aria-label="Profile"
        >
          {myInitial}
        </button>
      )}
    />

      <main className="w-full min-h-[calc(100vh-64px)]">
        <div className="flex flex-col md:flex-row w-full min-h-[calc(100vh-64px)] items-stretch">
          <aside className="w-full md:w-72 md:shrink-0 bg-gray-100 shadow-lg border-r border-gray-200 min-h-[calc(100vh-64px)]">
            <div className="p-6 flex flex-col h-full">

              {adminTeams.length > 0 && (
                <button
                  type="button"
                  onClick={openCreateProject}
                  className="mt-4 w-full px-3 py-2 text-sm rounded-md bg-black text-white hover:bg-gray-800"
                >
                  Create Project
                </button>
              )}

              <div className="mt-4 space-y-1 flex-1 overflow-y-auto">
                {loading ? (
                  <p className="text-sm text-gray-500">Loading…</p>
                ) : projects.length ? (
                  projects.map((p) => {
                    const isActive = p._id === selectedProjectId;
                    return (
                      <button
                        key={p._id}
                        type="button"
                        onClick={() => setSelectedProjectId?.(p._id)}
                        className={
                          `w-full text-left px-3 py-2 rounded-md text-sm border ${
                            isActive ? 'bg-gray-100 border-black text-black' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                          }`
                        }
                      >
                        <div className="font-medium truncate">{p.name}</div>
                        {p.description ? <div className="text-xs text-gray-500 truncate">{p.description}</div> : null}
                      </button>
                    );
                  })
                ) : (
                  <p className="text-sm text-gray-500">No projects yet.</p>
                )}
              </div>

              <button
                type="button"
                onClick={() => navigateTo?.('userTeam')}
                className="mt-6 w-full flex items-center gap-3 px-3 py-1 rounded-md hover:bg-gray-50"
                aria-label="Profile"
              >
                <div className="w-10 h-10 rounded-full bg-black text-white flex items-center justify-center text-sm font-semibold shrink-0">
                  {myInitial}
                </div>
                <div className="min-w-0 text-left">
                  <div className="text-sm font-medium text-black truncate">{myDisplayName}</div>
                  <div className="text-xs text-gray-500 truncate">{myEmail || ''}</div>
                </div>
              </button>
            </div>
          </aside>

          <div className="flex-1">
            <div className="max-w-6xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between mb-6">
                <h1 className="text-3xl font-bold tracking-tight text-black">Projects</h1>
              </div>

              {loading ? (
                <p className="text-sm text-gray-500">Loading projects…</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="md:col-span-1 space-y-4 bg-white border border-gray-200 rounded-lg shadow-lg p-6">
                    <div className="flex gap-2">
                      <button className="flex-1 px-3 py-2 text-sm rounded-md border border-gray-300 bg-black text-white hover:bg-gray-800" onClick={() => navigateTo?.('userChat')} disabled={!selectedProjectId}>Open Chat</button>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">Datasets</h3>
                      <label
                        htmlFor="file-upload"
                        className="relative block border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-black hover:bg-gray-50 transition-colors group"
                      >
                        <svg className="mx-auto h-12 w-12 text-gray-400 group-hover:text-black" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l-3 3m3-3l3 3m-3-6H7.5a4.5 4.5 0 00-4.5 4.5v3.75a4.5 4.5 0 004.5 4.5h9a4.5 4.5 0 004.5-4.5v-3.75a4.5 4.5 0 00-4.5-4.5H12z" />
                        </svg>
                        <p className="mt-2 text-sm text-gray-600 group-hover:text-black">
                          <span className="font-semibold">Click to upload</span> or drag and drop
                        </p>
                        <p className="mt-1 text-xs text-gray-500">Upload dataset files</p>
                        <input id="file-upload" name="file-upload" type="file" multiple onChange={handleUpload} className="sr-only" />
                      </label>
                      {uploading && <p className="text-xs text-black mt-2">Uploading…</p>}
                      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
                    </div>
                  </div>

                  <div className="md:col-span-2 bg-white border border-gray-200 rounded-lg shadow-lg p-6">
                    <div>
                      <h2 className="text-lg font-semibold text-black mb-4">Project datasets ({datasets.length})</h2>
                    </div>
                    <div className="max-h-[55vh] overflow-y-auto space-y-2 pr-2">
                      {datasets.length ? (
                        datasets.map((d) => (
                          <div key={d._id || d.url} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-md text-sm">
                            <span className="truncate text-black" title={d.name}>{d.name}</span>
                            <span className="text-xs text-gray-500">{new Date(d.uploadedAt).toLocaleDateString?.() || ''}</span>
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-gray-500">No datasets uploaded yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* --- MODAL --- */}
      {/* UPDATED: Minor style tweaks for consistency */}
      {showCreateProject && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white border border-gray-200 rounded-lg shadow-lg w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-black">Create a new project</h3>
            <div className="mt-4 space-y-3">
              <div>
                {/* UPDATED: Label styling */}
                <label className="block text-sm font-medium text-gray-700 mb-1">Project name</label>
                <input type="text" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} className="w-full border border-gray-300 bg-white text-black rounded-md px-3 py-2 text-sm" placeholder="Enter project name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <textarea value={newProjectDesc} onChange={(e) => setNewProjectDesc(e.target.value)} className="w-full border border-gray-300 bg-white text-black rounded-md px-3 py-2 text-sm" rows={3} placeholder="Short description" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Team</label>
                {adminTeams.length <= 1 ? (
                  <input type="text" readOnly className="w-full border border-gray-200 bg-gray-50 text-gray-500 rounded-md px-3 py-2 text-sm" value={adminTeams[0]?.name || 'Your team'} />
                ) : (
                  <select className="w-full border border-gray-300 bg-white text-black rounded-md px-3 py-2 text-sm" value={newProjectTeamId} onChange={(e) => setNewProjectTeamId(e.target.value)}>
                    <option value="">Select a team…</option>
                    {adminTeams.map(t => (<option key={t._id} value={t._id}>{t.name}</option>))}
                  </select>
                )}
              </div>
              {createError && <p className="text-sm text-red-600">{createError}</p>}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="px-4 py-2 text-sm rounded-md border border-gray-300 text-black hover:bg-gray-50" onClick={() => setShowCreateProject(false)} disabled={creatingProject}>Cancel</button>
              <button className="px-4 py-2 text-sm rounded-md bg-black text-white hover:bg-gray-800 disabled:opacity-50" onClick={confirmCreateProject} disabled={creatingProject}>{creatingProject ? 'Creating…' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}

      {/* --- PREVIEW PANEL --- */}
      <div className="fixed bottom-0 right-0 left-0 md:left-72 md:-ml-px z-40">
        <div
          className={`absolute left-0 right-0 bottom-full bg-white border-t border-gray-200 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] h-[60vh] transition-transform duration-300 ${
            previewOpen ? 'translate-y-0' : 'translate-y-full'
          }`}
        >
          <div className="max-w-6xl mx-auto h-full px-4 sm:px-6 lg:px-8 py-4 flex flex-col">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700">Dataset</label>
              <select
                className="flex-1 border border-gray-300 bg-white text-black rounded-md px-3 py-2 text-sm"
                value={previewDatasetKey}
                onChange={(e) => setPreviewDatasetKey(e.target.value)}
                disabled={!datasets.length}
              >
                {datasets.length ? (
                  datasets.map((d) => (
                    <option key={d._id || d.url} value={d._id || d.url}>
                      {d.name}
                    </option>
                  ))
                ) : (
                  <option value="">No datasets uploaded</option>
                )}
              </select>
            </div>

            <div className="mt-4 flex-1 overflow-hidden">
              {!datasets.length ? (
                <p className="text-sm text-gray-500">Upload a dataset to preview it.</p>
              ) : previewLoading ? (
                <p className="text-sm text-gray-500">Loading preview…</p>
              ) : (
                <div className="h-full overflow-auto rounded-md border border-gray-200 bg-white p-3">
                  {previewError ? <p className="text-xs text-gray-500 mb-2">{previewError}</p> : null}
                  {previewHeaders.length ? (
                    <div className="w-full overflow-auto">
                      <table className="min-w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50">
                            {previewHeaders.map((h, idx) => (
                              <th key={idx} className="text-left font-semibold text-gray-700 px-2 py-2 border-b border-gray-200 whitespace-nowrap">
                                {h || `Column ${idx + 1}`}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.map((r, rIdx) => (
                            <tr key={rIdx} className="odd:bg-white even:bg-gray-50">
                              {previewHeaders.map((_, cIdx) => (
                                <td key={cIdx} className="px-2 py-2 border-b border-gray-100 text-gray-700 align-top">
                                  {r?.[cIdx] ?? ''}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">No preview available.</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setPreviewOpen((v) => !v)}
          className="relative z-10 w-full bg-white border-t border-gray-200 px-6 py-3 text-sm font-medium text-black flex items-center justify-between hover:bg-gray-50"
        >
          <span>Preview</span>
          <span className="text-xs text-gray-500">{previewOpen ? 'Close' : 'Open'}</span>
        </button>
      </div>
    </div>
  );
}