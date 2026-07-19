<div align="center">

<img src="Assets/Square150x150Logo.png" width="104" alt="TrueReplayer" />

# TrueReplayer

**Gravador de macros e ferramenta de automação para Windows.**

Este é o repositório do código-fonte. A documentação e os downloads ficam no repositório público:

📖 **[Documentação](https://github.com/fatalihue/TrueReplayer-releases#readme)** &nbsp;·&nbsp; 📖 **[Documentation (English)](https://github.com/fatalihue/TrueReplayer-releases/blob/main/README.en.md)** &nbsp;·&nbsp; ⬇️ **[Baixar](https://github.com/fatalihue/TrueReplayer-releases/releases/latest)**

[![Latest release](https://img.shields.io/github/v/release/fatalihue/TrueReplayer-releases?style=flat-square&color=60CDFF&label=download)](https://github.com/fatalihue/TrueReplayer-releases/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-9b8cff?style=flat-square)](LICENSE)

</div>

---

## Compilar

App WinUI 3 em **.NET 8** com a interface em **React + TypeScript** rodando dentro de um WebView2.

**Requisitos:** Windows 10 (build 19041) ou 11, [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) e [Node.js](https://nodejs.org) (para compilar o front-end).

```
dotnet publish TrueReplayer.csproj -c Release -p:PublishProfile=Properties/PublishProfiles/win-x64.pubxml
```

Um comando só resolve tudo: ele roda o `npm run build` do front-end quando algum arquivo em `frontend/` mudou, copia o resultado para `wwwroot/` e leva junto a extensão do Chrome e o host de mensagens nativas. O resultado sai em `bin/Release/net8.0-windows10.0.19041.0/win-x64/publish/`.

> **`dotnet build` sozinho não funciona.** Ele falha com *"WindowsAppSDKSelfContained requires a supported Windows architecture"* — o RID `win-x64` vem do publish profile, então use sempre o comando acima. E se o app estiver aberto, o publish falha ao copiar os DLLs (`MSB3021`): feche o app antes.

Para mexer só na interface, `cd frontend && npm run dev` sobe o Vite. Ele abre no navegador comum, fora do WebView2 — sem o processo C# por trás, a ponte com o app fica inativa e as ações reais não rodam, mas é o caminho rápido para ajustar layout e estilo.
