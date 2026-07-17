# Lip-sync D-ID — Professora Sofia

A sala ao vivo (`aula-ia.html`) pode exibir vídeo da Sofia com **boca sincronizada** ao texto em inglês, via [D-ID Talks API](https://docs.d-id.com/reference/createtalk).

## Configuração

1. Crie conta em https://www.d-id.com/
2. Gere **API Key** (Studio → Account Settings)
3. No `.env`:

```env
DID_API_KEY=sua-chave-aqui
DID_ENABLED=true
DID_VOICE_PROVIDER=microsoft
DID_VOICE_ID=en-US-JennyNeural
```

4. Reinicie: `node server.js`
5. Confirme: `GET http://localhost:3030/api/status` → `"didLipsync": true`

## Comportamento

- Após cada resposta da IA, o front chama `POST /api/sofia/video-lipsync` com o texto.
- O servidor cria um **talk** na D-ID e aguarda o MP4 (`result_url`).
- O vídeo toca no tile da professora (áudio incluso — TTS da D-ID).
- Se D-ID falhar ou não estiver configurado, volta aos loops locais + voz do navegador.

## Imagem da Sofia

- Arquivo: `public/images/professora-sofia.png`
- Se `APP_URL` for **público** (ex.: ngrok, produção), usa `{APP_URL}/images/professora-sofia.png`.
- Em **localhost**, o servidor faz **upload** automático da imagem para a D-ID na primeira requisição.

## Custos e limites

- Cada fala gera um talk (cobrança D-ID).
- Texto limitado a `DID_MAX_CHARS` (padrão 380) por resposta.
- Geração costuma levar **10–40 s** — status: "Gerando vídeo (lip-sync)...".

## Produção

Use `APP_URL` com HTTPS público para melhor cache da imagem, ou defina `DID_SOURCE_URL` com URL estável da foto já hospedada na D-ID.
