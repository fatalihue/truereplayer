# Política de segurança

*[English below](#english)*

## Versões cobertas

O TrueReplayer se atualiza sozinho e só a **última versão publicada** recebe correções. Antes de reportar, confirme que está na versão mais recente em [Releases](https://github.com/fatalihue/TrueReplayer-releases/releases/latest).

## Como reportar

**Não abra uma issue pública com os detalhes.** Use o canal privado do GitHub: aba **Security** deste repositório → **Report a vulnerability**.

Se esse botão não estiver disponível, abra uma issue curta pedindo um canal privado de contato — **sem** incluir detalhes técnicos, prova de conceito ou passos de reprodução.

Ajuda muito ter: a versão do app, o Windows usado, o que a falha permite fazer na prática, e o passo a passo para reproduzir. Retorno em até 7 dias. Este é um projeto mantido por uma pessoa só, no tempo livre — não há recompensa financeira, mas o crédito é seu se quiser.

## O que o app acessa, e por quê

O TrueReplayer é uma ferramenta de automação: ele precisa de permissões que, fora de contexto, parecem invasivas. Vale ser explícito sobre o que ele faz e o que ele **não** faz.

| Acesso | Para quê |
| --- | --- |
| **Hooks globais de teclado e mouse** (`WH_KEYBOARD_LL` / `WH_MOUSE_LL`) | Gravar suas ações e ouvir as hotkeys mesmo com outro app em primeiro plano. É como o app enxerga o que você faz — e é a permissão mais sensível que ele usa. |
| **Simulação de entrada** | Reproduzir as macros. Cliques e teclas são injetados no sistema como se viessem do hardware. |
| **Área de transferência** (leitura e escrita) | Tokens como `{clipboard}`, a ação **Copy to Slot** e a injeção de texto formatado. O conteúdo original é restaurado depois da colagem. |
| **Captura de tela** | Comparar imagens de referência (**Wait Image**) e ler a cor de um pixel (**Wait Pixel Color**). |
| **Atualização automática** | Baixa e instala versões novas via [Velopack](https://velopack.io), do repositório público de releases. |
| **Extensão do Chrome + host de mensagens nativas** | As ações de navegador. A comunicação é local, por named pipe, entre a extensão e o app na mesma máquina. |
| **Executar como administrador** (opcional, desligado por padrão) | Só necessário para automatizar apps que rodam elevados — sem isso, o Windows bloqueia a entrada simulada nessas janelas. |

**Onde ficam seus dados.** Perfis em `Documentos\TrueReplayer\Profiles`, imagens de referência e configurações em `%LocalAppData%\TrueReplayer`. Tudo local. O app **não** envia telemetria, não faz upload de macros e a única conexão de rede que ele abre por conta própria é a checagem de atualização no GitHub.

## Fora de escopo

Não são vulnerabilidades:

- **O app simula entrada e lê a tela.** É a função dele. Um relato de que "o TrueReplayer consegue digitar em outros programas" descreve o produto.
- **Macros fazem o que você mandou.** Um perfil pode digitar qualquer coisa, inclusive uma senha que você mesmo colocou nele — perfis são arquivos de texto sem criptografia. Trate um `.trprofile` recebido de terceiros como você trataria um script: leia antes de rodar. O app avisa na importação quando o arquivo contém ações que disparam sozinhas.
- **A chave `key` no manifest da extensão.** É uma chave RSA **pública**, usada para fixar o ID da extensão. Ela é pública por definição.
- Achados de scanner sem impacto demonstrável.

O que **é** de interesse: escalonamento de privilégio, execução de código a partir de um perfil ou tema importado, qualquer coisa que permita a um app de terceiros usar o hook ou a ponte nativa do TrueReplayer, e falhas no canal de atualização.

---

<a name="english"></a>

## English

**Supported versions.** TrueReplayer auto-updates; only the [latest release](https://github.com/fatalihue/TrueReplayer-releases/releases/latest) is fixed.

**Reporting.** Please don't open a public issue with details. Use this repository's **Security** tab → **Report a vulnerability**. If that button isn't there, open a short issue asking for a private channel — no technical detail, no proof of concept. Reports in English are welcome. Expect a reply within 7 days; this is a one-person hobby project, so there's no bounty, but credit is yours if you want it.

**What the app accesses.** Global low-level keyboard/mouse hooks (recording and hotkeys), simulated input (replay), clipboard read/write (text tokens and clipboard slots — the original contents are restored), screen capture (image and pixel matching), auto-update via Velopack from the public releases repo, and a local named pipe to the companion Chrome extension. Optionally runs elevated, off by default, only needed to automate elevated apps. Everything stays on the machine: profiles in `Documents\TrueReplayer\Profiles`, settings and reference images in `%LocalAppData%\TrueReplayer`. No telemetry, no macro upload.

**Out of scope.** That the app simulates input and reads the screen — that is the product. That a macro does what it was told, including typing a password someone put in it: profiles are plain text, so treat a `.trprofile` from a stranger like any other script and read it first (the importer warns when a file contains self-firing actions). The extension manifest `key` is an RSA *public* key that pins the extension ID. Scanner output with no demonstrated impact.

**In scope:** privilege escalation, code execution from an imported profile or theme, anything letting a third-party app ride the input hook or the native bridge, and weaknesses in the update channel.
