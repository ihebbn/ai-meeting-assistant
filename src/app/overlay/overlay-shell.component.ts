import { Component, HostListener, OnInit, computed, inject } from '@angular/core';
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
  host: {
    '[class.window-inactive]': 'windowInactive',
  },
})
export class OverlayShellComponent implements OnInit {
  private readonly sessions = inject(SessionService);
  readonly session = this.sessions.session;
  readonly insightsOpen = computed(() => this.session()?.insightsVisible ?? false);
  readonly responseOpen = computed(() => this.session()?.responseVisible ?? false);
  readonly anyPanelOpen = computed(() => this.session()?.anyPanelOpen ?? false);
  windowInactive = false;

  private resizing = false;
  private startX = 0;
  private startY = 0;
  private startW = 0;
  private startH = 0;

  ngOnInit(): void {
    void this.sessions.init();
    this.keepDocumentTransparent();
  }

  @HostListener('window:blur')
  onWindowBlur(): void {
    this.windowInactive = true;
    this.keepDocumentTransparent();
  }

  @HostListener('window:focus')
  onWindowFocus(): void {
    this.windowInactive = false;
    this.keepDocumentTransparent();
  }

  private keepDocumentTransparent(): void {
    const root = document.documentElement;
    const body = document.body;
    root.style.setProperty('background', 'transparent', 'important');
    root.style.setProperty('background-color', 'transparent', 'important');
    body.style.setProperty('background', 'transparent', 'important');
    body.style.setProperty('background-color', 'transparent', 'important');
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
