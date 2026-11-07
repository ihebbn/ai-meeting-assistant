import { Component, ElementRef, HostListener, OnInit, computed, inject, viewChild } from '@angular/core';
import { formatElapsed, getApi } from '../electron-api';
import { SessionService } from '../session.service';

@Component({
  selector: 'app-toolbar',
  standalone: true,
  templateUrl: './toolbar.component.html',
  styleUrl: './toolbar.component.css',
})
export class ToolbarComponent implements OnInit {
  private readonly sessions = inject(SessionService);
  private readonly moreBtn = viewChild<ElementRef<HTMLButtonElement>>('moreBtn');

  readonly session = this.sessions.session;
  readonly elapsed = computed(() =>
    formatElapsed(this.session()?.elapsedSeconds ?? 0),
  );
  readonly listening = computed(() => this.session()?.listening ?? false);
  readonly micLevel = computed(() => this.session()?.audio?.micLevel ?? 0);
  readonly systemLevel = computed(() => this.session()?.audio?.systemLevel ?? 0);
  readonly micActive = computed(() => this.session()?.audio?.micActive ?? false);
  readonly systemActive = computed(() => this.session()?.audio?.systemActive ?? false);
  readonly insightsOpen = computed(() => this.session()?.insightsVisible ?? false);
  readonly responseOpen = computed(() => this.session()?.responseVisible ?? false);
  readonly panelsHidden = computed(() => this.session()?.panelsHidden ?? false);
  readonly menuOpen = computed(() => this.session()?.menuOpen ?? false);
  readonly askLabel = computed(() => this.session()?.askShortcutLabel ?? 'Ctrl+Enter');
  readonly hideLabel = computed(() => this.session()?.hideShortcutLabel ?? 'Ctrl+\\');

  ngOnInit(): void {
    void this.sessions.init();
  }

  toggleListen(): void {
    const cur = this.session();
    const next = !(cur?.listening ?? false);
    // Instant feedback — capture startup still runs in the background.
    this.sessions.patchLocal({
      listening: next,
      listenStatus: next ? 'starting' : 'idle',
      listenError: next ? null : cur?.listenError ?? null,
    });
    void getApi()?.toggleListen?.();
  }

  ask(): void {
    // Empty prompt → shortcut path (latest spoken question / on-screen task).
    void getApi()?.ask?.('');
  }

  toggleHidePanels(): void {
    const cur = this.session();
    this.sessions.patchLocal({ panelsHidden: !(cur?.panelsHidden ?? false) });
    void getApi()?.toggleHidden?.();
  }

  toggleInsights(): void {
    const cur = this.session();
    const open = !(cur?.insightsVisible ?? false);
    this.sessions.patchLocal({
      insightsOpen: open,
      panelsHidden: false,
    });
    void getApi()?.togglePanel?.('insights');
  }

  toggleResponse(): void {
    const cur = this.session();
    const open = !(cur?.responseVisible ?? false);
    this.sessions.patchLocal({
      responseOpen: open,
      panelsHidden: false,
    });
    void getApi()?.togglePanel?.('response');
  }

  async toggleMenu(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const api = getApi();
    const btn = this.moreBtn()?.nativeElement ?? (event.currentTarget as HTMLButtonElement);
    const anchor = btn.getBoundingClientRect();
    const payload = {
      top: anchor.top,
      right: anchor.right,
      bottom: anchor.bottom,
      left: anchor.left,
    };

    if (!api?.toggleMenu) {
      console.error(
        'toggleMenu API missing on window.meetingCopilot — fully quit and run npm start',
        Object.keys(api ?? {}),
      );
      return;
    }

    try {
      const result = await api.toggleMenu(payload);
      console.info('toggleMenu result', result);
    } catch (err) {
      console.error('toggleMenu failed', err);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.menuOpen()) {
      void getApi()?.closeMenu?.();
    }
  }
}
