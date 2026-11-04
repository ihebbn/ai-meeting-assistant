import { Routes } from '@angular/router';
import { DiagnosticsComponent } from './diagnostics/diagnostics.component';
import { MenuPopupComponent } from './menu/menu-popup.component';
import { OverlayShellComponent } from './overlay/overlay-shell.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'overlay' },
  { path: 'overlay', component: OverlayShellComponent },
  { path: 'menu', component: MenuPopupComponent },
  { path: 'diagnostics', component: DiagnosticsComponent },
  { path: '**', redirectTo: 'overlay' },
];
