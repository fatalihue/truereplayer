interface ToggleProps {
  isOn: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ isOn, onChange, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!isOn)}
      className={`relative w-10 h-5 rounded-full transition-colors border ${
        disabled
          ? 'bg-bg-card border-border-subtle opacity-40 cursor-not-allowed'
          : isOn
            ? 'bg-accent-solid border-accent-solid cursor-pointer'
            : 'bg-bg-card border-border-strong cursor-pointer'
      }`}
    >
      <div
        className={`absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white transition-[left] ${
          isOn ? 'left-[22px]' : 'left-[2px]'
        }`}
      />
    </button>
  );
}
