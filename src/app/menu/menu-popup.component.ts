import { Component } from '@angular/core';

type MenuPopupApi = {
  openSettings: () => Promise<void>;
  quit: () => Promise<void>;
  close: () => Promise<void>;
};

declare global {
  interface Window {
    meetingCopilotMenu?: MenuPopupApi;
  }
}

@Component({
  selector: 'app-menu-popup',
  standalone: true,
  templateUrl: './menu-popup.component.html',
  styleUrl: './menu-popup.component.css',
})
export class MenuPopupComponent {
  openSettings(): void {
    void window.meetingCopilotMenu?.openSettings();
  }

  quit(): void {
    void window.meetingCopilotMenu?.quit();
  }
}
