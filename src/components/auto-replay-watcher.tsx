import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

const DB_NAME = "fortnite-chest-counter";
const STORE_NAME = "settings";
const HANDLE_KEY = "replay-folder";
const POLL_MS = 5_000;

declare global {
  interface Window {
    showDirectoryPicker(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  }
}

 type DirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSavedFolder(): Promise<DirectoryHandle | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(HANDLE_KEY);
    request.onsuccess = () => { db.close(); resolve(request.result as DirectoryHandle | undefined); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

async function saveFolder(handle?: DirectoryHandle): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    if (handle) store.put(handle, HANDLE_KEY);
    else store.delete(HANDLE_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

type Props = { onNewFiles: (files: File[]) => Promise<void> };

export function AutoReplayWatcher({ onNewFiles }: Props) {
  const [folder, setFolder] = useState<DirectoryHandle>();
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const callback = useRef(onNewFiles);
  const processing = useRef(false);
  const seen = useRef(new Set<string>());
  const stability = useRef(new Map<string, { size: number; stable: number }>());

  callback.current = onNewFiles;

  useEffect(() => {
    if (!("showDirectoryPicker" in window) || !("indexedDB" in window)) return;
    let cancelled = false;
    getSavedFolder().then(async (saved) => {
      if (!saved || cancelled) return;
      setFolder(saved);
      try {
        const permission = await saved.queryPermission({ mode: "read" });
        if (permission === "granted" && !cancelled) setActive(true);
      } catch {
        // The saved handle can be stale; the user can reconnect a folder.
      }
    }).catch(() => {
      toast.add({ type: "warning", title: "Could not restore the replay folder" });
    });
    return () => { cancelled = true; };
  }, []);

  const connect = useCallback(async () => {
    if (!("showDirectoryPicker" in window)) {
      toast.add({ type: "warning", title: "Use Microsoft Edge on a computer for automatic folder access" });
      return;
    }
    setBusy(true);
    try {
      let selected = folder;
      if (selected) {
        const permission = await selected.requestPermission({ mode: "read" });
        if (permission !== "granted") selected = undefined;
      }
      if (!selected) {
        selected = await window.showDirectoryPicker({ mode: "read" });
        const permission = await selected.requestPermission({ mode: "read" });
        if (permission !== "granted") {
          toast.add({ type: "warning", title: "Folder access was not granted" });
          return;
        }
        await saveFolder(selected);
      }
      setFolder(selected);
      setActive(true);
      toast.add({ type: "success", title: "Automatic replay counting is on", description: "Keep this tab open after your matches." });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.add({ type: "error", title: "Could not connect the replay folder" });
    } finally {
      setBusy(false);
    }
  }, [folder]);

  const disconnect = useCallback(async () => {
    setActive(false);
    setFolder(undefined);
    stability.current.clear();
    seen.current.clear();
    await saveFolder();
    toast.add({ type: "info", title: "Automatic counting is off" });
  }, []);

  useEffect(() => {
    if (!active || !folder) return;
    let stopped = false;
    const scan = async () => {
      if (stopped || processing.current || document.visibilityState === "hidden") return;
      try {
        const ready: File[] = [];
        for await (const entry of folder.values()) {
          if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(".replay")) continue;
          const file = await entry.getFile();
          const key = `${file.name}:${file.size}:${file.lastModified}`;
          if (seen.current.has(key)) continue;
          const previous = stability.current.get(key);
          const stable = previous && previous.size === file.size ? previous.stable + 1 : 0;
          stability.current.set(key, { size: file.size, stable });
          // Wait for the replay file to stop growing before sending it to the parser.
          if (stable >= 1 && file.size > 0) ready.push(file);
        }
        if (ready.length > 0 && !stopped) {
          processing.current = true;
          ready.forEach((file) => seen.current.add(`${file.name}:${file.size}:${file.lastModified}`));
          try {
            await callback.current(ready);
          } finally {
            processing.current = false;
          }
        }
      } catch (error) {
        if (!stopped) {
          console.warn("Automatic replay folder scan failed", error);
          setActive(false);
          toast.add({ type: "warning", title: "Replay folder access expired", description: "Reconnect the folder to resume automatic counting." });
        }
      }
    };
    void scan();
    const interval = window.setInterval(() => void scan(), POLL_MS);
    return () => { stopped = true; window.clearInterval(interval); };
  }, [active, folder]);

  if (!("showDirectoryPicker" in window)) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/15 bg-black/20 px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-semibold">Automatic counting</p>
        <p className="text-xs text-muted-foreground">
          {active ? "Watching your replay folder while this tab is open" : "Automatically count new match replays"}
        </p>
      </div>
      {active ? (
        <Button size="sm" variant="outline" onClick={disconnect}>Turn off</Button>
      ) : (
        <Button size="sm" onClick={connect} disabled={busy}>
          {busy ? "Connecting…" : folder ? "Reconnect folder" : "Choose replay folder"}
        </Button>
      )}
    </div>
  );
}
