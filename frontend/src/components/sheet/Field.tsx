// Standard labelled field block for the Sheet panel. One source of truth for
// the label typography (11px semibold tertiary, uppercase) and the optional
// hint line below the control, so individual sections stop hand-rolling
// slightly-different label/hint markup.
export function Field({ label, hint, children, className = '' }: {
  label: string;
  // Muted explainer rendered under the control — replaces the ad-hoc
  // `text-[10px] text-text-tertiary mt-1` divs scattered through the panel.
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wide mb-1.5">
        {label}
      </label>
      {children}
      {hint && <div className="text-[10px] text-text-tertiary leading-snug mt-1">{hint}</div>}
    </div>
  );
}
