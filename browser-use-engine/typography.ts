/**
 * Centralized Typography Constants for Electron Main Process
 *
 * These mirror the CSS variables in src/styles/index.css
 * Used for injected styles in browser automation, GIF overlays, etc.
 *
 * To change font sizes app-wide:
 * 1. Update src/styles/index.css (for renderer)
 * 2. Update this file (for main process)
 */

export const fontSizes = {
  // Micro sizes
  '2xs': '10px',
  'xs': '11px',

  // Small sizes
  'sm': '12px',
  'base-sm': '13px',

  // Base sizes
  'base': '14.5px',
  'md': '15.5px',

  // Large sizes
  'lg': '18px',
  'xl': '20px',
  '2xl': '24px',
  '3xl': '28px',
  '4xl': '32px',

  // Hero/Display sizes
  '5xl': '36px',
  '6xl': '48px',
  '7xl': '56px',
  '8xl': '64px',
  '9xl': '72px',

  // UI Elements
  'input': '14.5px',
  'button': '13.5px',
  'label': '13.5px',
  'badge': '11px',
} as const;

// Numeric versions for direct assignment
export const fontSizesNumeric = {
  '2xs': 10,
  'xs': 11,
  'sm': 12,
  'base-sm': 13,
  'base': 14,
  'md': 15,
  'lg': 18,
  'xl': 20,
  '2xl': 24,
  '3xl': 28,
  '4xl': 32,
  '5xl': 36,
  '6xl': 48,
  '7xl': 56,
  '8xl': 64,
  '9xl': 72,
} as const;

// GIF/Video overlay specific sizes (optimized for screen recording readability)
export const gifFontSizes = {
  text: 40,      // Default text in GIF overlays
  title: 56,     // Title text (7xl equivalent)
  goal: 44,      // Goal/action text
} as const;
