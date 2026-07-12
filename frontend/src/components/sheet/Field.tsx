// Standard labelled field block for the Sheet panel. One source of truth for
// the label typography (the app-wide label-micro recipe) and the optional
// hint line below the control, so individual sections stop hand-rolling
// slightly-different label/hint markup.
export function Field({ label, labelAdornment, hint, children, className = '' }: {
  label: string;
  // Small inline element rendered right after the label text (e.g. the browser
  // selector tier shield). Keeps adorned labels on the ONE Field recipe instead
  // of hand-rolled <label> rows.
  labelAdornment?: React.ReactNode;
  // Muted explainer rendered under the control — replaces the ad-hoc
  // `text-[10px] text-text-tertiary mt-1` divs scattered through the panel.
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label-micro text-text-tertiary mb-1.5 flex items-center gap-1.5">
        {label}
        {labelAdornment}
      </label>
      {children}
      {hint && <div className="text-[10px] text-text-tertiary leading-snug mt-1">{hint}</div>}
    </div>
  );
}
