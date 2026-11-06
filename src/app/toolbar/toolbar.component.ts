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
  /** Overlay is protected from screen capture unless settings say otherwise. */
  readonly protectedFromCapture = computed(() => this.session()?.contentProtection ?? true);
  readonly captureProtectionSupported = computed(
    () => this.session()?.contentProtectionSupported ?? true,
  );
  readonly platformLabel = computed(() => this.session()?.platformLabel ?? '');
  readonly menuOpen = computed(() => this.session()?.menuOpen ?? false);
  readonly askLabel = computed(() => this.session()?.askShortcutLabel ?? 'Ctrl+Enter');
  readonly hideLabel = computed(() => this.session()?.hideShortcutLabel ?? 'Ctrl+\\');

  ngOnInit(): void {
    void this.sessions.init();
  }

  enableProtection(): void {
    void getApi()?.setContentProtection?.(true);
  }

  toggleListen(): void {
    void getApi()?.toggleListen?.();
  }

  ask(): void {
    void getApi()?.ask?.('Suggest a reply');
  }

  toggleHidePanels(): void {
    void getApi()?.toggleHidden?.();
  }

  toggleInsights(): void {
    void getApi()?.togglePanel?.('insights');
  }

  toggleResponse(): void {
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
