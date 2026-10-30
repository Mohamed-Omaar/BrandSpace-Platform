import { themeLookSchema, type ThemeLook, type ThemePresetKey } from './schema';

/**
 * THE STARTING PRESETS (LF): the original look, and three-plus-one owner
 * starting points. Each is a partial look; what it does not say stays the
 * original. Every preset passes the contrast checks (tests/unit/theme.test.ts).
 */
const PRESET_INPUT: Record<ThemePresetKey, unknown> = {
  original: {},
  calm: {
    colours: { primary: '#4f5bd5' },
    shape: { radius: 'round', shadows: 'soft' },
    motion: { speed: 'calm' },
  },
  modern: {
    shape: { radius: 'sharp', shadows: 'medium' },
    buttons: { style: 'soft' },
    fields: { style: 'outlined', border: '1.5' },
    motion: { speed: 'quick' },
  },
  premium: {
    colours: { primary: '#3d2a74', secondary: '#d4a900' },
    shape: { shadows: 'medium' },
    text: { font: 'ibm-plex-sans-arabic', lineHeight: 'relaxed' },
    motion: { speed: 'calm' },
  },
  // "Light and fast": every effect off.
  light: {
    shape: { shadows: 'none' },
    motion: { level: 'reduced', speed: 'quick' },
    effects: { overlayBlur: false, gradients: false, glass: false },
  },
};

export function presetLook(key: ThemePresetKey): ThemeLook {
  return themeLookSchema.parse(PRESET_INPUT[key]);
}
