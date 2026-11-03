# Streamarr

Mostra em quais streamings estão os filmes e séries da sua biblioteca do **Radarr** e do **Sonarr**.
Os dados vêm do JustWatch, para o país que você escolher (padrão: Brasil).

- Lê a biblioteca sozinho e pega títulos novos em até 30 minutos.
- Reconsulta cada título a cada 24 h (dá pra mudar).
- Filtra por serviço, por "meus serviços", por baixado ou não, e mostra o que não está em streaming nenhum.
- Junta as variações do mesmo serviço (por exemplo "Netflix Standard with Ads" e "HBO Max Amazon Channel").
- Node.js puro, sem dependências.

## Rodando

```bash
docker run -d --name streamarr -p 8993:8080 \
  --add-host host.docker.internal:host-gateway \
  -v /DATA/AppData/streamarr/data:/appdata \
  ghcr.io/guimartins/streamarr:latest
```

Abra `http://<servidor>:8993` e informe o endereço e a API key do Radarr e do Sonarr.
Também dá pra passar tudo por variável de ambiente: `RADARR_URL`, `RADARR_API_KEY`, `SONARR_URL`, `SONARR_API_KEY`, `COUNTRY`, `REFRESH_HOURS`.

No ZimaOS/CasaOS, use o manifesto em [`casaos/docker-compose.yml`](casaos/docker-compose.yml).

## Aviso

Usa a API GraphQL pública e não oficial do JustWatch. Ela pode mudar sem aviso.
