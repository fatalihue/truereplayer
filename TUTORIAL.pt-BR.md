<sub>[English](TUTORIAL.md) · **Português (BR)**</sub>

# TrueReplayer — Referência de Recursos

Um tour conciso por cada ação e configuração. Novos usuários: leiam de cima a baixo (5 min). Usuários retornando: usem o sumário para pular direto.

## Sumário
- [Modos de Execução](#modos-de-execução)
- [Botões Principais](#botões-principais)
- [Ações de Teclado](#ações-de-teclado)
- [Ações de Mouse](#ações-de-mouse)
- [Ações de Espera / Fluxo](#ações-de-espera--fluxo)
- [Ações de Navegador](#ações-de-navegador)
- [Settings — Execução](#settings--execução)
- [Settings — Gravação](#settings--gravação)
- [Settings — Clicker](#settings--clicker)
- [Profiles](#profiles)
- [Hotkeys Globais](#hotkeys-globais)
- [Edição da Lista](#edição-da-lista)
- [Outros](#outros)
- [Primeiro uso típico](#primeiro-uso-típico)

---

## Modos de Execução
- **Macro** — executa a lista de ações gravadas em ordem
- **Clicker** — clica repetidamente na posição atual do cursor (ignora a lista de ações e profiles)

## Botões Principais
- **Recording** (vermelho) — captura cliques, teclas e scrolls em tempo real
- **Replay** (verde) — executa a lista de ações
- **Save / Load** — salva ou carrega profiles

---

## Ações de Teclado
- **Send Key** — digita uma tecla única (ex: `Enter`)
- **Send Keystroke** — combo atômico (ex: `Ctrl+Shift+T`)
- **Press Key × N** — pressiona uma tecla N vezes com intervalo configurável
- **Hold Key** — mantém uma tecla pressionada por X ms (ex: segurar `W` por 1.5s)
- **Send Text** — cola texto; suporta tokens `{clipboard}`, `{date}`, `{time}`, `{datetime}`

## Ações de Mouse
Capturadas automaticamente durante a gravação. Cada linha pode ser editada ou duplicada depois.
- **LeftClick / RightClick / MiddleClick** — divididas em Down + Up para que gestos de arrastar funcionem
- **ScrollUp / ScrollDown**

## Ações de Espera / Fluxo
- **Pause** — aguarda um tempo fixo, ou até uma hotkey escolhida ser pressionada
- **Wait for Image** — procura uma imagem de referência na tela
  - Opções: timeout, limite de confiança, região de busca, clicar ao encontrar, inverter (esperar a imagem sumir), comportamento no timeout (parar / continuar / encerrar replay)
- **Run Profile** — executa outro profile como sub-rotina, com contagem de repetições (suporta cadeia, com detecção de loop infinito)

## Ações de Navegador
Disponíveis quando a [extensão Chrome](ChromeExtension) está instalada e conectada.
- **Click Element / Right Click Element** — clica em um seletor CSS
- **Type Text** — digita em um campo (modo append ou paste, delay por caractere configurável)
- **Select Option** — escolhe uma `<option>` de `<select>` por texto, value ou índice
- **Wait Element** — aguarda elemento aparecer, sumir, habilitar ou bater texto
- **Open URL** — abre uma URL (mesma aba ou nova); espera opcional por URL/seletor após o load

---

## Settings — Execução
- **Delay** — tempo fixo entre ações (ms)
- **Jitter** — variação aleatória ±% no delay (anti-detecção)
- **Loops** — quantas vezes repetir a macro (0 = infinito)
- **Interval** — pausa entre loops

## Settings — Gravação
Liga/desliga captura de: **Mouse Clicks**, **Mouse Scroll**, **Keyboard**, **Profile Keys**, **Browser Actions**.

## Settings — Clicker
Painel dedicado que substitui Execução/Gravação quando o modo Clicker está ativo.
- **Button** (Esquerdo / Direito / Meio)
- **Rate** (cliques por segundo ou delay em ms — alterne a unidade)
- **Jitter** (±% no delay)
- **Hold** (ms que o botão fica pressionado)
- **Position jitter** (±px ao redor do cursor)
- **Loops** (0 = infinito)
- **Interval** (pausa entre loops)

---

## Profiles
- **Pastas coloridas** para organizar macros
- **Pin** para manter um profile fixo no topo
- **Hotkey por profile** com quatro modos de disparo:
  - `On Press` — dispara uma vez ao pressionar a tecla
  - `On Release` — dispara uma vez ao soltar a tecla
  - `While Pressed` — executa em loop enquanto segurar, para ao soltar
  - `Toggle` — pressione para começar, pressione de novo para parar
- **Hotstring** — palavra-gatilho que dispara o profile quando digitada em qualquer lugar
- **Window Target** — vincula um profile a uma janela específica (nome do processo + título, modo `contains` ou `regex`); a hotkey só dispara quando essa janela está focada
- **Coordenadas relativas** — os cliques se ajustam automaticamente à posição atual da janela
- **Restore position / size** — restaura a geometria gravada da janela antes do replay
- **Bring to focus** — foca a janela alvo antes do replay
- **Export / Import** — compartilhe profiles entre máquinas (pastas + hotkeys inclusas)

## Hotkeys Globais
Configuráveis em **Global → Hotkeys**.
- **Recording** — inicia/para a gravação
- **Replay** — inicia/para o profile ativo (ou as ações atuais)
- **Profile Keys** — chave-mestra que suspende todas as hotkeys de profile de uma vez
- **Foreground** — diagnóstico: imprime a janela em foreground para você configurar um target

---

## Edição da Lista
- **Undo / Redo** — `Ctrl+Z` / `Ctrl+Y`
- **Copiar / Colar** ações — `Ctrl+C` / `Ctrl+V`
- **Mover para cima/baixo** — `Alt+↑` / `Alt+↓`
- **Edição em massa** — selecione várias linhas e altere delay / X / Y / notas / estado de skip de uma vez
- **Skip** — desabilita uma ação sem deletar (replay pula linhas com skip)
- **Notes** — comentário por ação, exibido na coluna Notes

## Outros
- **Always On Top**, **System Tray**, **Run on Startup**, **Run as Administrator**
- **Theme Editor** — cores totalmente customizáveis
- **Toggle Columns** — mostra/oculta colunas da tabela (Action, Key, X, Y, Delay, Notes)
- **Command Palette** — busca fuzzy de comandos (`Ctrl+K`)
- **Auto-update** — verifica o feed de releases e avisa quando há nova versão

---

## Primeiro uso típico

1. Clique em **Recording**, execute as ações no app desejado, clique em **Recording** para parar
2. Ajuste **Delay**, **Loops**, **Jitter** ao seu gosto
3. Clique em **Save** e nomeie o profile
4. (Opcional) Clique com o botão direito no profile → **Assign Hotkey** → escolha tecla + modo de disparo
5. (Opcional) Clique com o botão direito no profile → **Set Window Target** para a hotkey funcionar só nesse app
6. Pressione sua hotkey para disparar a macro

## Dicas

- **Jogo não está registrando cliques?** Garanta que o jogo NÃO está rodando como admin, ou ative **Global → Run as Administrator** para o TrueReplayer rodar no mesmo nível de privilégio.
- **Hotkey de profile "não funciona"?** Verifique o **Window Target → Process Name** — o nome real do executável na sua máquina pode ser diferente do configurado. Use a hotkey **Foreground** para capturar o nome certo.
- **Precisa de anti-detecção em clickers?** Ligue **Jitter** (delay) e **Position jitter** no painel Clicker.
- **Sequências longas?** Use **Run Profile** para encadear blocos reutilizáveis em vez de duplicar ações.
