/**
 * What the current OS can actually do. Keeps platform claims in one place so the UI never
 * promises something (like capture protection) the platform cannot deliver.
 */
export type PlatformCaps = {
  /** Human-readable OS name for messages. */
  label: string;
  /**
   * Electron's setContentProtection excludes the window from screen capture. Electron
   * documents it for macOS and Windows only; on Linux it does nothing.
   */
  contentProtection: boolean;
  /** Deep links that open the OS microphone/sound settings (empty when none is known). */
  micSettingsLinks: readonly string[];
};

export function platformCaps(platform: NodeJS.Platform): PlatformCaps {
  switch (platform) {
    case 'win32':
      return {
        label: 'Windows',
        contentProtection: true,
        micSettingsLinks: ['ms-settings:privacy-microphone', 'ms-settings:sound'],
      };
    case 'darwin':
      // No verified deep link, so none is offered.
      return { label: 'macOS', contentProtection: true, micSettingsLinks: [] };
    case 'linux':
      // Settings apps differ per desktop environment, so there is no reliable deep link.
      return { label: 'Linux', contentProtection: false, micSettingsLinks: [] };
    default:
      return { label: String(platform), contentProtection: false, micSettingsLinks: [] };
  }
}
