# PKG Sender

Instale e gerencie pacotes de PS4 pela rede local com o **GoldHEN**, a partir do Windows ou do Linux.
Nenhum app instalador precisa estar aberto no console.

[English](README.md)

## Recursos

- **Biblioteca no PC**: adicione quantas pastas quiser (com subpastas) e veja cada PKG com capa, título, versão e tipo (jogo, atualização, DLC ou app/homebrew).
- **Instalação em um clique**: o PKG Sender serve o arquivo pela rede e o PS4 baixa em segundo plano, com progresso, velocidade e tempo restante. Os pacotes entram numa fila e instalam um depois do outro.
- **Aba do console**: lista os jogos e apps instalados no PS4, com versão, atualização, quantidade de DLCs e espaço ocupado.
- **Excluir do PS4**: remova um jogo, ou só a atualização, pelo desinstalador do sistema. Os dados salvos ficam.
- **Encontra o seu PS4** na rede sozinho, ou você digita o IP.
- **Português (Brasil), English e Español**, seguindo o idioma do sistema por padrão.

## Requisitos

- PS4 com o **GoldHEN** carregado, com estas opções ativadas em _Configurações > GoldHEN > Server Settings_:
  - **servidor FTP** (porta 2121), para ler o que está instalado;
  - **servidor BinLoader** (porta 9090), para instalar e excluir.
- PC e PS4 na mesma rede local.

## Instalação

Baixe a versão mais recente:

| Sistema | Arquivo                                                                  |
| ------- | ------------------------------------------------------------------------ |
| Windows | `PKG Sender-Setup-x.y.z.exe` (instalador) ou `-Portable-` (sem instalar) |
| Linux   | `pkg-sender-x.y.z-x86_64.AppImage` ou `pkg-sender-x.y.z-amd64.deb`       |

Na primeira vez, o PKG Sender procura o seu PS4. Se o firewall perguntar, permita o acesso em **redes privadas**: o console baixa os pacotes do seu PC.

## Como funciona

- **Instalar**: o PKG Sender envia um pequeno payload ao BinLoader do GoldHEN. Ele registra o download no serviço de downloads do próprio PS4, apontando para o servidor de arquivos do PKG Sender, e o console baixa o PKG direto do seu PC.
- **Excluir**: outro payload chama o desinstalador do sistema e devolve o resultado.
- **Lista do console**: lida pelo servidor FTP do GoldHEN.

Os payloads ficam em [`payloads/`](payloads/README.md), com o código-fonte e o script de build.

## Desenvolvimento

Requer Node.js 22.12 ou mais novo.

```sh
npm install
npm run dev          # roda com recarga automática
npm test             # testes (vitest)
npm run lint         # ESLint
npm run typecheck    # TypeScript
npm run dist:win     # instalador e versão portátil para Windows (dist/)
npm run dist:linux   # AppImage e .deb (dist/, rodar no Linux)
npm run payloads     # recompila os payloads (Linux/WSL, veja payloads/README.md)
```

A organização do código e o guia para contribuir estão no [README em inglês](README.md) e no [CONTRIBUTING.md](CONTRIBUTING.md).

## Créditos

- Payload de instalação: [DirectPackageInstaller](https://github.com/marcussacana/DirectPackageInstaller), de marcussacana (GPL-3.0).
- Nomes das funções do desinstalador conforme o [Itemzflow](https://github.com/LightningMods/Itemzflow) (GPL-3.0).
- [GoldHEN](https://github.com/GoldHEN/GoldHEN), de SiSTR0 e colaboradores.

## Licença

[GPL-3.0](LICENSE). O PKG Sender não tem vínculo com a Sony Interactive Entertainment. Use apenas com conteúdo ao qual você tem direito.
