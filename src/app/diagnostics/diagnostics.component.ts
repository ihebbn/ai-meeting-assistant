import { DecimalPipe, KeyValuePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { AppSnapshot, LogEntry, getApi } from '../electron-api';

@Component({
  selector: 'app-diagnostics',
  standalone: true,
  imports: [DecimalPipe, KeyValuePipe],
  templateUrl: './diagnostics.component.html',
  styleUrl: './diagnostics.component.css',
})
export class DiagnosticsComponent implements OnInit, OnDestroy {
  readonly snapshot = signal<AppSnapshot | null>(null);
  readonly logs = signal<LogEntry[]>([]);
  private unsubscribeLog: (() => void) | undefined;
  private unsubscribeSession: (() => void) | undefined;

  ngOnInit(): void {
    void this.refresh();
    const api = getApi();
    this.unsubscribeLog = api?.onLog?.((entry) => {
      this.logs.update((current) => [...current, entry].slice(-200));
    });
    this.unsubscribeSession = api?.onSessionUpdated?.(() => {
      void this.refresh();
    });
  }

  ngOnDestroy(): void {
    this.unsubscribeLog?.();
    this.unsubscribeSession?.();
  }

  async refresh(): Promise<void> {
    const api = getApi();
    if (!api) {
      return;
    }
    const snap = await api.getSnapshot();
    this.snapshot.set(snap);
    this.logs.set(snap.logs);
  }

  openLogFolder(): void {
    void getApi()?.openLogFolder?.();
  }

  quit(): void {
    void getApi()?.quit();
  }
}
