import { Component, OnInit, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { getApi } from '../electron-api';
import { SessionService } from '../session.service';

@Component({
  selector: 'app-response',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './response.component.html',
  styleUrl: './response.component.css',
})
export class ResponseComponent implements OnInit {
  private readonly sessions = inject(SessionService);
  readonly session = this.sessions.session;
  readonly assistantText = computed(() => {
    const messages = this.session()?.messages ?? [];
    const assistant = [...messages].reverse().find((m) => m.role === 'assistant');
    return assistant?.text ?? '';
  });
  readonly streaming = computed(() => {
    const messages = this.session()?.messages ?? [];
    return messages.some((m) => m.role === 'assistant' && m.streaming);
  });
  draft = '';

  ngOnInit(): void {
    void this.sessions.init().then(() => {
      this.draft = this.session()?.followUpDraft ?? '';
    });
  }

  onDraftChange(value: string): void {
    this.draft = value;
    void getApi()?.setFollowUpDraft?.(value);
  }

  submit(): void {
    const prompt = this.draft.trim();
    if (!prompt) {
      return;
    }
    this.draft = '';
    void getApi()?.ask?.(prompt);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submit();
    }
  }

  async copy(): Promise<void> {
    const text = this.assistantText();
    if (!text) {
      return;
    }
    await getApi()?.copyText?.(text);
  }

  collapse(): void {
    void getApi()?.setPanelOpen?.('response', false);
  }
}
