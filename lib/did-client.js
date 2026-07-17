import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Blob } from 'buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGENS_PROFESSORA = {
  iniciante: join(__dirname, '..', 'public', 'images', 'professora-sofia.png'),
  intermediario: join(__dirname, '..', 'public', 'images', 'professor-paul.png'),
  avancado: join(__dirname, '..', 'public', 'images', 'professora-kate.png'),
};

const DID_API = 'https://api.d-id.com';
const ESTAGIOS = ['iniciante', 'intermediario', 'avancado'];

const sourceUrlCache = new Map();

export function limparCacheSourceUrl() {
  sourceUrlCache.clear();
}

export function didConfigurado() {
  return !!(
    process.env.DID_API_KEY &&
    String(process.env.DID_ENABLED ?? 'true').toLowerCase() !== 'false'
  );
}

function normalizarEstagio(estagio) {
  return ESTAGIOS.includes(estagio) ? estagio : 'iniciante';
}

function authHeader() {
  const key = process.env.DID_API_KEY || '';
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}

function appUrlPublica() {
  const url = (process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (!url || /localhost|127\.0\.0\.1/i.test(url)) return null;
  return url;
}

function arquivoImagemProfessora(estagio) {
  const key = normalizarEstagio(estagio);
  return IMAGENS_PROFESSORA[key] || IMAGENS_PROFESSORA.iniciante;
}

function nomeArquivoImagem(estagio) {
  const map = {
    iniciante: 'professora-sofia.png',
    intermediario: 'professor-paul.png',
    avancado: 'professora-kate.png',
  };
  return map[normalizarEstagio(estagio)] || map.iniciante;
}

async function uploadImagemProfessora(estagio) {
  const caminho = arquivoImagemProfessora(estagio);
  const buf = readFileSync(caminho);
  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'image/png' }), nomeArquivoImagem(estagio));

  const res = await fetch(`${DID_API}/images`, {
    method: 'POST',
    headers: { Authorization: authHeader() },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.description || data?.message || `D-ID upload ${res.status}`);
  }

  const url = data.url || data.source_url || data.id;
  if (!url || typeof url !== 'string') {
    throw new Error('D-ID upload não retornou URL da imagem');
  }
  if (url.startsWith('https://') || url.startsWith('s3://')) {
    return url;
  }
  throw new Error('D-ID upload retornou URL não suportada');
}

export async function garantirSourceUrlSofia(estagio = 'iniciante') {
  const key = normalizarEstagio(estagio);
  if (sourceUrlCache.has(key)) return sourceUrlCache.get(key);

  const publica = appUrlPublica();
  if (publica) {
    const url = `${publica}/images/${nomeArquivoImagem(key)}`;
    sourceUrlCache.set(key, url);
    return url;
  }

  const url = await uploadImagemProfessora(key);
  sourceUrlCache.set(key, url);
  return url;
}

export function truncarTextoFala(texto, max = 380) {
  const t = String(texto || '').trim();
  if (t.length <= max) return t;
  const cortado = t.slice(0, max);
  const ultimoPonto = Math.max(
    cortado.lastIndexOf('.'),
    cortado.lastIndexOf('!'),
    cortado.lastIndexOf('?')
  );
  if (ultimoPonto > max * 0.5) return cortado.slice(0, ultimoPonto + 1).trim();
  return cortado.trim() + '…';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function vozDidParaEstagio(estagio, professoras) {
  const p = professoras?.[normalizarEstagio(estagio)];
  const voz = p?.vozDid || {};
  return {
    voiceId: voz.voiceId || process.env.DID_VOICE_ID || 'en-US-JennyNeural',
    voiceProvider: voz.provider || process.env.DID_VOICE_PROVIDER || 'microsoft',
  };
}

export async function gerarVideoLipsync(texto, estagio = 'iniciante', professoras = null) {
  if (!didConfigurado()) {
    return { ok: false, erro: 'D-ID não configurado' };
  }

  const input = truncarTextoFala(
    texto,
    parseInt(process.env.DID_MAX_CHARS || '380', 10)
  );
  if (!input) return { ok: false, erro: 'Texto vazio' };

  const key = normalizarEstagio(estagio);
  const source_url = await garantirSourceUrlSofia(key);
  const { voiceId, voiceProvider } = vozDidParaEstagio(key, professoras);

  const criar = await fetch(`${DID_API}/talks`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source_url,
      script: {
        type: 'text',
        input,
        provider: {
          type: voiceProvider,
          voice_id: voiceId,
        },
      },
      config: {
        stitch: true,
        fluent: true,
      },
    }),
  });

  const criado = await criar.json().catch(() => ({}));
  if (!criar.ok) {
    return {
      ok: false,
      erro: criado?.description || criado?.message || `D-ID talks ${criar.status}`,
    };
  }

  const talkId = criado.id;
  if (!talkId) return { ok: false, erro: 'D-ID não retornou id do talk' };

  const timeoutMs = parseInt(process.env.DID_TIMEOUT_MS || '90000', 10);
  const inicio = Date.now();

  while (Date.now() - inicio < timeoutMs) {
    await sleep(2000);
    const poll = await fetch(`${DID_API}/talks/${talkId}`, {
      headers: { Authorization: authHeader() },
    });
    const status = await poll.json().catch(() => ({}));

    if (!poll.ok) {
      return {
        ok: false,
        erro: status?.description || `D-ID poll ${poll.status}`,
        talkId,
      };
    }

    if (status.status === 'done' && status.result_url) {
      return {
        ok: true,
        videoUrl: status.result_url,
        talkId,
        textoUsado: input,
        estagio: key,
        voiceId,
      };
    }

    if (status.status === 'error' || status.status === 'rejected') {
      return {
        ok: false,
        erro: status?.description || 'D-ID rejeitou o vídeo',
        talkId,
      };
    }
  }

  return { ok: false, erro: 'Tempo esgotado aguardando vídeo D-ID', talkId };
}
