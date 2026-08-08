import { MousePointerClick } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useTt } from '../state/LanguageContext';

export function ClickerEmptyState() {
  const { settings } = useAppState();
  const tt = useTt();
  // "Clicker mode" stays English — it is a label. The sentence below is instructional
  // prose, which the convention says is bilingual, and the app defaults to pt-BR.
  const unbounded = !settings.cursorClickUseLoops;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 rounded-ui border border-border-subtle bg-bg-surface min-h-0">
      <MousePointerClick size={32} style={{ color: 'var(--color-clicker-fg)', opacity: 0.7 }} />
      <div className="text-[14px] font-semibold" style={{ color: 'var(--color-clicker-fg)' }}>
        Clicker mode
      </div>
      <div className="text-[12px] text-text-tertiary text-center max-w-[420px] px-4">
        {tt('Recorded actions and profile hotkeys are ignored.',
            'Ações gravadas e hotkeys de perfil são ignoradas.')}
        {' '}{tt('Press', 'Pressione')}{' '}
        <kbd className="kbd kbd-accent">{settings.cursorClickStartHotkey}</kbd>
        {' '}
        {/* Say up front that the run has no end, and name the key that stops it. With the
            Loops chip off now meaning unbounded, this is the surface where that has to be
            legible BEFORE the key is pressed. */}
        {unbounded
          ? tt('to start clicking — it runs until you press it again.',
               'para começar a clicar — roda até você pressionar de novo.')
          : tt('to start clicking at cursor.', 'para começar a clicar no cursor.')}
      </div>
    </div>
  );
}
