import type { Session } from '../types';
type Listener = () => void;
export class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private listeners: Set<Listener> = new Set();
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    this.listeners.forEach(l => l());
  }
  getSnapshot(): Session[] {
    return Array.from(this.sessions.values());
  }
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  addSession(session: Session): void {
    this.sessions.set(session.id, session);
    this.notify();
  }
  updateSession(id: string, updates: Partial<Session>): void {
    const existing = this.sessions.get(id);
    if (existing) {
      this.sessions.set(id, { ...existing, ...updates });
      this.notify();
    }
  }
  deleteSession(id: string): void {
    if (this.sessions.delete(id)) this.notify();
  }
  moveSession(id: string, toIndex: number): void {
    const all = this.getSnapshot();
    const fromIndex = all.findIndex(s => s.id === id);
    if (fromIndex === -1 || fromIndex === toIndex) return;
    const [moved] = all.splice(fromIndex, 1);
    all.splice(toIndex, 0, moved);
    this.sessions.clear();
    for (const s of all) this.sessions.set(s.id, s);
    this.notify();
  }
}
