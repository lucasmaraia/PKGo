# PKG Sender

Envie PKGs do PC para o PS4 pela rede, com uma interface amigável: capa,
título, CUSA, versão e tipo de cada pacote, fila de instalação e progresso
com velocidade e tempo restante.

Usa a mesma API do *PS4 Remote PKG Sender*: o PS4 baixa o arquivo diretamente
deste PC pelo **Remote Package Installer** (porta 12800).

## Requisitos

- Windows com [Node.js](https://nodejs.org) 18 ou mais novo (sem dependências extras).
- PS4 com GoldHEN e o **Remote Package Installer** aberto.
- PC e PS4 na mesma rede.

## Como usar

1. Na primeira vez, dê dois cliques em **`Criar atalho.cmd`**. Ele cria o atalho
   **PKG Sender** na Área de Trabalho e no Menu Iniciar. Depois, abra o app por ele:
   o PKG Sender abre em janela própria, sem barra do navegador e sem janela de console.
   (O `Iniciar.cmd` continua disponível: abre no navegador e mostra o console.)
2. Na primeira vez, informe o IP do PS4 (clique no indicador de status no topo).
3. Clique em **Adicionar pasta** (ou **Adicionar PKG**) e escolha onde estão seus pacotes.
4. No PS4, abra o Remote Package Installer.
5. Clique em **Instalar** no card do jogo. Acompanhe o progresso no topo da tela.

No modo janela, o servidor fecha sozinho cerca de um minuto depois que você fecha
a janela, mas só quando não há instalação em andamento: fechar a janela no meio de
um envio não interrompe o PS4. No modo `Iniciar.cmd`, mantenha a janela preta aberta. Na primeira execução, o Windows pode
pedir permissão de rede para o Node.js: permita em **redes privadas**.

## Recursos

- Aba **No PS4**: lista jogos e apps instalados no console, com capa, versão,
  atualização instalada, quantidade de DLCs e espaço ocupado. Lida pelo FTP do
  GoldHEN (porta 2121), sem precisar do Remote Package Installer.
- **Excluir** jogos ou só a atualização direto da aba **No PS4**. Usa o desinstalador
  do sistema (pelo Remote Package Installer, que precisa estar aberto), mantém os
  dados salvos e confere na lista do console se a exclusão aconteceu de fato.
- Na aba **No PC**, o selo **Instalado** mostra a versão presente no console, e
  atualizações mais novas que a do PS4 aparecem destacadas.
- Lê `param.sfo` e `icon0.png`/`pic1.png` direto do PKG, sem carregar o arquivo inteiro.
- Título em português quando o PKG tiver (`TITLE_17`/`TITLE_07`).
- Filtros por Jogos, Atualizações, DLC e Apps; busca por nome ou CUSA.
- Fila sequencial: adicione vários pacotes e deixe instalando.
- **Sem abrir o Remote Package Installer**: com `payload/dpi.bin` gerado (veja
  `payload/README.md`), quando o app está fechado o PKG Sender instala por um payload
  enviado ao BinLoader do GoldHEN (porta 9090). Com `payload/uninstall.bin`, a exclusão de jogos
  e atualizações também funciona assim.
- Escolhe automaticamente o endereço do PC na mesma rede do PS4 e ignora adaptadores virtuais (WSL, Hyper-V, VPN).

## Configuração

Fica em `config.json` (criado automaticamente):

| Campo | Padrão | Uso |
| --- | --- | --- |
| `ps4Ip` | — | IP do PS4 |
| `rpiPort` | `12800` | Porta do Remote Package Installer |
| `ftpPort` | `2121` | Porta do FTP do GoldHEN (lista de jogos instalados) |
| `serverPort` | `8686` | Porta da interface e do servidor de arquivos |
| `folders` | `[]` | Pastas da biblioteca (busca até 4 níveis) |

## Segurança

A interface e a API só respondem ao próprio PC (`localhost`). Para outros
dispositivos da rede, o servidor só entrega os PKGs da biblioteca, pelo
identificador interno; nenhuma outra pasta ou arquivo do PC fica acessível.

## Desenvolvimento

```powershell
npm test       # testes do leitor de PKG e da API
npm start      # inicia e abre o navegador
```
