import { Injectable, OnDestroy, signal } from '@angular/core';
import { SessionView, getApi } from './electron-api';

@Injectable({ providedIn: 'root' })
export class SessionService implements OnDestroy {
  readonly session = signal<SessionView | null>(null);
  private unsubscribe: (() => void) | undefined;
  private started = false;

  async init(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const api = getApi();
    if (!api) {
      this.started = false;
      return;
    }
    this.session.set(await api.getSession());
    this.unsubscribe = api.onSessionUpdated?.((next) => this.session.set(next));
  }

  /** Optimistic UI patch so toolbar clicks feel instant before IPC returns. */
  patchLocal(partial: Partial<SessionView>): void {
    const cur = this.session();
    if (!cur) {
      return;
    }
    const next: SessionView = { ...cur, ...partial };
    const panelsHidden = next.panelsHidden;
    const insightsOpen = next.insightsOpen;
    const responseOpen = next.responseOpen;
    next.insightsVisible = !panelsHidden && insightsOpen;
    next.responseVisible = !panelsHidden && responseOpen;
    next.anyPanelOpen = !panelsHidden && (insightsOpen || responseOpen);
    next.bothPanelsOpen = !panelsHidden && insightsOpen && responseOpen;
    this.session.set(next);
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }
}
