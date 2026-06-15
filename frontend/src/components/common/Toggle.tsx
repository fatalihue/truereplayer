interface ToggleProps {
  isOn: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  // 'sm' = the compact 28×16 switch used in the redesigned Settings panel; default
  // keeps the original 40×20 size for every other surface (dialogs, etc.).
  size?: 'default' | 'sm';
}

export function Toggle({ isOn, onChange, disabled = false, size = 'default' }: ToggleProps) {
  const sm = size === 'sm';
  const track = sm ? 'w-7 h-4' : 'w-10 h-5';
  // Knob: 1px inset on every side inside the 1px border (track inner box is 26×14 for
  // sm / 38×18 for default). The earlier sm values sat the knob flush to the bottom/
  // right edge; these centre it, matching the default look at the smaller size.
  const knob = sm
    ? `w-3 h-3 top-[1px] ${isOn ? 'left-[13px]' : 'left-[1px]'}`
    : `w-3.5 h-3.5 top-[2px] ${isOn ? 'left-[22px]' : 'left-[2px]'}`;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => !disabled && onChange(!isOn)}
      className={`relative ${track} rounded-full transition-colors border ${
        disabled
          ? 'bg-bg-card border-border-subtle opacity-40 cursor-not-allowed'
          : isOn
            ? 'bg-accent-solid border-accent-solid cursor-pointer'
            : 'bg-bg-card border-border-strong cursor-pointer'
      }`}
    >
      <div className={`absolute rounded-full bg-white transition-[left] ${knob}`} />
    </button>
  );
}
