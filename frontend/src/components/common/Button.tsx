import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * THE button. Seeded from the app's own strongest convention — the dialog-footer
 * Cancel/primary pair that eight dialogs shipped verbatim — plus the Wave-1 ink
 * tokens so no variant can pair illegible text with a themed fill.
 *
 *   primary      solid accent fill, ink contrast-picked per theme (--color-accent-ink)
 *   secondary    the Cancel convention: quiet card fill + subtle border
 *   ghost        borderless, text-only until hover (toolbar-adjacent uses)
 *   destructive  recording-red fill + its ink token (Clear all / Delete confirms)
 *
 * Sizes: sm = the existing dialog-footer metrics; md = the 32px control standard
 * (Fluent medium — same height the SheetPanel locked in 2.6.10).
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type ButtonSize = 'sm' | 'md';

// Pressed = one step dimmer (Fluent physics: fills darken on press, never
// scale-transform — that reads web/mobile, not Windows).
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // hover uses the derived --color-accent-solid-hover (shifts away from the ink)
  // instead of /80 alpha, which could erode the contrast pickInk guaranteed.
  primary: 'bg-accent-solid hover:bg-[var(--color-accent-solid-hover)] active:brightness-90 text-[color:var(--color-accent-ink)]',
  secondary: 'text-text-secondary bg-bg-card hover:bg-bg-surface active:bg-bg-elevated border border-border-subtle',
  ghost: 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated active:bg-bg-card',
  destructive: 'bg-recording text-[color:var(--color-recording-ink)] hover:opacity-85 active:opacity-75',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-4 py-1.5 text-xs',
  md: 'h-8 px-4 text-ui',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
