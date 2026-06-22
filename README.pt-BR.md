<div align="center">

<img src="assets/Square150x150Logo.png" width="104" alt="TrueReplayer logo" />

# TrueReplayer

**Grave o que você faz. Reproduza quando quiser — sob demanda ou com um atalho.**

Um gravador de macros e ferramenta de automação rápido e leve **para Windows**. Capture seus cliques de mouse, pressionamentos de tecla e rolagens, depois reproduza tudo perfeitamente — ou vá além com esperas, condições, injeção de texto, um auto-clicker embutido e entrada que os jogos de verdade realmente aceitam.

[![Latest release](https://img.shields.io/github/v/release/fatalihue/TrueReplayer-releases?style=flat-square&color=60CDFF&label=download)](https://github.com/fatalihue/TrueReplayer-releases/releases/latest)
[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%2F%2011%20(x64)-0078D4?style=flat-square&logo=windows)](https://github.com/fatalihue/TrueReplayer-releases/releases/latest)
![Built with .NET 8 + React](https://img.shields.io/badge/built%20with-.NET%208%20%C2%B7%20React-6bcb77?style=flat-square)
[![License: MIT](https://img.shields.io/badge/license-MIT-9b8cff?style=flat-square)](LICENSE)

[English](README.md) · **Português (BR)**

</div>

---

## Conteúdo

- [O que é o TrueReplayer?](#o-que-é-o-truereplayer)
- [Recursos](#recursos)
- [Download e instalação](#download-e-instalação)
- [Início rápido](#início-rápido)
- [Atalhos de teclado](#atalhos-de-teclado)
- [Guia completo](#guia-completo)
- [Perguntas frequentes](#perguntas-frequentes)
- [Construído com](#construído-com)
- [Licença](#licença)

---

## O que é o TrueReplayer?

O TrueReplayer grava sua entrada real — cada clique, tecla e rolagem — e reproduz tudo exatamente, quantas vezes você quiser. Vincule uma macro a um **atalho** e ela dispara mesmo enquanto outro aplicativo está em foco. Organize suas macros em **perfis e pastas coloridas** e depois deixe-as inteligentes: adicione pausas, espere por uma imagem ou cor de pixel aparecer, digite texto, execute outra macro ou ramifique com **condições IF**.

Ele envia a entrada da forma que aplicativos e **jogos** reais esperam (testado no Roblox e em outros), roda como um pequeno aplicativo nativo do Windows e **se atualiza** automaticamente.

---

## Recursos

### 🎬 Gravar e reproduzir
- **Gravação com um toque** — pressione **`Ctrl+PageUp`** (ou o botão Recording), faça o que precisa e pressione de novo para parar.
- **Reprodução perfeita** — reproduza com **`Ctrl+PageDown`**, com controle total sobre **delay, loops** (0 = para sempre), **interval** entre loops e **jitter** (variação ± aleatória para não ficar robótico).
- **Filtros de captura** — grave só o que você quer: cliques de mouse, rolagem, teclado — juntos ou separados.
- **Grade de ações editável** — cada passo é uma linha que você pode reordenar (arrastando ou com `Alt+↑/↓`), editar na hora, duplicar, pular ou editar em lote.

### ⌨️ Gatilhos
- **Hotkeys** — vincule qualquer combinação de teclas a um perfil; ela dispara globalmente, mesmo sobre outros aplicativos.
- **Hotstrings** — digite um gatilho de texto curto (ex.: `qqsig`) e uma macro é executada.
- **4 modos de gatilho** — *On Press*, *On Release*, *While Pressed* (disparo automático enquanto segura) e *Toggle* (liga/desliga).

### 🧩 Passos inteligentes — além da gravação simples
- **Pause** — espere por um atalho ou um tempo limite antes de continuar.
- **Wait for Image / Pixel Color** — bloqueie até algo aparecer na tela (ótimo para sincronizar com aplicativos mais lentos).
- **Send Text** — cole texto formatado com tokens como `{enter}`, `{tab}`, `{clipboard}`, datas, snippets salvos e transformações da área de transferência.
- **Run Profile** — chame outra macro como um sub-passo e construa automações modulares e reutilizáveis.
- **Condicionais (If / Else / EndIf)** — ramifique conforme uma imagem é encontrada ou um pixel corresponde; suporta *IFNOT* e aninhamento.
- **Ações de navegador** — controle o Chrome por seletor CSS (Click, Type, Navigate, Wait for element, Select option) por meio da extensão complementar.

### 🖱️ Auto-clicker embutido
Um **Clicker mode** dedicado (alterne com **`ScrollLock`**) para cliques rápidos e constantes: escolha o botão, defina uma taxa (cliques/seg ou delay), adicione jitter aleatório, restrinja a uma região da tela e acompanhe as **estatísticas ao vivo** (contagem, taxa, tempo decorrido, ETA, progresso do loop).

### 🎮 Game mode
- **Smooth movement** — move o cursor ao longo de um caminho em vez de teletransportá-lo, para que jogos (ex.: Roblox) que rejeitam saltos únicos aceitem os cliques.
- **Fast approach** — teletransporta a maior parte do trajeto e só "ajusta" o último trecho suavemente, mantendo os cliques distantes rápidos.
- **Focus-click** — um toque duplo opcional para campos de texto minúsculos que precisam de um segundo clique para receber foco.

### 🎯 Mira de janela
- Vincule um perfil a uma **janela específica** para que seu atalho dispare apenas ali.
- **Coordenadas relativas** — os cliques se ancoram ao canto superior esquerdo da janela, então a macro continua funcionando quando a janela é movida ou redimensionada.
- **Bring to focus / restore position & size** antes da reprodução para execuções reproduzíveis.

### 🎨 Deixe do seu jeito
- **Mais de 40 temas embutidos** mais um **Theme Editor** completo (cores, fontes, altura das linhas, cores por ação; exporte/importe temas como JSON).
- **Perfis e pastas** com ícones, descrições, tags e cores.
- **Tooltips bilíngues** — English ou **Português (BR)** (Settings → Global → Language).
- **Importe / exporte** perfis como arquivos `.trprofile` portáteis (inclui imagens de referência e organização).

---

## Download e instalação

1. Baixe o **`TrueReplayer-win-Setup.exe`** mais recente na **[página de Releases](https://github.com/fatalihue/TrueReplayer-releases/releases/latest)**.
2. Execute-o — instala em segundos e fixa no menu Iniciar.
3. Pronto. O TrueReplayer **verifica atualizações ao iniciar** e se atualiza em segundo plano (atualizações delta, normalmente alguns MB).

> **Requisitos:** Windows 10 ou 11 (64 bits). O [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) alimenta a interface — ele já vem com o Windows moderno, e o aplicativo se oferece para instalá-lo caso esteja ausente.

---

## Início rápido

1. **Grave** — pressione **`Ctrl+PageUp`**, execute suas ações e pressione de novo para parar.
2. **Reproduza** — pressione **`Ctrl+PageDown`** (ou clique em **Replay**) para reproduzir.
3. **Salve** — clique em **Save** e dê um nome.
4. **Atribua um atalho** — clique com o botão direito no perfil → **Assign hotkey**, escolha uma combinação e um modo de gatilho. Agora ela é executada sempre que você pressionar.

É tudo o que você precisa. Todo o resto — esperas, condições, o auto-clicker, temas — está lá quando você quiser.

---

## Atalhos de teclado

| Ação | Atalho |
| --- | --- |
| Iniciar / parar **gravação** | `Ctrl+PageUp` |
| Iniciar / parar **reprodução** | `Ctrl+PageDown` |
| Alternar modo **Macro ↔ Clicker** | `ScrollLock` (ou `Ctrl+ScrollLock`) |
| Iniciar / parar o **clicker** | `PageDown` |
| Pausar / retomar o **clicker** | `PageUp` |
| Ativar / desativar **atalhos de perfil** | `Pause` |
| Trazer o aplicativo **para a frente** | `Insert` |
| **Paleta de comandos** | `Ctrl+K` |
| Desfazer / refazer | `Ctrl+Z` / `Ctrl+Y` |
| Salvar perfil | `Ctrl+S` |
| Mover linhas selecionadas para cima / baixo | `Alt+↑` / `Alt+↓` |
| Excluir linhas selecionadas | `Delete` |

> Todos os atalhos (gravar, reproduzir, modo, etc.) são configuráveis em **Settings → Global → Hotkeys**. Os padrões são mostrados acima.

---

## Guia completo

A referência completa — cada tipo de ação, condicionais, o clicker, game mode, mira de janela, tokens do Send Text, automação de navegador, temas e configurações — está no guia:

📖 **[Guia completo em Português](docs/GUIDE.pt-BR.md)** &nbsp;·&nbsp; 📖 **[docs/GUIDE.md (English)](docs/GUIDE.md)**

---

## Perguntas frequentes

**Funciona em jogos?**
Sim — ele envia entrada real via `SendInput`, com *Game mode* opcional (smooth movement) para engines como o Roblox que rejeitam cursores teletransportados. Desligue-o para aplicativos normais que não precisam dele.

**Onde meus perfis ficam armazenados?**
Os perfis são arquivos `.json` em `Documents\TrueReplayer\Profiles`. Configurações do aplicativo, temas, imagens de referência e dados do WebView2 ficam em `%LocalAppData%\TrueReplayer` (isso sobrevive às atualizações).

**Posso compartilhar uma macro?**
Sim — selecione os perfis → **Export** para um arquivo `.trprofile` (ele empacota ações, metadados e imagens de referência). A outra pessoa faz o **Import**, com resolução de conflitos para nomes iguais.

**Meus cliques estão duplicando / disparando duas vezes.**
Verifique se o **Focus-click** está ativado nessas linhas de clique (um pequeno ícone de foco aparece na pílula da ação). É um recurso opcional que clica duas vezes de propósito para dar foco a campos de texto minúsculos — desligue-o (clique direito na linha → *Focus click*) a menos que você precise dele, e nunca o use em botões.

---

## Construído com

- **Host:** WinUI 3 (.NET 8) + WebView2 — um pequeno shell nativo do Windows.
- **UI:** React + TypeScript + Vite + Tailwind, renderizado no WebView2.
- **Engine:** C# / .NET 8 usando APIs de entrada nativas do Windows (`SendInput`, hooks de baixo nível).
- **Atualizações:** [Velopack](https://velopack.io) (atualizações automáticas delta).

Dois repositórios:
- **Código** — [`fatalihue/truereplayer`](https://github.com/fatalihue/truereplayer)
- **Releases** (fonte de atualização automática) — [`fatalihue/TrueReplayer-releases`](https://github.com/fatalihue/TrueReplayer-releases)

---

## Licença

[MIT](LICENSE) © fatalihue
