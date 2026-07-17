# Professora Sofia

MVP de tutora virtual de inglês com chat de IA, prática guiada, reconhecimento e síntese de voz, histórico de sessões e conteúdos organizados por estágio e unidade.

## Requisitos

- Node.js 20+
- npm
- Uma chave de API do provedor de IA configurado no ambiente

## Execução local

```bash
npm install
cp .env.example .env
npm start
```

A aplicação ficará disponível na porta definida por `PORT` (por padrão, `3030`).

## Estrutura

- `server.js`: servidor HTTP e endpoints da aplicação
- `public/`: interface web
- `data/`: currículo, materiais e divisão pedagógica
- `lib/`: persistência e integrações auxiliares
- `deploy/`: configuração de proxy reverso

Credenciais, banco SQLite e dados de sessão são mantidos fora do versionamento por segurança.