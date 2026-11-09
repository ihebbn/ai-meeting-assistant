import {
  Component,
  ElementRef,
  OnInit,
  afterRenderEffect,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { ListenDiagnostics } from '../audio/listen-diagnostics';
import { AsrBackendId, AsrLanguageId, getApi } from '../electron-api';
import { SessionService } from '../session.service';

@Component({
  selector: 'app-insights',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './insights.component.html',
  styleUrl: './insights.component.css',
})
export class InsightsComponent implements OnInit {
  private readonly sessions = inject(SessionService);
  private readonly diag = inject(ListenDiagnostics);
  private readonly scrollBody = viewChild<ElementRef<HTMLDivElement>>('scrollBody');
  private readonly paintedFinals = new Set<string>();
  readonly session = this.sessions.session;
  readonly showTranscript = computed(() => this.session()?.showTranscript ?? false);

  /** When true, new transcript lines keep the panel pinned to the latest speech. */
  private followTalk = true;

  constructor() {
    afterRenderEffect(() => {
      const show = this.showTranscript();
      const lines = this.session()?.transcript ?? [];
      if (show) {
        for (const line of lines) {
          if (line.id.includes('interim')) {
            if (line.text === '…') {
              this.diag.noteInterimPaint(line.id);
            }
            continue;
          }
          if (!this.paintedFinals.has(line.id)) {
            this.paintedFinals.add(line.id);
            this.diag.notePainted(line.id);
          }
        }
        if (this.paintedFinals.size > 400) {
          const live = new Set(lines.map((line) => line.id));
          for (const id of this.paintedFinals) {
            if (!live.has(id)) {
              this.paintedFinals.delete(id);
            }
          }
        }
      }
      const el = this.scrollBody()?.nativeElement;
      if (!show || !el || lines.length === 0 || !this.followTalk) {
        return;
      }
      el.scrollTop = el.scrollHeight;
    });
  }

  ngOnInit(): void {
    void this.sessions.init();
  }

  onTranscriptScroll(event: Event): void {
    if (!this.showTranscript()) {
      return;
    }
    const el = event.target as HTMLElement;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.followTalk = distanceFromBottom < 56;
  }

  toggleTranscript(): void {
    this.followTalk = true;
    void getApi()?.toggleTranscript?.();
  }

  openMicSettings(): void {
    void getApi()?.openMicSettings?.();
  }

  onBackendChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as AsrBackendId;
    void getApi()?.setAsrBackend?.(value);
  }

  onLanguageChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as AsrLanguageId;
    void getApi()?.setAsrLanguage?.(value);
  }

  onCompareChange(event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    void getApi()?.setCompareMode?.(enabled);
  }

  onScreenVisionChange(event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    void getApi()?.setScreenVisionEnabled?.(enabled);
  }

  collapse(): void {
    void getApi()?.setPanelOpen?.('insights', false);
  }

  isMicError(message: string | null | undefined): boolean {
    return !!message && /microphone|mic /i.test(message);
  }

  runAction(id: string): void {
    void getApi()?.runAction?.(id);
  }

  iconPath(icon: string): string {
    switch (icon) {
      case 'book':
        return 'M6 4h9a2 2 0 0 1 2 2v14l-5-2-5 2V6a2 2 0 0 1 2-2z';
      case 'globe':
        return 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2c1.7 0 3.2 2.7 3.7 6H8.3C8.8 7.7 10.3 5 12 5zm-3.9 8h7.8c-.5 3.3-2 6-3.9 6s-3.4-2.7-3.9-6zM4.7 11h2.7c.2-1.5.5-2.9 1-4.1A7.03 7.03 0 0 0 4.7 11zm10.9-4.1c.5 1.2.8 2.6 1 4.1h2.7a7.03 7.03 0 0 0-3.7-4.1zM7.4 17.1c-.5-1.2-.8-2.6-1-4.1H4.7a7.03 7.03 0 0 0 2.7 4.1zm8.9 0a7.03 7.03 0 0 0 2.7-4.1h-2.7c-.2 1.5-.5 2.9-1 4.1z';
      case 'chat':
        return 'M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H10l-4 4v-4H7a3 3 0 0 1-3-3V5z';
      case 'reply':
        return 'M10 8V5L3 12l7 7v-3.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z';
      default:
        return 'M12 3l1.4 4.2L18 9l-4.2 1.4L12 15l-1.4-4.6L6 9l4.6-1.8L12 3zm6 10l.8 2.4L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.6L18 13zM5 14l.7 2L8 17l-2.3.7L5 20l-.7-2.3L2 17l2.3-.9L5 14z';
    }
  }
}
