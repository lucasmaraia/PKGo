# Payload de instalação (GoldHEN BinLoader)

`dpi.bin` permite instalar PKGs sem abrir o Remote Package Installer. O PKG
Sender o envia para a porta 9090 do PS4 (BinLoader do GoldHEN), e ele registra
o download no sistema, como o app instalador faz.

- Origem: payload do [DirectPackageInstaller](https://github.com/marcussacana/DirectPackageInstaller),
  de marcussacana, commit `ca7bade6`. Licença **GPL-3.0**: o código-fonte está
  nesse repositório.
- Gerado por `build.sh` a partir do código-fonte, sem usar o binário pronto do projeto.
- Requer o GoldHEN com *Settings > GoldHEN > Enable BinLoader Server* ativado.

`uninstall.bin` faz o mesmo para excluir: código próprio (`uninstall.c` e
`uninstall_net.c`) sobre o mesmo modelo de payload, chamando o desinstalador
do sistema (`sceAppInstUtilAppUnInstall` para o jogo, `sceAppInstUtilAppUnInstallPat`
para só a atualização, nomes conforme o Itemzflow, GPL-3.0). Ele devolve ao PC
o código de resultado do sistema. Os dados salvos não são tocados.

O Remote Package Installer continua sendo usado quando está aberto. Sem esses
arquivos, o PKG Sender funciona como antes. Para gerar os dois, em um Linux
(WSL ou Docker com `ubuntu:24.04`): `bash payload/build.sh`.
