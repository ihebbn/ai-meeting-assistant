import { Component, OnInit, computed, inject } from '@angular/core';
import { getApi } from '../electron-api';
import { InsightsComponent } from '../insights/insights.component';
import { ResponseComponent } from '../response/response.component';
import { SessionService } from '../session.service';
import { ToolbarComponent } from '../toolbar/toolbar.component';

@Component({
  selector: 'app-overlay-shell',
  standalone: true,
  imports: [ToolbarComponent, InsightsComponent, ResponseComponent],
  templateUrl: './overlay-shell.component.html',
  styleUrl: './overlay-shell.component.css',
})
export class OverlayShellComponent implements OnInit {
  private readonly sessions = inject(SessionService);
  readonly session = this.sessions.session;
  readonly insightsOpen = computed(() => this.session()?.insightsVisible ?? false);
  readonly responseOpen = computed(() => this.session()?.responseVisible ?? false);
  readonly anyPanelOpen = computed(() => this.session()?.anyPanelOpen ?? false);

  private resizing = false;
  private startX = 0;
  private startY = 0;
  private startW = 0;
  private startH = 0;

  ngOnInit(): void {
    void this.sessions.init();
  }

  onResizeStart(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const size = this.session()?.panelSize;
    if (!size) {
      return;
    }
    this.resizing = true;
    this.startX = event.screenX;
    this.startY = event.screenY;
    this.startW = size.width;
    this.startH = size.height;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  onResizeMove(event: PointerEvent): void {
    if (!this.resizing) {
      return;
    }
    const width = this.startW + (event.screenX - this.startX);
    const height = this.startH + (event.screenY - this.startY);
    void getApi()?.resizePanel?.(width, height);
  }

  onResizeEnd(event: PointerEvent): void {
    if (!this.resizing) {
      return;
    }
    this.resizing = false;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
  }
}
