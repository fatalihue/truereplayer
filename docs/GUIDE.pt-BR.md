<div align="center">

# TrueReplayer — Guia do Usuário

[English](GUIDE.md) · **Português (BR)** &nbsp;·&nbsp; [← Voltar ao README](../README.pt-BR.md)

</div>

A referência completa de tudo o que o TrueReplayer pode fazer. Primeira vez por aqui? Comece pelo [Início rápido](../README.pt-BR.md#início-rápido) no README e depois volte para os detalhes.

## Conteúdo

- [Conceitos básicos](#conceitos-básicos)
- [Recording](#recording)
- [Reprodução e configurações de execução](#reprodução-e-configurações-de-execução)
- [A grade de ações](#a-grade-de-ações)
- [Referência de ações](#referência-de-ações)
- [Blocos condicionais (If / Else / EndIf)](#blocos-condicionais-if--else--endif)
- [Perfis e pastas](#perfis-e-pastas)
- [Hotkeys e hotstrings](#hotkeys-e-hotstrings)
- [Alvo de janela e coordenadas relativas](#alvo-de-janela-e-coordenadas-relativas)
- [Clicker mode (auto-clicker)](#clicker-mode-auto-clicker)
- [Game mode](#game-mode)
- [Send Text](#send-text)
- [Automação de navegador](#automação-de-navegador)
- [Temas e aparência](#temas-e-aparência)
- [Referência de configurações](#referência-de-configurações)
- [Onde seus dados ficam](#onde-seus-dados-ficam)
- [Solução de problemas](#solução-de-problemas)

---

## Conceitos básicos

- **Perfil (profile)** — uma única macro: uma lista ordenada de ações mais suas próprias configurações (delays, loops, alvo de janela, etc.). Salvo como um arquivo `.json`.
- **Ação (action)** — um passo dentro de um perfil (um clique, uma tecla, uma pausa, um *If*, …). Mostrado como uma linha na grade.
- **Pasta (folder)** — um grupo organizacional e colorido de perfis. Um perfil fica em no máximo uma pasta.
- **Macro mode vs Clicker mode** — o *Macro mode* grava e reproduz listas de ações; o *Clicker mode* é um auto-clicker dedicado. Alterne com **`ScrollLock`** ou com o botão Macro/Clicker na parte inferior.

---

## Recording

1. Garanta que um perfil esteja ativo (ou inicie um novo).
2. Pressione **`Ctrl+PageUp`** (ou clique em **Recording**). O selo e o botão Recording começam a brilhar para você não perder que a captura está ativa.
3. Faça suas ações — cliques, digitação, rolagem.
4. Pressione **`Ctrl+PageUp`** novamente para parar.

**Onde os novos passos vão parar:** se você tiver linhas **selecionadas**, a gravação insere **antes** da primeira linha selecionada; **sem seleção**, ela **acrescenta** ao final. Limpe a seleção para acrescentar ao final.

### Filtros de captura (Settings → Recording)

| Botão | Efeito |
| --- | --- |
| **Mouse Clicks** | Captura cliques esquerdo / direito / do meio e cliques duplos. |
| **Mouse Scroll** | Captura rolagem da roda do mouse para cima/baixo. |
| **Keyboard** | Captura pressionamentos de teclas e modificadores. |
| **Combined Actions** | **On** → a entrada é mesclada em linhas únicas (ex.: `Ctrl+C` = uma linha *Keystroke*). **Off** → gravado como linhas `KeyDown`/`KeyUp` (e `LeftClickDown`/`LeftClickUp`) separadas — necessário para arrastos ou para segurar uma tecla enquanto faz outras coisas. |

Todos os quatro vêm como **On** por padrão.

---

## Reprodução e configurações de execução

Pressione **`Ctrl+PageDown`** (ou clique em **Replay**) para executar o perfil ativo; pressione novamente ou clique em **Stop** para interromper imediatamente (qualquer botão pressionado é solto). Durante a reprodução, o selo **"Replaying"** e o botão **Stop** pulsam para deixar o estado em execução óbvio, e a barra de status mostra o progresso, o tempo decorrido e o contador de loops.

As configurações de **Execution** (aba Settings → Profile) controlam o tempo:

| Configuração | O que faz | Padrão |
| --- | --- | --- |
| **Delay** | Um atraso fixo (ms) aplicado antes de cada ação, substituindo o tempo gravado. | 100 ms (ligado) |
| **Loops** | Quantas vezes repetir a macro inteira. **0 = infinito.** | 1 |
| **Interval** | Pausa (ms) entre as iterações do loop. | desligado |
| **Jitter** | Variação aleatória de ± % aplicada a cada delay, para que a reprodução não fique perfeitamente regular. | desligado |

---

## A grade de ações

A tabela central lista todas as ações do perfil. Colunas: **caixa de seleção · Action (pílula colorida) · Details · Delay · Notes**.

<p align="center">
  <img src="img/main.png" width="820" alt="A janela principal e a grade de ações do TrueReplayer" /><br>
  <sub><i>Perfis &amp; pastas à esquerda, a grade de ações no centro, configurações à direita.</i></sub>
</p>

- **Selecionar** — clique numa linha (única), `Ctrl+Click` (alternar), `Shift+Click` (intervalo), ou use as caixas de seleção.
- **Editar na própria linha** — clique numa célula para editar **Delay**, **Notes**, **coordenadas** (`x, y` para linhas de mouse — os separadores podem ser vírgula/ponto e vírgula/espaço) ou a **Key** (linhas de teclado capturam a próxima tecla que você pressionar). Confirme com **Enter/Tab**, cancele com **Esc**.
- **Reordenar** — arraste uma linha, ou selecione e pressione **`Alt+↑` / `Alt+↓`**.
- **Clique com o botão direito** numa linha para **Duplicate, Delete, Edit, Insert Else** (dentro de um bloco If) e mais.
- **Pular** — desmarcar uma linha a mantém na lista, mas ela não roda durante a reprodução.
- **Barra em massa** — quando várias linhas estão selecionadas, aparece uma barra com **Set delay**, **Set X / Set Y** (um deslocamento `+10` / `-5` ajusta cada uma; um número simples define todas), **Set notes**, **Move ↑/↓**, **Skip**, **Delete**.
- **Painel Sheet** — clique com o botão direito → Edit (ou abra o Sheet) para um formulário completo com todos os campos da linha selecionada.

> **Observação:** linhas estruturais (*If / Else / EndIf*) não têm delay — a célula Delay delas fica em branco e não é editável, e um "set delay" em massa as ignora. A pausa de um bloco pertence à ação *dentro* dele.

---

## Referência de ações

| Ação | O que faz |
| --- | --- |
| **Left / Right / Middle Click** | Um único clique daquele botão em `(x, y)`. |
| **Double Click** | Dois cliques esquerdos no mesmo ponto, cronometrados abaixo do limiar de clique duplo do sistema para que os aplicativos os tratem como um clique duplo real. |
| **Keystroke** | Pressiona uma tecla ou combinação uma vez — ou **N vezes** com um intervalo configurável. |
| **Hold Key** | Mantém uma única tecla pressionada por uma duração definida (padrão 1000 ms). Modificadores são descartados. |
| **Key Down / Key Up** | Um pressionamento ou liberação isolado — para holds e arrastos em que o down/up precisa ser separado. |
| **Scroll Up / Down** | Um entalhe da roda do mouse na posição do cursor. |
| **Send Text** | Injeta texto (com tokens, snippets, transformações de clipboard) — veja [Send Text](#send-text). |
| **Pause** | Interrompe até que uma **hotkey de retomada** seja pressionada ou um **timeout** expire (o que vier primeiro). Precisa de pelo menos um dos dois. |
| **Wait Image** | Bloqueia até que uma imagem de referência apareça na tela (opcionalmente dentro de uma região de busca recortada; confiança padrão ≈ 85%). |
| **Wait Pixel Color** | Bloqueia até que o pixel em `(x, y)` corresponda a uma cor hex alvo (dentro da tolerância). |
| **Run Profile** | Executa outro perfil como um subpasso — opcionalmente um número definido de vezes. Ciclos e cadeias com mais de 5 níveis de profundidade são bloqueados automaticamente. |
| **If / Else / EndIf** | Ramificação condicional — veja [Blocos condicionais](#blocos-condicionais-if--else--endif). |
| **Browser actions** | Click / Type / Navigate / Wait element / Select option no Chrome — veja [Automação de navegador](#automação-de-navegador). |

Insira ações pela **barra de ferramentas** (Send Keystroke, Send Text, Pause, Wait, Conditional, Browser, Run Profile) ou pela **paleta de comandos** (`Ctrl+K`). A maioria das ações abre um pequeno diálogo para configurá-las; clique na célula Details de uma ação depois para editá-la.

---

## Blocos condicionais (If / Else / EndIf)

Faça uma macro reagir ao que está na tela.

<p align="center">
  <img src="img/conditionals.png" width="820" alt="Dois blocos If/Else/EndIf na grade de ações" /><br>
  <sub><i>Uma verificação de pixel negada (<code>if NOT</code>) e uma verificação de imagem com ramo <code>else</code>.</i></sub>
</p>

- Um **If** executa uma **sondagem**: *Image Found* (esta imagem está visível?) ou *Pixel Color Match* (este pixel corresponde a esta cor?).
- Se a sondagem for **verdadeira**, as ações entre **If** e **Else/EndIf** rodam; se **falsa**, a execução salta para a ramificação **Else** (se houver) ou para depois do **EndIf**.
- **Negate (IFNOT)** inverte o teste — a ramificação *verdadeira* roda quando a sondagem **falha**.
- Blocos podem ser **aninhados**. Adicione um **Else** pelo *Insert Else* da linha. A estrutura é validada e reparada automaticamente ao carregar (marcadores órfãos removidos, `EndIf` ausente adicionado).

**Mover ações para dentro e para fora de um bloco:**
- Arraste uma **única** ação do corpo livremente **para dentro ou para fora** de um bloco.
- Um arrasto de **múltiplas linhas**, ou arrastar o próprio **If**, move o **bloco inteiro** junto (para que os marcadores não fiquem órfãos).
- Você também pode tirar uma linha passo a passo com **`Alt+↑` / `Alt+↓`**.

---

## Perfis e pastas

- **New / Save / Rename / Duplicate / Delete** pelo painel Profiles (à esquerda) ou pela paleta de comandos.
- **Fixe (Pin)** um perfil para mantê-lo no topo; **arraste-o** para dentro de uma **pasta** para agrupá-lo.
- **Pastas** — crie, renomeie, recolora, recolha. Uma pasta pode conter um **alvo de janela** padrão que seus perfis herdam.
- **Informações do perfil** — dê ao perfil um **ícone emoji**, uma **descrição** e **tags** (clique com o botão direito → Info). As tags são pesquisáveis.
- **Pesquisa** filtra a lista por nome ou tag.
- **Import / Export** — exporte os perfis selecionados para um arquivo `.trprofile` (ações + metadados + imagens de referência + layout opcional de pasta/pin). A importação mostra uma tela de resolução de conflitos para choques de nome e um aviso de segurança se o arquivo contiver ações de disparo automático.

---

## Hotkeys e hotstrings

Vincule um perfil a um gatilho para que ele rode sem abrir o aplicativo.

<p align="center">
  <img src="img/hotkey.png" width="320" alt="O diálogo Assign Hotkey com os modos de gatilho" /><br>
  <sub><i>Capture uma combinação de teclas e escolha um modo de gatilho.</i></sub>
</p>

- **Hotkey** — clique com o botão direito num perfil → **Assign hotkey**, pressione a combinação (ex.: `Ctrl+Alt+F1`), escolha um modo de gatilho. Dispara globalmente.
- **Hotstring** — atribua uma sequência digitada (ex.: `qqsig`); ao terminar de digitá-la, o perfil roda.
- **Chave-mestra** — `Pause` (ou Settings → Recording → **Profile Keys**) ativa/desativa **todas** as hotkeys e hotstrings de uma vez.

### Modos de gatilho

| Modo | Comportamento |
| --- | --- |
| **On Press** | Dispara uma vez quando a tecla é pressionada. |
| **On Release** | Dispara uma vez quando a tecla é solta (o pressionamento é absorvido enquanto segurada). |
| **While Pressed** | Repete a macro continuamente enquanto pressionada; para ao soltar (autofire). |
| **Toggle** | O primeiro pressionamento inicia (respeitando os loops do perfil); o segundo para. |

> Os modos de gatilho se aplicam apenas às **hotkeys**. As **hotstrings** sempre disparam quando digitadas.

---

## Alvo de janela e coordenadas relativas

Vincule um perfil (ou uma pasta inteira) a uma janela de aplicativo específica.

<p align="center">
  <img src="img/target.png" width="360" alt="O diálogo Target Configuration" /><br>
  <sub><i>Corresponda a uma janela por processo / título, com coordenadas relativas e opções de restauração.</i></sub>
</p>

- **Alvo de janela (window target)** — defina um nome de processo e/ou título de janela (correspondência por *contains* ou *regex*). A **hotkey do perfil só dispara quando aquela janela está em primeiro plano**. Use **Detect window** para clicar numa janela e preencher os campos automaticamente, e **Test** para verificar a correspondência.
- **Coordenadas relativas** — armazene os cliques relativos ao canto superior esquerdo da janela em vez da tela, para que a macro continue acertando o ponto certo quando a janela se mover ou for redimensionada. Use **Convert to Relative / Absolute** para migrar as coordenadas de uma macro existente.
- **Bring to focus** — restaura + traz a janela para frente antes da reprodução.
- **Restore position / size** — encaixa a janela de volta numa geometria salva primeiro (use **Update window** para capturar a atual).

> Se um perfil usa coordenadas relativas e sua janela alvo não é encontrada no momento da reprodução, a reprodução para com um erro (em vez de clicar no lugar errado).

---

## Clicker mode (auto-clicker)

Mude para **Clicker** com **`ScrollLock`** (ou o botão Macro/Clicker). O painel Profile troca para as configurações do clicker:

| Configuração | O que faz | Padrão |
| --- | --- | --- |
| **Button** | Left / Right / Middle. | Left |
| **Rate** | Velocidade do clique, como um delay (ms) ou cliques/segundo. | 100 ms (10/s) |
| **Loops** | Número de cliques. **0 = infinito.** | 0 |
| **Interval** | Pausa entre as iterações do loop. | desligado |
| **Jitter** | Variação aleatória de ± % no delay. | desligado |
| **Position** | Aleatoriza ligeiramente a posição do clique. | desligado |
| **Area** | Arraste um retângulo para clicar em pontos aleatórios dentro dele (mutuamente exclusivo com o Position jitter). | desligado |

Inicie/pare com **`PageDown`**, pause/retome com **`PageUp`**. Enquanto roda, o **painel ao vivo** mostra a contagem de cliques, a taxa, o tempo decorrido, o progresso dos loops e o ETA.

<p align="center">
  <img src="img/clicker.png" width="820" alt="O painel do Clicker enquanto roda" /><br>
  <sub><i>Contagem ao vivo, taxa, tempo decorrido, progresso do loop, ETA e uma barra de progresso.</i></sub>
</p>

---

## Game mode

Para jogos (ex.: Roblox) que ignoram um "teleporte" instantâneo do cursor, o *Game mode* faz o movimento parecer humano. Vem **ligado por padrão**; desligue-o para aplicativos normais que não precisam dele.

- **Smooth movement** — leva o cursor até o alvo em pequenos passos (ajuste **Path step** px, **Step delay**, **Click delay**). Padrões: 20 px / 2 ms / 10 ms.
- **Fast approach** — para movimentos longos, teleporta invisivelmente até a **Settle distance** (padrão 80 px) do alvo e depois percorre o trecho final a pé — assim os cliques distantes continuam rápidos.
- **Focus-click** *(por ação)* — alguns alvos minúsculos (um pequeno campo de texto do Roblox) só recebem foco do teclado num *segundo* clique. Ative **Focus click** numa linha de clique (botão direito) e ela clica duas vezes a alguns pixels de distância. **Use-o apenas em campos de texto pequenos, nunca em botões** (um botão dispararia duas vezes).

---

## Send Text

O editor **Insert Text** compõe o texto que é injetado via colagem do clipboard (para que layouts e caracteres especiais sobrevivam).

<p align="center">
  <img src="img/sendtext.png" width="820" alt="O editor Send Text com chips de token e uma paleta de teclas/clipboard" /><br>
  <sub><i>Chips de token editáveis inline, com uma paleta de teclas &amp; clipboard ao lado.</i></sub>
</p>

- **Tokens** — incorpore teclas e valores especiais: `{enter}`, `{tab}`, `{space}`, setas e outras teclas; `{date}` / `{time}` / `{datetime}`; `{delay:500}` para pausar no meio do texto. Teclas repetíveis aceitam uma contagem: `{enter:3}`.
- **Clipboard** — `{clipboard}` insere o clipboard atual; `{clipboard:upper}`, `{clipboard:trim}`, `{clipboard:line:1}` etc. o transformam (trim → extrair → limitar → ordem de caixa). Seu clipboard real é restaurado depois.
- **Chips de token** — cada token aparece como um chip editável; clique nele para ajustar seus parâmetros.
- **Snippets** — salve texto reutilizável sob um nome para inserção rápida depois.
- Confirme com **`Ctrl+Enter`**; `Esc` cancela.

---

## Automação de navegador

Controle o Google Chrome por **seletor CSS** em vez de coordenadas de tela — robusto contra mudanças de layout. Requer que a **extensão TrueReplayer para Chrome** esteja conectada (os itens de menu do navegador ficam desabilitados até que esteja).

| Ação | O que faz |
| --- | --- |
| **Browser Click / Right Click** | Clica num elemento por seletor — ou pelo **texto** visível (Exact / Contains / Regex). |
| **Browser Type** | Digita num campo, com o mesmo suporte a token/clipboard do Send Text, além de *paste vs type* e um delay por caractere. |
| **Navigate** | Abre uma URL; opcionalmente espera até que a URL corresponda a um padrão e/ou um elemento apareça. |
| **Wait Element** | Pausa até que um elemento apareça (ou desapareça). |
| **Select Option** | Escolhe uma opção num `<select>` nativo por texto, valor ou índice. |

Um selo de **qualidade do seletor** (S → C) indica quão estável cada seletor capturado provavelmente será.

---

## Temas e aparência

Abra o **Theme Editor** em Settings → Global → Appearance → *Customise* (ou `Ctrl+K` → Theme editor).

<p align="center">
  <img src="img/theme.png" width="820" alt="A aba de presets do Theme Editor com um preview ao vivo" /><br>
  <sub><i>Mais de 40 presets, com um preview ao vivo que se atualiza enquanto você edita.</i></sub>
</p>

- **Presets** — mais de 40 temas selecionados agrupados por matiz; clique para aplicar. O padrão é *Lavender Coal* (escuro).
- **Cores** — ajuste finamente todas as 15 cores do tema via seletor, hex ou HSL; um verificador de contraste sinaliza texto com baixo contraste.
- **Aparência** — ajuste **tamanho da fonte, raio de borda, altura da linha, zoom**, as cores das pílulas por ação e uma troca automática opcional **match-system (dark/light)**.
- **Import / Export** — compartilhe um tema como JSON.
- **Animações** — um botão mestre para desativar transições (acessibilidade / hardware modesto).

---

## Referência de configurações

O painel Settings (lado direito) tem duas abas; tudo é **salvo automaticamente** (sem botão Save). Recolha-o para uma fina barra de ícones para recuperar espaço.

**Aba Profile** (por perfil / modo):
- **Execution** — Delay, Loops, Interval, Jitter (Macro mode).
- **Game Mode** — Smooth movement + Fast approach (e seus ajustes).
- **Recording** — os filtros de captura + chave-mestra **Profile Keys** + captura de seletor do Browser.
- **Clicker** — substitui Execution/Recording enquanto no Clicker mode.

**Aba Global** (em todo o aplicativo):
- **Hotkeys** — Recording, Replay, alternância de modo, Foreground e as hotkeys do Clicker. Padrões: Record `Ctrl+PageUp`, Replay `Ctrl+PageDown`, Modo `ScrollLock`, Profile-keys `Pause`, Foreground `Insert`, início do Clicker `PageDown`, pausa do Clicker `PageUp`.
- **Window** — Always on top, Minimize to tray, Run on startup, Start minimized, Run as administrator.
- **Appearance** — abre o Theme Editor.
- **Language** — idioma das tooltips: **Português (BR)** (padrão) ou English. Nomes e menus permanecem em inglês; apenas as tooltips são localizadas.
- **Updates** — "check for updates" manual (também verifica automaticamente ao iniciar).

---

## Onde seus dados ficam

- **Perfis:** `Documents\TrueReplayer\Profiles\*.json`
- **Configurações do app:** `appsettings.json` sob os dados locais do aplicativo.
- **Imagens de referência, temas, dados do WebView2:** `%LocalAppData%\TrueReplayer\…` — fixados aqui para que **sobrevivam às atualizações automáticas**.

---

## Solução de problemas

**Uma hotkey / reprodução não dispara.**
Verifique: o **alvo de janela** do perfil corresponde ao aplicativo em primeiro plano; a chave-mestra **Profile Keys** (`Pause`) está ligada; o perfil não está **desabilitado**; e (para aplicativos alvo elevados) que o TrueReplayer roda **como administrador** (Settings → Global → Window).

**Os cliques caem no lugar errado depois que a janela se moveu.**
Ative um **alvo de janela** + **coordenadas relativas** para aquele perfil e depois faça **Convert to Relative**.

**Os cliques disparam duas vezes.**
O **Focus-click** está ativado nessas linhas (um ícone de foco aparece na pílula). Desligue-o, a menos que o alvo seja um campo de texto pequeno que precise dele; nunca o use em botões.

**Um jogo ignora os cliques.**
Mantenha o **Game mode** ligado (smooth movement). Se um jogo específico ainda errar o clique, tente desligar o **Fast approach** ou reduzir o **Path step** px.

**A interface não carrega.**
Instale o [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) — o aplicativo o solicita na primeira execução se estiver faltando.

---

<div align="center">

[← Voltar ao README](../README.pt-BR.md) &nbsp;·&nbsp; [English](GUIDE.md)

</div>
