/** IndexedDB persistence: projects, audio assets (as WAV/original blobs), versions. */
import type { AssetMeta, Project } from './model';

const DB = 'ai-recording-studio';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      db.createObjectStore('assets', { keyPath: 'id' });
      const v = db.createObjectStore('versions', { keyPath: 'vid', autoIncrement: true });
      v.createIndex('projectId', 'projectId');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}

export const saveProject = (p: Project): Promise<IDBValidKey> => tx('projects', 'readwrite', (s) => s.put(p));
export const loadProject = (id: string): Promise<Project | undefined> => tx('projects', 'readonly', (s) => s.get(id));
export const deleteProject = (id: string): Promise<undefined> => tx('projects', 'readwrite', (s) => s.delete(id));
export const listProjects = (): Promise<Project[]> => tx('projects', 'readonly', (s) => s.getAll());

export interface StoredAsset extends AssetMeta { blob: Blob }
export const saveAsset = (a: StoredAsset): Promise<IDBValidKey> => tx('assets', 'readwrite', (s) => s.put(a));
export const loadAsset = (id: string): Promise<StoredAsset | undefined> => tx('assets', 'readonly', (s) => s.get(id));

export interface Version { vid?: number; projectId: string; ts: number; label: string; data: Project }
export const saveVersion = (v: Version): Promise<IDBValidKey> => tx('versions', 'readwrite', (s) => s.add(v));
export async function listVersions(projectId: string): Promise<Version[]> {
  const db = await open();
  return new Promise((res, rej) => {
    const r = db.transaction('versions').objectStore('versions').index('projectId').getAll(projectId);
    r.onsuccess = () => res((r.result as Version[]).sort((a, b) => b.ts - a.ts));
    r.onerror = () => rej(r.error);
  });
}

/** Ask the browser not to evict our data (important on iOS Safari). */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
