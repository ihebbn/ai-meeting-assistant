import { Injectable, signal } from '@angular/core';

export type OverlayMenuPlacement = 'below' | 'above';

export type OverlayMenuLayout = {
  placement: OverlayMenuPlacement;
  top: number;
  right: number;
  width: number;
  insetTop: number;
};

@Injectable({ providedIn: 'root' })
export class OverlayMenuService {
  readonly open = signal(false);
  readonly layout = signal<OverlayMenuLayout | null>(null);
  private suppressDismissUntilMs = 0;

  setOpen(open: boolean, layout: OverlayMenuLayout | null = null): void {
    this.open.set(open);
    this.layout.set(open ? layout : null);
  }

  suppressDismissUntil(timestampMs: number): void {
    this.suppressDismissUntilMs = timestampMs;
  }

  shouldIgnoreDismiss(): boolean {
    return Date.now() < this.suppressDismissUntilMs;
  }
}
