import { DecimalPipe, KeyValuePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import {
  AiEffort,
  AiModelInfo,
  AiState,
  AppSnapshot,
  LogEntry,
  getApi,
} from '../electron-api';

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
  readonly ai = signal<AiState | null>(null);
  readonly aiModels = signal<AiModelInfo[]>([]);
  readonly aiMessage = signal<string | null>(null);
  readonly aiBusy = signal(false);
  private unsubscribeLog: (() => void) | undefined;
  private unsubscribeSession: (() => void) | undefined;

  ngOnInit(): void {
    void this.refresh();
    void this.loadAi();
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

  async loadAi(): Promise<void> {
    const state = await getApi()?.getAiState?.();
    if (!state) {
      return;
    }
    this.ai.set(state);
    if (state.configured) {
      await this.loadModels();
    }
  }

  async loadModels(): Promise<void> {
    this.aiBusy.set(true);
    try {
      const result = await getApi()?.listAiModels?.();
      if (result) {
        this.aiModels.set(result.models);
        this.aiMessage.set(result.error);
      }
    } finally {
      this.aiBusy.set(false);
    }
  }

  /** The key is read from the field and cleared immediately; it is never kept in app state. */
  async saveKey(input: HTMLInputElement): Promise<void> {
    const key = input.value;
    if (!key.trim()) {
      return;
    }
    input.value = '';
    this.aiBusy.set(true);
    try {
      const state = await getApi()?.setAiApiKey?.(key);
      if (state) {
        this.ai.set(state);
        this.aiMessage.set(state.error ?? 'API key saved.');
        if (!state.error) {
          await this.loadModels();
        }
      }
    } finally {
      this.aiBusy.set(false);
    }
  }

  async clearKey(): Promise<void> {
    const state = await getApi()?.clearAiApiKey?.();
    if (state) {
      this.ai.set(state);
      this.aiModels.set([]);
      this.aiMessage.set(state.configured ? 'Stored key removed; using the environment key.' : 'API key removed.');
    }
  }

  async onProviderChange(event: Event): Promise<void> {
    const state = await getApi()?.setAiProvider?.((event.target as HTMLSelectElement).value);
    if (!state) {
      return;
    }
    this.ai.set(state);
    this.aiModels.set([]);
    this.aiMessage.set(null);
    if (state.configured) {
      await this.loadModels();
    }
  }

  async saveBaseUrl(input: HTMLInputElement): Promise<void> {
    const state = await getApi()?.setAiBaseUrl?.(input.value);
    if (!state) {
      return;
    }
    this.ai.set(state);
    this.aiMessage.set(state.error ?? 'Base URL saved.');
    if (!state.error && state.configured) {
      await this.loadModels();
    }
  }

  async onAutoSuggestChange(event: Event): Promise<void> {
    const state = await getApi()?.setAiAutoSuggest?.((event.target as HTMLInputElement).checked);
    if (state) {
      this.ai.set(state);
    }
  }

  async onModelChange(event: Event): Promise<void> {
    const state = await getApi()?.setAiModel?.((event.target as HTMLInputElement).value);
    if (state) {
      this.ai.set(state);
    }
  }

  async onEffortChange(event: Event): Promise<void> {
    const state = await getApi()?.setAiEffort?.(
      (event.target as HTMLSelectElement).value as AiEffort,
    );
    if (state) {
      this.ai.set(state);
    }
  }

  openLogFolder(): void {
    void getApi()?.openLogFolder?.();
  }

  quit(): void {
    void getApi()?.quit();
  }
}
