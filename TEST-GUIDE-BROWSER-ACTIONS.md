# TrueReplayer — Guia Rápido de Teste: Browser Actions

Guia prático de **onde** (sites públicos estáveis) e **como** testar cada browser action.
Cobre também os recursos transversais (gravação, Pick, Text Match, chips do Type Text)
e o fix do `selectMatchMode` (extensão 1.4.3).

**Legenda:** `[ ]` a fazer · marque `[x]` quando passar · **Passa se:** = critério objetivo.

---

## Setup (uma vez)

- [ ] Rode a build de teste — **TrueReplayer (teste)**.
- [ ] Atualize a extensão para **1.4.4**: `chrome://extensions` → **Modo do desenvolvedor** →
      **Carregar sem compactação** → pasta `ChromeExtension` do repositório.
      (Se já estava carregada unpacked, basta clicar em **↻ Atualizar**.)
- **Passa se:** badge da extensão = **ON** (verde) e o app **não** mostra banner de
  extensão desatualizada. Banner laranja `!` = versão antiga ainda carregada.

> Todos os comandos executam na **aba ativa** do Chrome. Durante o replay, não troque de aba.

### Sites de teste usados no guia
| Site | Serve para |
|---|---|
| `https://the-internet.herokuapp.com` | login, dropdown, waits dinâmicos, context menu |
| `https://httpbin.org/forms/post` | formulário nativo com `<select>` e inputs variados |

---

## 1. Open URL (`BrowserNavigate`)

- [ ] Insira **Open URL** → `the-internet.herokuapp.com/login` (sem `https://` — deve completar sozinho). Replay.
- **Passa se:** página carrega e a ação só conclui **após** o load (não dispara a próxima ação no meio do carregamento).
- [ ] Marque **Open in new tab** e replay de novo.
- **Passa se:** abre nova aba e ela vira a ativa.
- [ ] No editor, preencha **URL PATTERN** = `*/login*`. Replay → passa. Troque para `*/dashboard*` → replay.
- **Passa se:** com o pattern errado, falha com `NAVIGATION_TIMEOUT` e mensagem mostrando a URL atual.
- [ ] Preencha **WAIT ELEMENT** = `#username`. Replay.
- **Passa se:** conclui normal (o campo existe). Com `#nao-existe`, falha com `ELEMENT_NOT_FOUND`.

## 2. Click Element (`BrowserClick`)

Em `the-internet.herokuapp.com/login`:
- [ ] Insira **Click Element**, use o **crosshair (Pick)** e clique no botão **Login**.
- **Passa se:** o seletor preenche com tier indicado (S/A/B/C) e a lista de **alternativas** abre ao clicar no tier.
- [ ] **Test action** no editor.
- **Passa se:** highlight azul → verde pisca no botão da página e o resultado dá sucesso.
- [ ] Apague o seletor e use **TEXT MATCH** = modo `Exact`, valor `Login`. Test action.
- **Passa se:** encontra o botão por texto (sem CSS).
- [ ] Teste de erro: seletor `#nao-existe`, timeout 3000. Replay.
- **Passa se:** erro amigável `ELEMENT_NOT_FOUND` com dica (tip), highlight vermelho não aparece (elemento nunca existiu).

## 3. Right Click Element (`BrowserRightClick`)

Em `the-internet.herokuapp.com/context_menu`:
- [ ] Insira **Right Click Element** com Pick no quadrado pontilhado (`#hot-spot`). Replay.
- **Passa se:** o site dispara o `alert("You selected a context menu")` — prova de que o evento `contextmenu` chegou.

## 4. Type Text (`BrowserType`)

Em `the-internet.herokuapp.com/login`:
- [ ] Insira **Type Text** no campo `#username` com texto: `tomsmith{Tab}SuperSecretPassword!{Enter}`
      (chips **Tab** e **Enter** estão na 1ª linha da paleta).
- **Passa se:** usuário digitado, **Tab** move o foco para a senha, senha digitada, **Enter** submete → página "You logged into a secure area!".
- [ ] Chips de dados: novo Type Text em `#username` com `{Date} {Time} {DateTime}` (2ª linha da paleta). Test action.
- **Passa se:** valores reais no formato `dd/MM/yyyy` / `HH:mm:ss` aparecem no campo.
- [ ] Chip **Clipboard**: copie um texto qualquer (Ctrl+C), Type Text com `{Clipboard}`. Test action.
- **Passa se:** o conteúdo do clipboard é digitado.
- [ ] Chips raros: clique no chip **⋯** da paleta.
- **Passa se:** expande linha com Escape/Backspace/Delete/setas; clicar de novo recolhe. Digite `abc{Backspace}` num campo → resultado `ab`.
- [ ] **Keep existing text**: rode o mesmo Type Text 2× com a opção marcada.
- **Passa se:** o texto **acumula**. Desmarcada: o campo é **limpo** antes de digitar.
- [ ] **Paste**: marque Paste com um texto longo (200+ chars). Test action.
- **Passa se:** entra instantâneo (sem digitação char a char). Char delay fica desabilitado.
- [ ] **Char delay** = 100. Test action.
- **Passa se:** digitação visivelmente lenta, char por char.

## 5. Select Option (`BrowserSelectOption`) — inclui o fix 1.4.3

Em `the-internet.herokuapp.com/dropdown`:
- [ ] Insira **Select Option**, Pick no `<select>` (`#dropdown`). **MATCH BY = Text**, OPTION = `Option 2`. Test action.
- **Passa se:** dropdown muda para Option 2.
- [ ] **MATCH BY = Value**, OPTION = `1`. Test action.
- **Passa se:** seleciona **Option 1** (value="1"). ⚠️ **Este é o fix do P0** — na extensão 1.4.2 isso caía silenciosamente em match por texto e falhava com `OPTION_NOT_FOUND` (não há option com texto "1").
- [ ] **MATCH BY = Index**, OPTION = `2`. Test action.
- **Passa se:** seleciona **Option 2** (índice 0 = "Please select an option").
- [ ] Erro: OPTION = `Banana`, Match by Text.
- **Passa se:** `OPTION_NOT_FOUND` com dica citando o match mode.
- [ ] Erro de tipo: aponte o seletor para um botão qualquer.
- **Passa se:** `NOT_A_SELECT` sugerindo usar **Click Element** para dropdowns custom.

## 6. Wait Element (`BrowserWaitElement`) — 4 modos

- [ ] **Appears**: em `the-internet.herokuapp.com/dynamic_loading/1` —
      macro: Click Element no botão **Start** → Wait Element `#finish` (modo Appears, timeout 15000) → replay.
- **Passa se:** espera os ~5s do loading e conclui quando "Hello World!" aparece.
- [ ] **Disappears**: mesma página — Click Element em **Start** → Wait Element `#loading` modo **Disappears**.
- **Passa se:** conclui exatamente quando o spinner some.
- [ ] **Enabled**: em `the-internet.herokuapp.com/dynamic_controls` —
      Click Element no botão **Enable** → Wait Element `input[type="text"]` modo **Enabled**.
- **Passa se:** espera o input sair de disabled e conclui.
- [ ] **Text matches**: em `/dynamic_loading/1` — Wait Element `#finish` modo **Text matches**, TEXT MATCH = `Hello World!` (após clicar Start).
- **Passa se:** conclui quando o texto bate. ⚠️ Deixar TEXT MATCH vazio nesse modo mostra o aviso amarelo no editor.

## 7. Gravação (record mode) — requer extensão **1.4.4**

Em `httpbin.org/forms/post`, com o app conectado, inicie a **gravação**:
- [ ] Passe o mouse sobre elementos.
- **Passa se:** highlight azul acompanha o hover; clique pisca verde.
- [ ] Clique no campo **Customer name** e digite um nome; clique em outro lugar da página.
- **Passa se:** o clique no campo gera **uma** ação **Type Text** (campo de input não gera
  Click Element — o replay foca o campo sozinho); ao sair do campo, o texto digitado
  preenche essa ação; **nenhuma** tecla nativa (Keystroke/KeyDown) da digitação fica na
  grade. O clique final fora do campo gera um **Click Element** normal (esperado).
- [ ] Ainda gravando, navegue até `the-internet.herokuapp.com/dropdown` (pode usar a
  barra de endereço) e mude o valor do `<select>`.
- **Passa se:** a gravação **continua na página nova** (highlight de hover presente) e a
  mudança gera **uma** ação **Select Option** (sem Click Element/LeftClick órfão do
  clique que abriu o dropdown).
- [ ] Abra o dropdown e **cancele** sem escolher — teste os dois jeitos: **Esc** e
  **clique fora**.
- **Passa se:** nenhuma ação sobra na grade (nem LeftClickDown órfão, nem Keystroke
  Esc) e os cliques seguintes voltam a gravar normalmente, sem esperar timeout.

## 8. Nomes / UI (sanity pós-rename)

- [ ] Toolbar → ícone 🌐: menu lista **Click Element, Right Click Element, Type Text, Select Option, Wait Element, Open URL**.
- [ ] Pills da grade e header do painel de edição usam os mesmos nomes (sem "Input Text"/"Wait" ambíguo).
- [ ] Mensagem de timeout cita o nome novo (ex.: "Click Element timed out after 5s").

---

## Limitações conhecidas (não são bugs — não reportar)

- **iframes**: elementos dentro de iframes não são gravados; replay neles não é confiável.
- **Shadow DOM**: sites com web components (seletores dentro de shadow root) falham com `ELEMENT_NOT_FOUND`.
- **Aba ativa**: trocar de aba no meio do replay direciona as ações para a aba errada.
- **Select custom** (React-Select, Select2, MUI): usar **Click Element** nas partes do dropdown, não Select Option.
