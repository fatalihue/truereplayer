interface ToggleProps {
  isOn: boolean;
  onChange: (value: boolean) => void;
}

export function Toggle({ isOn, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!isOn)}
      className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer border ${
        isOn
          ? 'bg-accent-solid border-accent-solid'
          : 'bg-bg-card border-border-strong'
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
