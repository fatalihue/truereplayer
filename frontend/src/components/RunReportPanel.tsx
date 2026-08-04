import { useEffect, useMemo, useState } from 'react';
import { ListChecks, CheckCircle2, XCircle, MinusCircle, TriangleAlert, RefreshCw } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useTt } from '../state/LanguageContext';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import type { RunReport, RunStep } from '../bridge/messageTypes';

// Structured codes the extension emits (content.js mkError) plus the two the native bridge
// synthesises on timeout. Translated here rather than in the backend because the CODES are the
// stable contract — the prose around them is presentation.
//
// This list is checked against the real emitters, not guessed: the extension's codes are all
// ELEMENT_-prefixed (ELEMENT_COVERED, not COVERED), and an unlisted code is not a problem —
// the row falls back to the raw message, which is still the extension's own English sentence.
function explainCode(code: string | null, tt: (en: string, pt: string) => string): string | null {
  switch (code) {
    case 'ELEMENT_NOT_FOUND':
      return tt('No element matched the selector.', 'Nenhum elemento casou com o seletor.');
    case 'ELEMENT_HIDDEN':
      return tt('Found, but not visible on screen.', 'Encontrado, mas não visível na tela.');
    case 'ELEMENT_DISABLED':
      return tt('Found, but disabled.', 'Encontrado, mas desabilitado.');
    case 'ELEMENT_COVERED':
      return tt('Found, but something is on top of it.', 'Encontrado, mas há algo por cima dele.');
    case 'SELECTOR_INVALID':
      return tt('The selector is not valid CSS.', 'O seletor não é um CSS válido.');
    case 'NAVIGATION_TIMEOUT':
      return tt('The page did not finish loading in time.', 'A página não terminou de carregar a tempo.');
    case 'INVALID_URL':
      return tt('That is not a URL the browser can open.', 'Isso não é uma URL que o navegador consiga abrir.');
    case 'OPTION_NOT_FOUND':
      return tt('No option in the list matched.', 'Nenhuma opção da lista casou.');
    case 'OPTION_DISABLED':
      return tt('The option matched, but it is disabled.', 'A opção casou, mas está desabilitada.');
    case 'NOT_A_SELECT':
      return tt('That element is not a dropdown list.', 'Esse elemento não é uma lista suspensa.');
    case 'TAB_GONE':
      return tt('The tab this run was acting on was closed.', 'A aba em que esta execução estava agindo foi fechada.');
    case 'NO_CONTENT_SCRIPT':
      // Browser actions run on whichever Chrome tab is active, so this fires when that tab is a
      // page extensions cannot touch (chrome://, the Web Store) or one that needs a reload.
      return tt('The active Chrome tab cannot be automated.', 'A aba ativa do Chrome não pode ser automatizada.');
    default:
      return null;
  }
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function StatusIcon({ status }: { status: RunStep['status'] }) {
  if (status === 'failed') return <XCircle size={13} style={{ color: 'var(--color-recording)' }} />;
  if (status === 'skipped') return <MinusCircle size={13} className="text-text-disabled" />;
  return <CheckCircle2 size={13} style={{ color: 'var(--color-replay)' }} />;
}

/**
 * Last-run diagnostic timeline. Exists for one question: "my browser macro worked yesterday and
 * silently does nothing today — which step broke, and why?" The engine already knew the answer
 * (structured error code, tip, and which selector TIER matched) and used to discard it.
 *
 * Read-only and last-run-only. It is a debugging aid for the run you just watched, not a log.
 */
export function RunReportPanel({ onClose }: { onClose: () => void }) {
  const { send, subscribe } = useBridge();
  const tt = useTt();
  const [report, setReport] = useState<RunReport | null>(null);

  useEffect(() => {
    send({ type: 'replay:reportRequest', payload: {} });
    return subscribe((msg) => {
      if (msg.type === 'replay:report') setReport(msg.payload);
    });
  }, [send, subscribe]);

  // Memoised because `?? []` builds a NEW array on every render, which made the stats useMemo
  // below recompute every time regardless of whether the report actually changed.
  const steps = useMemo(() => report?.steps ?? [], [report]);
  const stats = useMemo(() => {
    const failed = steps.filter((s) => s.status === 'failed').length;
    const total = steps.reduce((a, s) => a + s.durationMs, 0);
    // A fallback match is not a failure, but it IS the early warning that the primary selector
    // is dead — surface it at the same level as a failure count.
    const drifting = steps.filter((s) => s.matchedTier).length;
    // A run is bound to ONE tab, so more than one distinct page across the steps means something
    // redirected it. Only worth showing when it happened — on a normal run this is 0 or 1.
    const pages = [...new Set(steps.map((s) => s.tabUrl).filter(Boolean))] as string[];
    return { failed, total, drifting, pages };
  }, [steps]);

  return (
    <DialogShell
      icon={<ListChecks size={14} className="text-accent-light" />}
      title="Run report"
      widthClass="w-[720px] h-[70vh] max-h-[640px]"
      maxWidthClass="max-w-[calc(100vw-24px)]"
      onClose={onClose}
      showClose
      footer={() => (
        <>
          <div className="mr-auto text-[11px] text-text-tertiary">
            {steps.length > 0
              ? `${steps.length} ${tt('steps', 'passos')} · ${fmtMs(stats.total)}` +
                (stats.failed > 0 ? ` · ${stats.failed} ${tt('failed', 'falharam')}` : '')
              : ''}
          </div>
          <Button variant="secondary" onClick={() => send({ type: 'replay:reportRequest', payload: {} })}>
            <RefreshCw size={12} /> {tt('Refresh', 'Atualizar')}
          </Button>
          <Button variant="primary" onClick={onClose}>{tt('Close', 'Fechar')}</Button>
        </>
      )}
    >
      <div className="h-full overflow-y-auto p-3">
        {steps.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-[12px] text-text-tertiary px-8 leading-relaxed">
            {tt('No run recorded yet. Play a profile and the steps will show up here — with the selector that matched, how long each step took, and why any of them failed.',
                'Nenhuma execução registrada ainda. Rode um profile e os passos aparecem aqui — com o seletor que casou, quanto cada passo levou e por que algum falhou.')}
          </div>
        ) : (
          <>
            {stats.drifting > 0 && (
              <div className="mb-2 rounded border px-3 py-2 text-[11px] leading-relaxed"
                style={{
                  color: 'var(--color-recording)',
                  borderColor: 'color-mix(in srgb, var(--color-recording) 40%, transparent)',
                  backgroundColor: 'color-mix(in srgb, var(--color-recording) 10%, transparent)',
                }}>
                <TriangleAlert size={12} className="inline mr-1 -mt-0.5" />
                {tt(`${stats.drifting} step(s) matched through a FALLBACK selector — the one you picked no longer matches. Re-pick those elements before the fallbacks drift too.`,
                    `${stats.drifting} passo(s) casaram por um seletor de RESERVA — o que você escolheu não casa mais. Re-escolha esses elementos antes que as reservas também mudem.`)}
              </div>
            )}
            <div className="space-y-px">
              {steps.map((s, idx) => (
                <div key={idx}
                  className={`rounded px-2 py-1.5 ${s.status === 'failed' ? 'bg-bg-card' : 'hover:bg-bg-elevated/50'}`}>
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="w-7 shrink-0 text-right font-mono text-[10px] text-text-disabled">{s.row}</span>
                    <StatusIcon status={s.status} />
                    <span className="text-text-primary shrink-0">{s.actionType}</span>
                    {s.detail && (
                      <span className="font-mono text-[11px] text-text-tertiary truncate min-w-0" title={s.detail}>
                        {s.detail}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-text-disabled">
                      {fmtMs(s.durationMs)}
                    </span>
                  </div>

                  {/* The fallback-tier line is the whole reason this panel exists — a step that
                      PASSED can still be the one telling you the macro is about to break. */}
                  {/* On a passing step this is noise unless the run spanned more than one page.
                      On a FAILING one it is the first question the failure raises — the same
                      "no element matched" reads completely differently once you can see the run
                      was on a login page. So a failure always names its page. */}
                  {s.tabUrl && (s.status === 'failed' || stats.pages.length > 1) && (
                    <div className="ml-[52px] mt-0.5 text-[10px] font-mono text-text-tertiary truncate" title={s.tabUrl}>
                      {s.tabUrl}
                    </div>
                  )}

                  {s.matchedTier && (
                    <div className="ml-[52px] mt-0.5 text-[10px] leading-snug" style={{ color: 'var(--color-recording)' }}>
                      {tt('matched via fallback', 'casou por reserva')} <b>tier {s.matchedTier}</b>
                      {s.matchedSelector && <span className="font-mono"> · {s.matchedSelector}</span>}
                    </div>
                  )}

                  {s.status === 'failed' && (
                    <div className="ml-[52px] mt-0.5 space-y-0.5">
                      {s.errorCode && (
                        <div className="text-[10px] font-mono text-text-tertiary">{s.errorCode}</div>
                      )}
                      <div className="text-[11px] leading-snug" style={{ color: 'var(--color-recording)' }}>
                        {explainCode(s.errorCode, tt) ?? s.errorMessage}
                      </div>
                      {s.tip && (
                        <div className="text-[10px] text-text-tertiary leading-snug">{s.tip}</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {(report?.overflow ?? 0) > 0 && (
              <div className="mt-2 text-[10px] text-text-tertiary text-center">
                {tt(`+${report!.overflow} more steps not recorded (report is capped).`,
                    `+${report!.overflow} passos não registrados (o relatório tem limite).`)}
              </div>
            )}
          </>
        )}
      </div>
    </DialogShell>
  );
}
