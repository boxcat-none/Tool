import type { Hello, PeerLink } from "@tool/notes/sync";

/**
 * 目前連上的裝置（每本筆記本可以同時連好幾台）。
 * 連線在書櫃畫面（加入）或筆記本畫面（邀請）建立，交給這裡；開著的筆記本畫面再接上同步。
 */
export interface Peer {
  key: number;
  link: PeerLink;
  remote: Hello;
}

type Listener = () => void;

class SyncHub {
  private peers = new Map<string, Peer[]>();
  private listeners = new Map<string, Set<Listener>>();
  private nextKey = 1;

  add(notebookId: string, link: PeerLink, remote: Hello): Peer {
    const peer: Peer = { key: this.nextKey++, link, remote };
    this.peers.set(notebookId, [...this.list(notebookId), peer]);
    link.onClose(() => {
      this.peers.set(
        notebookId,
        this.list(notebookId).filter((p) => p !== peer),
      );
      this.emit(notebookId);
    });
    this.emit(notebookId);
    return peer;
  }

  list(notebookId: string): Peer[] {
    return this.peers.get(notebookId) ?? [];
  }

  subscribe(notebookId: string, listener: Listener): () => void {
    let set = this.listeners.get(notebookId);
    if (!set) this.listeners.set(notebookId, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  closeAll(notebookId: string) {
    for (const p of this.list(notebookId)) p.link.close();
  }

  private emit(notebookId: string) {
    this.listeners.get(notebookId)?.forEach((l) => l());
  }
}

export const syncHub = new SyncHub();
