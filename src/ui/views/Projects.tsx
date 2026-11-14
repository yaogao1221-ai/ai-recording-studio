import { useEffect, useRef, useState } from 'react';
import { createProject, type Project } from '../../engine/model';
import { uid } from '../../engine/plugins/registry';
import { deleteProject, listProjects, listVersions, saveProject, saveVersion, type Version } from '../../engine/storage';
import { importSession } from '../../engine/session';
import { loadProjectAssets } from '../../state/assets';
import { getState, loadIntoStore, saveNow, setUi, toast, useStore } from '../../state/store';

export async function openProject(p: Project): Promise<void> {
  const missing = await loadProjectAssets(p);
  loadIntoStore(p);
  if (missing.length) toast(`${missing.length} fichier(s) audio introuvable(s) dans ce navigateur.`);
}

export function Projects(): JSX.Element {
  const cur = useStore((s) => s.project);
  const [list, setList] = useState<Project[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const fileIn = useRef<HTMLInputElement>(null);
  const refresh = async (): Promise<void> => { setList((await listProjects()).sort((a, b) => b.updatedAt - a.updatedAt)); setVersions(await listVersions(getState().project.id)); };
  useEffect(() => { void refresh(); }, [cur.id]);
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="card">
        <h3>Projet actuel</h3>
        <div className="row wrap">
          <b className="grow">{cur.name}</b>
          <button onClick={async () => { await saveNow(); await saveVersion({ projectId: cur.id, ts: Date.now(), label: `Version ${versions.length + 1}`, data: structuredClone(getState().project) }); toast('Version enregistrée'); void refresh(); }}>Enregistrer une version</button>
          <button onClick={async () => { const d = { ...structuredClone(cur), id: uid('prj'), name: cur.name + ' (copie)', createdAt: Date.now(), updatedAt: Date.now() }; await saveProject(d); await openProject(d); toast('Projet dupliqué'); }}>Dupliquer</button>
        </div>
        {versions.length > 0 && (
          <div className="col" style={{ marginTop: 10 }}>
            {versions.map((v) => (
              <div key={v.vid} className="row slot" style={{ padding: 8 }}><span className="grow">{v.label}</span><span className="dim mono">{new Date(v.ts).toLocaleString()}</span>
                <button onClick={async () => { await openProject({ ...v.data, updatedAt: Date.now() }); toast(`${v.label} restaurée (Ctrl+Z impossible au-delà)`); }}>Restaurer</button></div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <h3>Mes projets</h3>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="primary" onClick={async () => { await saveNow(); const p = createProject(); await saveProject(p); await openProject(p); setUi({ view: 'studio' }); }}>＋ Nouveau projet</button>
          <button onClick={() => fileIn.current?.click()}>Importer une session</button>
          <input ref={fileIn} type="file" accept=".arsession,application/json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { const p = await importSession(f); await openProject(p); toast('Session importée'); } catch (err) { toast((err as Error).message); } e.target.value = ''; }} />
        </div>
        <div className="col">
          {list.map((p) => (
            <div key={p.id} className={'row slot ' + (p.id === cur.id ? 'sel' : '')} style={{ padding: 10 }}>
              <b className="grow">{p.name}</b><span className="dim">{p.clips.length} clips · {new Date(p.updatedAt).toLocaleString()}</span>
              {p.id !== cur.id && <button onClick={async () => { await saveNow(); await openProject(p); setUi({ view: 'studio' }); }}>Ouvrir</button>}
              {p.id !== cur.id && <button onClick={async () => { await deleteProject(p.id); void refresh(); }}>Supprimer</button>}
            </div>
          ))}
        </div>
        <div className="dim" style={{ marginTop: 8 }}>Les projets et l’audio sont stockés dans ce navigateur (IndexedDB), avec sauvegarde automatique. Pour changer d’appareil, exporte la session.</div>
      </div>
    </div>
  );
}
