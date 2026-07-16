// Standard labelled field block for the Sheet panel. One source of truth for
// the label typography (the app-wide label-micro recipe) and the optional
// hint line below the control, so individual sections stop hand-rolling
// slightly-different label/hint markup.
export function Field({ label, labelAdornment, hint, children, className = '' }: {
  label: string;
  // Small inline element rendered right after the label text (e.g. the browser
  // selector tier shield, or a mode toggle for the field). Rendered as a SIBLING
  // of the <label>, never inside it: a <label> with no htmlFor adopts its first
  // labelable descendant as its control, so an interactive adornment placed inside
  // the label would be silently fired by clicks on the caption text or the empty
  // gap. Keeping it outside makes labelAdornment safe for interactive controls too.
  labelAdornment?: React.ReactNode;
  // Muted explainer rendered under the control — replaces the ad-hoc
  // `text-[10px] text-text-tertiary mt-1` divs scattered through the panel.
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <label className="label-micro text-text-tertiary">{label}</label>
        {labelAdornment}
      </div>
      {children}
      {hint && <div className="text-[10px] text-text-tertiary leading-snug mt-1">{hint}</div>}
    </div>
  );
}
