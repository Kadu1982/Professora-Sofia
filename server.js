import 'dotenv/config';
import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  didConfigurado,
  gerarVideoLipsync,
  garantirSourceUrlSofia,
} from './lib/did-client.js';
import {
  obterSessao as dbObterSessao,
  criarSessao as dbCriarSessao,
  atualizarSessao as dbAtualizarSessao,
  encerrarSessao as dbEncerrarSessao,
  listarSessoesAlunoDetalhado as dbListarSessoesAlunoDetalhado,
  fechar as dbFechar,
} from './lib/sessoes-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Log estruturado de request ───────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - start;
    const sessaoTag = req.body?.sessaoId || req.params?.sessaoId || '-';
    const modelo = ultimoModeloUsado || '-';
    // Log compacto e parseável
    console.log(
      `[req] ${req.method} ${req.path} ${res.statusCode} ${dur}ms sessao=${sessaoTag} modelo=${modelo}`
    );
  });
  next();
});

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── LLM: Gemini direto ou OpenRouter ───────────────────────────
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'mistralai/mistral-nemo';
const OPENROUTER_FALLBACK_MODELS = (
  process.env.OPENROUTER_FALLBACK_MODELS ||
  'deepseek/deepseek-v4-flash,openrouter/free'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const OPENROUTER_MODELOS_RAPIDOS = (
  process.env.OPENROUTER_MODELOS_RAPIDOS ||
  'mistralai/mistral-nemo,deepseek/deepseek-v4-flash,google/gemini-2.0-flash-001,openrouter/free'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const OPENROUTER_PRIORIDADE_RAPIDO =
  process.env.OPENROUTER_PRIORIDADE_RAPIDO !== 'false';
/** Só modelos :free e openrouter/free — zero créditos OpenRouter */
const OPENROUTER_APENAS_GRATUITOS =
  process.env.OPENROUTER_APENAS_GRATUITOS !== 'false';

let ultimoModeloUsado = OPENROUTER_MODEL;

function ehModeloGratuito(slug) {
  return slug === 'openrouter/free' || slug.endsWith(':free');
}

function obterListaModelosOpenRouter() {
  let lista;
  if (OPENROUTER_PRIORIDADE_RAPIDO) {
    lista = [...new Set([...OPENROUTER_MODELOS_RAPIDOS, OPENROUTER_MODEL, ...OPENROUTER_FALLBACK_MODELS])];
  } else {
    lista = [...new Set([OPENROUTER_MODEL, ...OPENROUTER_FALLBACK_MODELS])];
  }
  if (OPENROUTER_APENAS_GRATUITOS) {
    lista = lista.filter(ehModeloGratuito);
  }
  return lista.length ? lista : ['openrouter/free'];
}

function resumirVocabulario(vocabulario, palavrasUnidade, max = 100) {
  const set = new Set();
  (palavrasUnidade || []).forEach((w) => set.add(String(w).toLowerCase()));
  for (const w of vocabulario) {
    if (set.size >= max) break;
    set.add(String(w).toLowerCase());
  }
  return [...set];
}

function limiteHistorico(historico, aulaAoVivo) {
  return historico.slice(aulaAoVivo ? -12 : -24);
}

/** Contexto enviado ao LLM; na última fala por voz, lembra que o texto pode estar errado */
function historicoParaLLM(historico, aulaAoVivo) {
  const lim = limiteHistorico(historico, aulaAoVivo);
  return lim.map((msg, idx) => {
    let content = msg.content;
    const isUltima = idx === lim.length - 1;
    if (aulaAoVivo && isUltima && msg.role === 'user' && msg.origemVoz) {
      // Monta lista ranqueada das alternativas do STT (top-3) para ajudar o LLM a inferir a intenção.
      let altRanked = [];
      if (Array.isArray(msg.alternativasConfianca) && msg.alternativasConfianca.length > 0) {
        const todas = [];
        for (const r of msg.alternativasConfianca) {
          for (const a of (r.alternativas || [])) {
            if (a?.texto) todas.push({ texto: a.texto, confianca: a.confianca || 0 });
          }
        }
        // Remove duplicatas, mantém a maior confiança
        const mapa = new Map();
        for (const t of todas) {
          const prev = mapa.get(t.texto.toLowerCase());
          if (!prev || t.confianca > prev.confianca) mapa.set(t.texto.toLowerCase(), t);
        }
        altRanked = [...mapa.values()].sort((a, b) => b.confianca - a.confianca).slice(0, 3);
      }

      const confianca = typeof msg.confiancaMelhor === 'number' ? msg.confiancaMelhor : null;
      const confLabel = confianca != null ? `Best STT confidence: ${confianca.toFixed(2)}.` : '';
      const altTextos = altRanked.length > 0
        ? altRanked.map((a, i) => `Option ${i + 1}: "${a.texto}" (${(a.confianca || 0).toFixed(2)})`).join(' | ')
        : '';

      const prefix = `[Student spoke on microphone. ${confLabel} Use the most likely English intent from the options below as the basis for your reply, then RECAST with the corrected phrase in single quotes at the start of your response.
${altTextos ? `STT alternatives: ${altTextos}\n` : ''}Transcript (may be wrong): "${msg.content}"]`;

      content = prefix + '\n' + content;
    }
    return { role: msg.role, content };
  });
}

/** Detecta se o aluno escreveu/falou em português (heurística para BR) */
function detectarIdiomaMensagem(texto) {
  const t = String(texto || '').trim().toLowerCase();
  if (!t) return 'unknown';

  const padroesPt = [
    /\b(não|nao|você|voce|também|tambem|obrigad|estou|tudo bem|porque|por que|beleza|legal|hoje|ontem)\b/,
    /\b(é|são|está|esta|ção|ções|nhã|lhão|ué|né\b|pra\b|pro\b|tô\b|tá\b)/,
    /[áàâãéêíóôõúç]/,
  ];
  const padroesEn = [
    /\b(the|is|are|was|were|have|has|what|how|hello|yes|please|thank|you|my|your)\b/,
    /\b(i am|i'm|don't|can't|won't)\b/,
  ];

  let pt = 0;
  let en = 0;
  padroesPt.forEach((re) => {
    if (re.test(t)) pt += 2;
  });
  padroesEn.forEach((re) => {
    if (re.test(t)) en += 1;
  });

  if (pt > en) return 'portuguese';
  if (en > 0) return 'english';
  return 'english';
}

function blocoIdiomaAluno(idioma, aulaAoVivo = false) {
  if (idioma === 'portuguese') {
    if (aulaAoVivo) {
      return `
## STUDENT LANGUAGE — PORTUGUESE (live microphone)
The transcript looks Portuguese — they may have spoken Portuguese OR English with accent misheard by speech-to-text.
You UNDERSTOOD their intent. Reply ONLY in simple English (APPROVED VOCABULARY).
In one short line: model the English phrase they were aiming for, then invite them to repeat it in English.
Example: "In English we say: I am fine. Can you say that with me?"
Do NOT wait for perfect pronunciation. Do NOT reply in Portuguese.`;
    }
    return `
## STUDENT LANGUAGE — PORTUGUESE DETECTED
The student just wrote or spoke in Portuguese (Brazilian). You UNDERSTOOD their message.
Reply ONLY in simple English using APPROVED VOCABULARY.
In one short line, give the English equivalent of what they tried to say, then kindly ask them to repeat it in English.
Example tone: "In English we say: I am fine. Can you say that in English?"
Do NOT reply in Portuguese. Do NOT give long grammar lectures.`;
  }
  if (aulaAoVivo) {
    return `
## STUDENT LANGUAGE — ENGLISH (live microphone)
Transcript may be imperfect. Respond anyway — infer intent, correct pronunciation/grammar in one short line if needed, then continue.`;
  }
  return `
## STUDENT LANGUAGE — ENGLISH
The student is using English. Praise effort when appropriate. Correct mistakes gently in English.`;
}

function blocoFalaAoVivo(nomeAluno) {
  return `
## LIVE SPEECH — MICROPHONE (critical for ${nomeAluno})
Every student message in this room comes from VOICE (speech-to-text), not typing. The text can be WRONG.

Your job when verbalization is wrong or unclear:
1. ALWAYS reply on the first message — never behave as if you are "waiting" for correct English before responding.
2. Guess what the student TRIED to say (intent over exact words). Homophones, accent, and STT errors are common.
3. If grammar or pronunciation was wrong (or the transcript is odd), correct gently in ONE short line, model the right phrase with APPROVED VOCABULARY, praise effort, then ask ONE follow-up question.
4. If the transcript is nonsense or you cannot infer meaning, do NOT stay silent — say: "I did not catch that. Try again, like this: I am fine." (adapt to the lesson).
5. Mixed Portuguese/English in the transcript is normal for Brazilian learners — bridge to English, do not scold.
6. Never mention speech-to-text, microphones, or AI. Act like a patient teacher who heard them speak live.
7. If the student pauses after speaking, the transcript may be incomplete — still respond and correct what you received; do not wait for a "better" sentence.`;
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

function llmConfigurado() {
  if (LLM_PROVIDER === 'openrouter') return !!process.env.OPENROUTER_API_KEY;
  return !!process.env.GEMINI_API_KEY;
}

function modeloAtivo() {
  return LLM_PROVIDER === 'openrouter' ? OPENROUTER_MODEL : GEMINI_MODEL;
}

function provedorLabel() {
  return LLM_PROVIDER === 'openrouter'
    ? `OpenRouter (${OPENROUTER_MODEL})`
    : `Google Gemini (${GEMINI_MODEL})`;
}

// ── Session store (SQLite — sobrevive a reinício do PM2) ─────────
// sessaoId → { nomeAluno, estagioRecomendado, estagioAtivo, unidadeAtual, historico, ativa }
// Helpers: dbObterSessao, dbCriarSessao, dbAtualizarSessao, dbEncerrarSessao (lib/sessoes-store.js)

const ESTAGIOS = ['iniciante', 'intermediario', 'avancado'];
const ORDEM_ESTAGIO = { iniciante: 0, intermediario: 1, avancado: 2 };

// ── Helpers ────────────────────────────────────────────────────

function carregarMateriais() {
  const raw = readFileSync(join(__dirname, 'data/materiais.json'), 'utf-8');
  return JSON.parse(raw);
}

function carregarCurriculo() {
  const raw = readFileSync(join(__dirname, 'data/curriculo-talk-method.json'), 'utf-8');
  return JSON.parse(raw);
}

function carregarProfessoras() {
  const raw = readFileSync(join(__dirname, 'data/professoras.json'), 'utf-8');
  return JSON.parse(raw);
}

function carregarMateriaisPorUnidade() {
  const raw = readFileSync(join(__dirname, 'data/materiais-por-unidade.json'), 'utf-8');
  return JSON.parse(raw);
}

function getProfessora(estagio) {
  return carregarProfessoras()[normalizarEstagio(estagio)];
}

function carregarDivisaoIA() {
  const raw = readFileSync(join(__dirname, 'data/divisao-ia.json'), 'utf-8');
  return JSON.parse(raw);
}

function carregarDivisaoValidacao() {
  const path = join(__dirname, 'data/divisao-validacao.json');
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { grupos: {}, unidades: {}, aprovadoGeral: false, comentarioGeral: '' };
  }
}

function salvarDivisaoValidacao(data) {
  writeFileSync(
    join(__dirname, 'data/divisao-validacao.json'),
    JSON.stringify(data, null, 2),
    'utf-8'
  );
}

/** Infere estágio (professora) pela divisão IA do documento — fallback capítulos Talk */
function estagioPorUnidade(numeroUnidade) {
  const u = Number(numeroUnidade) || 0;
  const divisao = carregarDivisaoIA();
  for (const g of divisao.grupos) {
    if (u >= g.unidadesDe && u <= g.unidadesAte) return g.professoraEstagio;
  }
  if (u <= 16) return 'iniciante';
  if (u <= 50) return 'intermediario';
  return 'avancado';
}

function grupoIAPorUnidade(numeroUnidade) {
  const u = Number(numeroUnidade) || 0;
  const divisao = carregarDivisaoIA();
  return divisao.grupos.find((g) => u >= g.unidadesDe && u <= g.unidadesAte) || null;
}

/** Infere estágio Sofia a partir do capítulo Talk Method (1–12) */
function estagioPorCapitulo(capituloId) {
  const id = Number(capituloId) || 1;
  if (id <= 2) return 'iniciante';
  if (id <= 6) return 'intermediario';
  return 'avancado';
}

function normalizarEstagio(estagio) {
  return ESTAGIOS.includes(estagio) ? estagio : 'iniciante';
}

/**
 * estagioRecomendado: progresso real do aluno (PHP / unidade atual)
 * estagioAtivo: nível escolhido no chat (pode ser maior — “quero me arriscar”)
 */
function resolverEstagios({ estagio, estagioRecomendado, estagioAtivo, unidadeAtual, capituloAtual }) {
  let recomendado = estagioRecomendado || estagio;
  if (!recomendado && unidadeAtual) recomendado = estagioPorUnidade(unidadeAtual);
  if (!recomendado && capituloAtual) recomendado = estagioPorCapitulo(capituloAtual);
  recomendado = normalizarEstagio(recomendado);

  let ativo = estagioAtivo ? normalizarEstagio(estagioAtivo) : recomendado;
  const subiuNivel = ORDEM_ESTAGIO[ativo] > ORDEM_ESTAGIO[recomendado];

  return { estagioRecomendado: recomendado, estagioAtivo: ativo, modoDesafio: subiuNivel };
}

/** Unidades já vistas até unidadeAtual (títulos do currículo Talk Method) */
function unidadesEstudadasAte(unidadeAtual) {
  if (!unidadeAtual) return [];
  const curriculo = carregarCurriculo();
  const limite = Number(unidadeAtual);
  const lista = [];
  for (const cap of curriculo.capitulos) {
    for (const u of cap.unidades) {
      if (u.numero <= limite) {
        lista.push({
          numero: u.numero,
          titulo: u.titulo,
          capitulo: cap.titulo,
          estagio: cap.estagio,
          linha: `Unit ${u.numero} – ${u.titulo} (Chapter: ${cap.titulo})`,
        });
      }
    }
  }
  return lista;
}

/** Detalhe da unidade atual + unidade anterior (material imediato do curso) */
function obterFocoUnidadeAtual(unidadeAtual) {
  const u = Number(unidadeAtual);
  if (!u) return null;
  const todas = unidadesEstudadasAte(u);
  const atual = todas.find((x) => x.numero === u);
  const anterior = todas.find((x) => x.numero === u - 1);
  const porUnidade = carregarMateriaisPorUnidade();
  const matAtual = porUnidade[String(u)];
  const matAnterior = porUnidade[String(u - 1)];
  return { atual, anterior, matAtual, matAnterior };
}

/**
 * Contexto pedagógico extraído do material oficial Talk Method
 * (capítulos, unidades, palavras e gramática das aulas do aluno).
 */
function obterContextoMaterialCurso(estagioAtivo, unidadeAtual) {
  const curriculo = carregarCurriculo();
  const estagio = normalizarEstagio(estagioAtivo);
  const unidades = unidadesEstudadasAte(unidadeAtual);
  const foco = obterFocoUnidadeAtual(unidadeAtual);
  const porUnidade = carregarMateriaisPorUnidade();

  const capitulosDoNivel = curriculo.capitulos.filter((c) => c.estagio === estagio);
  const palavrasUnidades = new Set();
  const gramaticaUnidades = [];

  for (const item of unidades) {
    const mat = porUnidade[String(item.numero)];
    if (mat?.palavras) mat.palavras.forEach((p) => palavrasUnidades.add(p.toLowerCase()));
    if (mat?.gramatica) gramaticaUnidades.push(...mat.gramatica);
    else if (item.titulo) gramaticaUnidades.push(item.titulo);
  }

  const unidadesRecentes = unidades.slice(-8).map((x) => x.linha);
  const unidadesNivel = unidades
    .filter((x) => x.estagio === estagio)
    .map((x) => x.linha);

  let blocoUnidadeAtual = '';
  if (foco?.atual) {
    blocoUnidadeAtual = `
CURRENT UNIT (priority — base the conversation here):
- ${foco.atual.linha}
- Lesson types in Talk Method: Video Class → Class Material / Let's Practice → Listening → Speaking
${foco.matAtual ? `- Key words from this unit's material: ${foco.matAtual.palavras.join(', ')}` : ''}
${foco.matAtual ? `- Grammar from this unit: ${foco.matAtual.gramatica.join('; ')}` : ''}`;
    if (foco.anterior) {
      blocoUnidadeAtual += `
- Previous unit (you may briefly review): ${foco.anterior.linha}`;
    }
    // (Sem exemplos de recast no prompt — eles tendem a enviesar o modelo a ecoar
    //  mesmo em frases claras. As regras de recast ficam centralizadas em
    //  construirSystemPrompt → NATURAL CONVERSATION RULES.)
  }

  return {
    capitulos: capitulosDoNivel.map((c) => c.titulo),
    unidadesRecentes,
    unidadesNivel,
    blocoUnidadeAtual,
    palavrasCurso: [...palavrasUnidades],
    gramaticaCurso: [...new Set(gramaticaUnidades)],
  };
}

/** Vocabulário = base do estágio + palavras das unidades já estudadas no curso */
function obterVocabularioParaChat(estagioAtivo, unidadeAtual) {
  const { vocabulario, gramatica, topicos } = obterVocabularioAcumulado(estagioAtivo);
  const ctx = obterContextoMaterialCurso(estagioAtivo, unidadeAtual);
  const merged = new Set(vocabulario.map((w) => w.toLowerCase()));
  ctx.palavrasCurso.forEach((w) => merged.add(w.toLowerCase()));
  return {
    vocabulario: [...merged],
    gramatica: [...new Set([...gramatica, ...ctx.gramaticaCurso])],
    topicos,
    contexto: ctx,
  };
}

function salvarMateriais(materiais) {
  writeFileSync(
    join(__dirname, 'data/materiais.json'),
    JSON.stringify(materiais, null, 2),
    'utf-8'
  );
}

/**
 * Retorna vocabulário CUMULATIVO do estágio:
 *   iniciante      → só iniciante
 *   intermediario  → iniciante + intermediario
 *   avancado       → iniciante + intermediario + avancado
 */
function obterVocabularioAcumulado(estagio) {
  const materiais = carregarMateriais();
  const ordem = ['iniciante', 'intermediario', 'avancado'];
  const idx = ordem.indexOf(estagio);

  let vocabulario = [];
  let gramatica   = [];
  let topicos     = [];

  for (let i = 0; i <= idx; i++) {
    const m = materiais[ordem[i]];
    if (m) {
      vocabulario = [...vocabulario, ...m.vocabulario];
      gramatica   = [...gramatica,   ...m.gramatica];
      topicos     = [...topicos,     ...(m.topicos || [])];
    }
  }

  return { vocabulario, gramatica, topicos };
}

function palavraNormalizada(palavra) {
  return String(palavra || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z'-]/g, '');
}

function avaliarEvolucaoVocabulario(texto, estagioAtivo) {
  const ordem = ['iniciante', 'intermediario', 'avancado'];
  const indice = ordem.indexOf(normalizarEstagio(estagioAtivo));
  const proximoEstagio = indice >= 0 ? ordem[indice + 1] : null;
  if (!proximoEstagio) return { palavras: [], estagioSeguinte: null, pontuacao: 0 };

  const atual = new Set(obterVocabularioAcumulado(ordem[indice]).vocabulario.map(palavraNormalizada));
  const proximo = new Set(obterVocabularioAcumulado(proximoEstagio).vocabulario.map(palavraNormalizada));
  const palavras = [...new Set(String(texto || '').match(/[A-Za-z][A-Za-z'-]*/g) || [])]
    .filter((p) => p.length > 2)
    .filter((p) => !atual.has(palavraNormalizada(p)) && proximo.has(palavraNormalizada(p)))
    .slice(0, 8);

  return {
    palavras,
    estagioSeguinte: palavras.length ? proximoEstagio : null,
    pontuacao: palavras.length,
  };
}

function resumirSessaoPedagogica(sessao) {
  const mensagensAluno = sessao.historico.filter((m) => m.role === 'user' && m.content !== 'Hello!');
  const mensagensProfessora = sessao.historico.filter((m) => m.role === 'assistant');
  const palavras = [...new Set(mensagensAluno.flatMap((m) => m.evolucaoVocabulario?.palavras || []))];
  const comVoz = mensagensAluno.filter((m) => m.origemVoz).length;
  const inicio = sessao.historico[0]?.ts || sessao.criadoEm;
  const fim = sessao.historico[sessao.historico.length - 1]?.ts || sessao.atualizadoEm;
  const duracaoMinutos = Math.max(0, Math.round((new Date(fim) - new Date(inicio)) / 60000));
  return {
    sessaoId: sessao.sessaoId,
    unidade: sessao.unidadeAtual,
    estagio: sessao.estagioAtivo,
    criadoEm: sessao.criadoEm,
    atualizadoEm: sessao.atualizadoEm,
    duracaoMinutos,
    mensagensAluno: mensagensAluno.length,
    respostasProfessora: mensagensProfessora.length,
    interacoesPorVoz: comVoz,
    palavrasAcimaDoNivel: palavras,
    evolucaoDetectada: palavras.length > 0,
  };
}

function construirRelatorioAluno(alunoId) {
  const sessoes = dbListarSessoesAlunoDetalhado(alunoId);
  const resumos = sessoes.map(resumirSessaoPedagogica);
  const palavras = [...new Set(resumos.flatMap((s) => s.palavrasAcimaDoNivel))];
  return {
    ok: true,
    alunoId,
    nomeAluno: sessoes.at(-1)?.nomeAluno || 'Aluno',
    totalSessoes: sessoes.length,
    totalInteracoes: resumos.reduce((n, s) => n + s.mensagensAluno, 0),
    totalInteracoesPorVoz: resumos.reduce((n, s) => n + s.interacoesPorVoz, 0),
    palavrasAcimaDoNivel: palavras,
    evolucaoDetectada: palavras.length > 0,
    sessoes: resumos,
  };
}

function construirSystemPrompt(opts) {
  const {
    estagioAtivo,
    estagioRecomendado = estagioAtivo,
    nomeAluno,
    modoDesafio = false,
    unidadeAtual = null,
    aulaAoVivo = false,
    idiomaAluno = 'english',
    evolucaoVocabulario = null,
  } = opts;

  const professora = getProfessora(estagioAtivo);
  const professoraRec = getProfessora(estagioRecomendado);
  const { vocabulario, gramatica, topicos, contexto } = obterVocabularioParaChat(
    estagioAtivo,
    unidadeAtual
  );

  const vocabPrompt = aulaAoVivo
    ? resumirVocabulario(vocabulario, contexto.palavrasCurso, 100)
    : vocabulario;
  const gramaticaPrompt = aulaAoVivo ? gramatica.slice(-8) : gramatica;
  const unidadesPrompt = aulaAoVivo
    ? contexto.unidadesRecentes.slice(-4)
    : contexto.unidadesRecentes;

  const blocoDesafio = modoDesafio
    ? `
## CHALLENGE MODE
The student's course progress is ${professoraRec.nivelTalk}, but they chose to practice with you (${professora.nivelTalk}).
Stay in character as ${professora.nome}. Be patient and encouraging. Simplify if they struggle. Never mention "levels" or "AI".`
    : `
## COURSE ALIGNMENT
The student is at ${professora.nivelTalk} in the Talk Method course. Match their progress.`;

  const blocoEvolucao = evolucaoVocabulario?.palavras?.length
    ? `
## ENCOURAGE PROGRESS
The student naturally used vocabulary associated with the next stage: ${evolucaoVocabulario.palavras.join(', ')}.
Celebrate this briefly and warmly in English, without mentioning vocabulary lists, levels, prompts, or AI. Then continue the conversation naturally.`
    : '';

  return `${
    aulaAoVivo
      ? `## PRIORITY 1 — LIVE SPEECH RULES (apply BEFORE everything else)
Every student message in this room comes from VOICE (speech-to-text), not typing. The text can be WRONG.

OTHER RULES:
1. ALWAYS reply — never stay silent. The student is waiting.
2. The system may provide STT ALTERNATIVES — when present, the alternative list is your best clue to what the student tried to say. Pick the most likely English intent and reply to that.
3. Mixed Portuguese/English in the transcript is normal — bridge to English, do not scold.
4. Never mention speech-to-text, microphones, or AI. Act like a patient teacher who heard them speak live.

`
      : ''
  }${professora.personalidade}

${professora.estiloConversa}

Your student's name is ${nomeAluno}.
You teach the Talk Method course (${professora.nivelTalk} — chapters: ${professora.capitulosTalk.join(', ')}).
${blocoDesafio}
${blocoEvolucao}

## OFFICIAL COURSE MATERIAL (Talk Method — use this to guide the conversation)
Platform: Inglês Aprenda de Uma Vez / Talk Method.
Chapters at this level: ${contexto.capitulos.join(', ')}.

Units the student has already reached in the course:
${unidadesPrompt.join('\n') || '(not specified — use general topics for this level)'}
${contexto.blocoUnidadeAtual}

Focus from course lesson types: ${professora.focoAula}

## VOCABULARY CONSTRAINT (mandatory — same LLM, controlled output)
Use ONLY words from APPROVED VOCABULARY below (includes words from the student's Talk Method units).
Always allowed: I, me, you, he, she, we, they, it, the, a, an, is, are, was, were, am, be, been,
and, or, but, not, yes, no, do, does, did, can, will, would, this, that, my, your,
what, how, where, when, who, here, there, very, so, too, also, please, let, us.

APPROVED VOCABULARY (${vocabPrompt.length} words):
${Array.isArray(vocabPrompt) ? vocabPrompt.join(', ') : vocabPrompt}

GRAMMAR from course + materials:
${gramaticaPrompt.join('; ')}

TOPICS:
${(aulaAoVivo ? topicos.slice(-5) : topicos).join(', ')}

${blocoIdiomaAluno(idiomaAluno, aulaAoVivo)}

## STRESS MARKS (sílaba tônica — acentuação gráfica)
${nomeAluno} is Brazilian. Brazilian learners often misplace English word stress. To help, mark the stressed syllable of multi-syllable English words with an acute accent (á, é, í, ó, ú) on the stressed vowel. This is a Brazilian teaching convention.

RULES:
- Mark stress ONLY on content words with 2+ syllables (nouns, verbs, adjectives, adverbs). Skip monosyllabic words (I, you, is, the, a, to, my, etc.) and function words.
- Mark EVERY time you say a multi-syllable English word, even in normal conversation. The student sees the marks and learns where the stress falls.
- In RECASTS, the corrected phrase MUST have stress marks on its multi-syllable words.

REFERENCE LIST (most common words — apply stress as shown):
- compúter, tomórrow, yestérday, beutiful (BEAU-tiful), wónderful, delícious, favórite, importánt, interestíng, vocabúlary, famíly, América, Chrístmas, vacátion, restáurant, expéct, belíeve, becáuse, befóre, betwéen, beútiful, engíneer, informátion, máthematics, géography, difficult, sýmple, condítion, atténtion, eveníng, afternóon, tógue, móney, hóney, páyment, requést, búsiness, órdinary, éxtraordinary, cómpany, bánana, tomáto, potáto, cócoa, pícture, música, básic, clássic, compúter, lábotory, mémory, históry, bóttle, bígger, fámous, hérror, mémorable, óbservation, fántastic, súnshine, ráinbow, ánimal, eléphant, giráffe, kánguroo, párrot, cátterpillar, bútterfly, drágon, ùnicorn, mónster, chíldren, párents, bróther, síster, cóusin, néphew, níece, grándmother, grándfather, dóctor, téacher, engíneer, láwyer, architéct, phótographer, wáiter, wáitress, prógrammer, scientíst, chémist, biólogy, géology, ástronomy, psychology, philósophy, anthrópology, literáture, grammár, conversátion, pronúncia, vocábulary, signál, líbrary, róbot, téléphone, télévision, compúter, ínternet, ápp, messáge, scréen, k eyboard, prínter, scánner, báttery, chárger, cámera, súnrise, mídnight, áfternoon, mórning, evéning, dáytime, bédtime, lúnchtime, bréakfast, dínner, búrguer, pízza, spághetti, mácarroni, chócolate, stráwberry, blúeberry, píneapple, wátérmelon, grápe, órange, lémon, ápple, p ear, bánana, cóconut, ávocado, bróccoli, carrót, potáto, tomáto, ónion, gárlic, sált, péper, s úgar, flóur, míllet, ríce, nóodle, pásta, sálad, sóup, bréad, b utter, chéese, égg, míllk, j úice, cóffee, téa, wáter, sóda, wíne, béer, ch icken, béef, póork, f ísh, sh rímp, l óbster, cráb, b éans, pés, córn, cárrot, cócoon, réd, blúe, gréen, yéllow, órange, púrple, píink, brówn, bláck, wh íte, gr éy, gólden, síilver.

EXAMPLES IN CONTEXT:
- "Pizza is delícious!"  (stress on LI in delicious)
- "What's your favórite color?"  (stress on VO in favorite)
- "I have a compúter."  (stress on PU in computer)
- "Tomórrow is my birthday."  (stress on MOR in tomorrow)
- "My famíly lives in Brazil."  (stress on FAM in family)

Do NOT mark monosyllables: I, you, he, she, it, we, they, the, a, an, is, are, was, were, am, be, been, do, does, did, can, will, would, my, your, his, her, our, their, this, that, these, those, in, on, at, to, for, of, with, and, or, but, not, yes, no, ok, hi, hello, bye, good, bad, hot, cold, big, small, old, new, fast, slow, hard, soft, long, short, high, low, near, far, right, left, up, down.

## NATURAL CONVERSATION RULES

1. Sound like a real teacher in a Speaking Practice lesson — not a robot, not a list of rules.

2. **NEVER REPEAT THE STUDENT'S PHRASE** (this is the most important rule):
   Your job as a teacher is to RESPOND to what the student said, not to REPEAT it.
   - If you UNDERSTOOD the student's message → just REACT to it (comment + follow-up question). Do NOT put their phrase in quotes at the start of your reply.
   - If you did NOT understand the message (garbled, wrong word, low STT confidence, Portuguese) → THEN you can model the correct English phrase in single quotes, briefly, ONCE, then move on.

   Examples of CORRECT behavior (understood the message — just react):
   - Student: "I love pizza."  →  Sofia: "Pizza is great! What's your favórite topping?"
   - Student: "I work in a hospital."  →  Sofia: "That's a very important job! Are you a doctor or a nurse?"
   - Student: "My sister is a beautiful person."  →  Sofia: "That's kind! Is she older or younger than you?"
   - Student: "Tomorrow is my birthday."  →  Sofia: "Happy birthday! How old will you be?"
   - Student: "Chocolate is delicious."  →  Sofia: "Yum! What's your favórite kind?"

   Examples of CORRECT behavior (did NOT understand — model the phrase):
   - Student says "I goed to the park yesterday" (wrong verb) → Sofia: "'I went to the park yestérday.' Nice! Was it a fun day?"
   - Student says "eu gosto de pizza" (Portuguese) → Sofia: "'I like pizza.' Yum! What's your favórite topping?"

3. Do NOT point out every tiny mistake. Real teachers correct selectively — focus on errors that block understanding or come up repeatedly. A clear, understandable message deserves a natural reaction, not a correction.

4. Your replies are ALWAYS in English only (never Portuguese), even when the student uses Portuguese. When the student writes in Portuguese, give a SHORT English equivalent in single quotes ONCE (so they learn the phrase), then continue the conversation in English. Do not lecture.

5. Do not mention vocabulary lists, prompts, language detection, or that you are an AI.

6. End with ONE short question to keep the dialogue going.

7. You are ${professora.nomeCompleto} — do not call yourself Sofia unless you are Sofia.

8. The student is FREE to change topic at any moment. Answer in level-appropriate English and ask a related follow-up. NEVER force the student back to a previous topic or unit. Topic change is welcome, not "drift".

9. If the student asks an off-topic question (hobbies, travel, food, work, family, news), answer briefly in simple English using APPROVED VOCABULARY, then ask a related follow-up. Do NOT reject the question or force them back to a unit.${
    aulaAoVivo
      ? `

## LIVE VIDEO CLASS (Speaking room)
You are in a live one-to-one video call with ${nomeAluno}. Keep each reply SHORT (2–3 sentences, max ~50 words).
Speak naturally, warm, with natural pauses — as on Google Meet or Teams. React to what they just said before asking the next question.
Respond immediately to imperfect speech — your role is to TEACH and CORRECT, not to reject unclear attempts.
Do not use bullet points or numbered lists. One idea per turn. REMEMBER: do NOT repeat the student's words in single quotes unless you did NOT understand their message.`
      : ''
  }`;
}

function temperaturaProfessora(estagio, aulaAoVivo = false) {
  const p = getProfessora(estagio);
  const t = aulaAoVivo ? p.temperatureAula : p.temperatureChat;
  return typeof t === 'number' ? t : aulaAoVivo ? 0.55 : 0.65;
}

function respostaProfessoraParaCliente(estagioAtivo) {
  const p = getProfessora(estagioAtivo);
  return {
    nome: p.nome,
    nomeCompleto: p.nomeCompleto,
    nivel: p.nivelTalk,
    corPrimaria: p.corPrimaria,
    corSecundaria: p.corSecundaria,
    icone: p.icone,
    avatar: p.avatar || null,
    cenario: p.cenario || null,
    voz: p.voz || null,
    temperatureChat: p.temperatureChat ?? null,
    temperatureAula: p.temperatureAula ?? null,
  };
}

/**
 * Converte o histórico interno [{role, content, ts}] para o formato do Gemini:
 * [{role: 'user'|'model', parts: [{text}]}]
 * Gemini usa 'model' em vez de 'assistant'.
 */
function historicoParaGemini(historico) {
  return historico.map(({ role, content }) => ({
    role: role === 'assistant' ? 'model' : 'user',
    parts: [{ text: content }],
  }));
}

async function chamarGemini(systemPrompt, historico, opts = {}) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: opts.temperature ?? 0.65,
      maxOutputTokens: opts.maxTokens ?? 400,
    },
  });

  const ultimaMensagem = historico[historico.length - 1];
  const historicoAnterior = historico.slice(0, -1);

  const chat = model.startChat({
    history: historicoParaGemini(historicoAnterior),
  });

  const result = await chat.sendMessage(ultimaMensagem.content);
  return result.response.text();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(data, tentativa) {
  const sec = data?.error?.metadata?.retry_after_seconds;
  if (typeof sec === 'number' && sec > 0) return Math.min(Math.ceil(sec * 1000) + 300, 3500);
  return Math.min(1200 * (tentativa + 1), 3500);
}

function deveEsperarRetry429(model) {
  return model === 'openrouter/free';
}

async function openRouterCompletion(model, messages, opts = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:3030',
      'X-OpenRouter-Title': process.env.APP_NAME || 'Professora Sofia MVP',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? (opts.aulaAoVivo ? 0.65 : 0.75),
      max_tokens: opts.maxTokens ?? 400,
      stream: !!opts.stream,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(
      `OpenRouter ${res.status}: ${data?.error?.message || data?.message || res.statusText}`
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }

  const texto = data?.choices?.[0]?.message?.content?.trim();
  if (!texto) throw new Error('OpenRouter retornou resposta vazia');
  return texto;
}

/** OpenRouter — tenta modelo principal e fallbacks se houver fila (429) */
async function chamarOpenRouter(systemPrompt, historico, opts = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY não configurada');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historico.map(({ role, content }) => ({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    })),
  ];

  const modelos = obterListaModelosOpenRouter();

  let ultimoErro = null;

  for (const model of modelos) {
    const maxTentativas = deveEsperarRetry429(model) ? 2 : 1;

    for (let tentativa = 0; tentativa < maxTentativas; tentativa++) {
      try {
        const texto = await openRouterCompletion(model, messages, opts);
        if (model !== OPENROUTER_MODEL) {
          console.warn(`[OpenRouter] fallback: ${model}`);
        }
        ultimoModeloUsado = model;
        return texto;
      } catch (err) {
        ultimoErro = err;
        const is429 = err.status === 429 || String(err.message).includes('429');
        const is402 = err.status === 402 || String(err.message).includes('402');
        if (is402 || is429) {
          console.warn(`[OpenRouter] ${model} → ${is402 ? '402' : '429'}, próximo...`);
        }
        if (is402) break;
        if (is429 && deveEsperarRetry429(model) && tentativa < maxTentativas - 1) {
          const espera = retryAfterMs(err.data, tentativa);
          await sleep(espera);
          continue;
        }
        break;
      }
    }
  }

  throw ultimoErro || new Error('OpenRouter: todos os modelos falharam');
}

async function chamarLLM(systemPrompt, historico, opts = {}) {
  if (LLM_PROVIDER === 'openrouter') {
    return chamarOpenRouter(systemPrompt, historico, opts);
  }
  return chamarGemini(systemPrompt, historico, opts);
}

/** Streaming OpenRouter — retorna texto completo + generator de chunks */
async function chamarOpenRouterStream(systemPrompt, historico, opts, onChunk) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historico.map(({ role, content }) => ({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    })),
  ];

  const modelos = obterListaModelosOpenRouter();
  let ultimoErro = null;

  for (const model of modelos) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3030',
          'X-OpenRouter-Title': process.env.APP_NAME || 'Professora Sofia MVP',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0.55,
          max_tokens: opts.maxTokens ?? 100,
          top_p: 0.9,
          frequency_penalty: 0.2,
          presence_penalty: 0.1,
          stream: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = new Error(data?.error?.message || res.statusText);
        err.status = res.status;
        throw err;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let texto = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const linhas = buffer.split('\n');
        buffer = linhas.pop() || '';

        for (const linha of linhas) {
          if (!linha.startsWith('data: ')) continue;
          const payload = linha.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            const pedaco = json.choices?.[0]?.delta?.content || '';
            if (pedaco) {
              texto += pedaco;
              onChunk(pedaco, texto);
            }
          } catch {
            /* ignora linha malformada */
          }
        }
      }

      if (!texto.trim()) throw new Error('Stream vazio');
      ultimoModeloUsado = model;
      if (model !== OPENROUTER_MODEL) {
        console.warn(`[OpenRouter] stream via fallback: ${model}`);
      }
      return texto.trim();
    } catch (err) {
      ultimoErro = err;
      console.warn(`[OpenRouter] stream ${model} falhou:`, err.message);
    }
  }

  throw ultimoErro || new Error('OpenRouter stream: todos os modelos falharam');
}

// ── API Routes ─────────────────────────────────────────────────

/** Health-check: verifica se a API key está configurada */
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    configurado: llmConfigurado(),
    provedor: LLM_PROVIDER,
    modelo: modeloAtivo(),
    modeloEmUso: ultimoModeloUsado,
    fallbacks: OPENROUTER_FALLBACK_MODELS,
    modelosRapidos: OPENROUTER_MODELOS_RAPIDOS,
    prioridadeRapido: OPENROUTER_PRIORIDADE_RAPIDO,
    apenasGratuito: OPENROUTER_APENAS_GRATUITOS,
    modelosDisponiveis: obterListaModelosOpenRouter(),
    provedorLabel: provedorLabel(),
    didConfigurado: didConfigurado(),
    didLipsync: didConfigurado(),
  });
});

/** Vídeo lip-sync D-ID — professora do nível (imagem + texto → MP4) */
app.post('/api/sofia/video-lipsync', async (req, res) => {
  const { texto, estagio } = req.body || {};

  if (!didConfigurado()) {
    return res.status(503).json({
      ok: false,
      erro: 'D-ID não configurado. Defina DID_API_KEY no .env',
      usarFallback: true,
    });
  }

  if (!texto?.trim()) {
    return res.status(400).json({ ok: false, erro: 'texto é obrigatório' });
  }

  try {
    const resultado = await gerarVideoLipsync(
      texto,
      normalizarEstagio(estagio),
      carregarProfessoras()
    );
    if (!resultado.ok) {
      console.warn('[D-ID]', resultado.erro);
      return res.status(502).json({ ...resultado, usarFallback: true });
    }
    res.json(resultado);
  } catch (err) {
    console.error('[D-ID ERROR]', err.message);
    res.status(500).json({
      ok: false,
      erro: err.message,
      usarFallback: true,
    });
  }
});

/** Lista materiais (vocabulário) por estágio */
app.get('/api/materiais', (_req, res) => {
  res.json(carregarMateriais());
});

/** Currículo Talk Method (capítulos, unidades, rotas) */
app.get('/api/curriculo', (_req, res) => {
  res.json(carregarCurriculo());
});

/** Divisão IA (documento) + professora por grupo */
app.get('/api/divisao-ia', (_req, res) => {
  const divisao = carregarDivisaoIA();
  const professoras = carregarProfessoras();
  const validacao = carregarDivisaoValidacao();
  const curriculo = carregarCurriculo();
  const grupos = divisao.grupos.map((g) => {
    const prof = professoras[g.professoraEstagio];
    const capsTalk = curriculo.capitulos.filter((c) =>
      g.unidades.some((u) => c.unidades?.some((cu) => cu.numero === u.numero))
    );
    return {
      ...g,
      professora: prof
        ? {
            nome: prof.nome,
            nomeCompleto: prof.nomeCompleto,
            corPrimaria: prof.corPrimaria,
            corSecundaria: prof.corSecundaria,
          }
        : null,
      capitulosTalk: capsTalk.map((c) => c.titulo),
      validacaoGrupo: validacao.grupos[g.id] || { aprovado: false, nota: '' },
    };
  });
  res.json({
    ...divisao,
    grupos,
    validacao,
    comparativoTalk: curriculo.mapeamentoEstagios,
  });
});

/** Salva estado de validação (MVP — arquivo local) */
app.put('/api/divisao-ia/validacao', (req, res) => {
  const atual = carregarDivisaoValidacao();
  const { unidades, grupos, aprovadoGeral, comentarioGeral } = req.body;
  const merged = {
    ...atual,
    unidades: { ...atual.unidades, ...(unidades || {}) },
    grupos: { ...atual.grupos, ...(grupos || {}) },
    aprovadoGeral: aprovadoGeral ?? atual.aprovadoGeral,
    comentarioGeral: comentarioGeral ?? atual.comentarioGeral,
    validadoEm: new Date().toISOString(),
  };
  salvarDivisaoValidacao(merged);
  res.json({ ok: true, validacao: merged });
});

/** Infere estágio recomendado a partir de unidade ou capítulo */
app.get('/api/estagio/inferir', (req, res) => {
  const { unidade, capitulo } = req.query;
  const estagioRecomendado = unidade
    ? estagioPorUnidade(unidade)
    : estagioPorCapitulo(capitulo || 1);
  const curriculo = carregarCurriculo();
  const info = curriculo.mapeamentoEstagios[estagioRecomendado];
  const grupoIA = grupoIAPorUnidade(unidade);
  res.json({
    estagioRecomendado,
    rotulo: info?.rotulo,
    professora: respostaProfessoraParaCliente(estagioRecomendado),
    unidadesDe: info?.unidadesDe,
    unidadesAte: info?.unidadesAte,
    grupoIA: grupoIA ? { id: grupoIA.id, rotulo: grupoIA.rotulo } : null,
    focoUnidade: obterFocoUnidadeAtual(unidade),
    fonteDivisao: 'divisao-ia.json (documento IA)',
  });
});

/** Dados da professora do nível (Sofia / Paul / Kate) */
app.get('/api/professora/:estagio', (req, res) => {
  const estagio = normalizarEstagio(req.params.estagio);
  res.json(respostaProfessoraParaCliente(estagio));
});

/** Atualiza vocabulário de um estágio (painel admin do MVP) */
app.put('/api/materiais/:estagio', (req, res) => {
  const { estagio } = req.params;
  const estagiosValidos = ['iniciante', 'intermediario', 'avancado'];

  if (!estagiosValidos.includes(estagio)) {
    return res.status(400).json({ erro: 'Estágio inválido' });
  }

  const materiais = carregarMateriais();
  materiais[estagio] = {
    vocabulario: req.body.vocabulario || [],
    gramatica:   req.body.gramatica   || [],
    topicos:     req.body.topicos     || [],
  };
  salvarMateriais(materiais);
  res.json({ ok: true, estagio, total: materiais[estagio].vocabulario.length });
});

/** Inicia ou retoma sessão de um aluno */
app.post('/api/sessao/iniciar', async (req, res) => {
  const {
    alunoId = 'demo',
    nomeAluno = 'Aluno',
    estagio,
    estagioRecomendado,
    estagioAtivo,
    unidadeAtual,
    capituloAtual,
    aulaAoVivo = false,
  } = req.body;

  const estagios = resolverEstagios({
    estagio,
    estagioRecomendado,
    estagioAtivo,
    unidadeAtual,
    capituloAtual,
  });

  const sessaoId = `${alunoId}-${estagios.estagioAtivo}`;
  const professora = respostaProfessoraParaCliente(estagios.estagioAtivo);

  // Retoma sessão existente (mesmo inativa) — reativa e devolve histórico.
  // Se ativa, responde imediatamente sem chamar o LLM.
  const existente = dbObterSessao(sessaoId);
  if (existente) {
    if (!existente.ativa) {
      dbAtualizarSessao(sessaoId, { ativa: true });
    }
    return res.json({
      sessaoId,
      historico: existente.historico,
      estagioRecomendado: existente.estagioRecomendado,
      estagioAtivo: existente.estagioAtivo,
      modoDesafio: existente.modoDesafio,
      professora: respostaProfessoraParaCliente(existente.estagioAtivo),
    });
  }

  const systemPrompt = construirSystemPrompt({
    ...estagios,
    nomeAluno,
    unidadeAtual,
    aulaAoVivo: !!aulaAoVivo,
  });

  // Histórico inicial: só a saudação do aluno
  const historicoInicial = [
    { role: 'user', content: 'Hello!', ts: new Date().toISOString() },
  ];

  try {
    const maxTokens = aulaAoVivo ? 140 : 280;
    const historicoIni = limiteHistorico(historicoInicial, aulaAoVivo);
    const saudacao = await chamarLLM(systemPrompt, historicoIni, {
      maxTokens,
      aulaAoVivo: !!aulaAoVivo,
    });

    const historico = [
      ...historicoInicial,
      { role: 'assistant', content: saudacao, ts: new Date().toISOString() },
    ];

    dbCriarSessao({
      sessaoId,
      alunoId,
      nomeAluno,
      estagioRecomendado: estagios.estagioRecomendado,
      estagioAtivo: estagios.estagioAtivo,
      modoDesafio: estagios.modoDesafio,
      unidadeAtual: unidadeAtual || null,
      aulaAoVivo: !!aulaAoVivo,
      historico,
    });
    res.json({
      sessaoId,
      historico,
      estagioRecomendado: estagios.estagioRecomendado,
      estagioAtivo: estagios.estagioAtivo,
      modoDesafio: estagios.modoDesafio,
      professora,
      modeloLLM: ultimoModeloUsado,
    });
  } catch (err) {
    console.error('[LLM ERROR]', err.message);
    const semChave = !llmConfigurado();
    res.status(500).json({
      erro: semChave
        ? LLM_PROVIDER === 'openrouter'
          ? 'OPENROUTER_API_KEY não configurada no .env'
          : 'GEMINI_API_KEY não configurada. Crie o arquivo .env com sua chave do Google AI Studio.'
        : mensagemErroLLM(err),
    });
  }
});

/**
 * Remove "eco" do início da resposta: o modelo às vezes começa com
 * `'frase do aluno.'` ou `"frase do aluno."` mesmo quando o prompt
 * diz para reagir. Esta função detecta e remove esse eco, devolvendo
 * a resposta natural.
 *
 * Heurística (4 níveis de tolerância):
 *  1. Eco EXATO:  'frase do aluno'  ou  "frase do aluno"  no início
 *  2. Eco PRÓXIMO: a resposta começa com a fala do aluno (mesmo sem
 *     aspas), com possíveis extensões ("too", "also", etc.)
 *  3. Eco CITADO COM VARIAÇÃO: a resposta começa com aspas e contém
 *     ≥50% das palavras da fala do aluno (mesmo com pequenas trocas
 *     tipo "in" → "at", ou conjugação diferente).
 *  4. ECO NO MEIO (após reação curta):  "Good! 'frase do aluno.' continuação"
 *     Remove o trecho do eco (com aspas + frase) do meio.
 */
function removerEco(texto, falaAluno) {
  if (!texto) return texto;
  let t = texto.trim();
  const fala = String(falaAluno || '').trim();
  if (!fala) return t;

  // Normalizar a fala do aluno
  const falaNorm = fala.replace(/[.!?]+$/, '').trim();
  const falaLower = falaNorm.toLowerCase();
  const falaEscaped = falaNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const palavrasFala = falaLower.split(/\s+/).filter(w => w.length > 1);

  // Helper: extrai o eco citado do início (entre aspas, com sinais)
  function extrairEco(matchAspas) {
    const conteudo = matchAspas[1].toLowerCase();
    const palavrasConteudo = conteudo.split(/\s+/).filter(w => w.length > 1);
    const matches = palavrasFala.filter(w => palavrasConteudo.includes(w)).length;
    const ratio = palavrasFala.length > 0 ? matches / palavrasFala.length : 0;
    return ratio >= 0.5;
  }

  // Regex para casar aspas de abertura + conteúdo (aceita apóstrofos
  // internos como em "don't") + aspas de fechamento. O [\s\S]+? é
  // lazy mas o conjunto [^'"\\] é muito restritivo — vamos usar
  // uma versão que aceita `'` no meio se for seguido de letra (contração).
  const matchAspasGenerico = (str) => {
    // Procura 'conteúdo' ou "conteúdo", onde conteúdo pode ter
    // contrações com ' (mas não pode terminar com ' que seria a aspas)
    return str.match(/^['"]([^\s][^'"]*(?:'[a-z][^'"]*)*)['"]\.?\s*/);
  };

  // 1. Eco exato:  'frase'  ou  "frase"  no início (com tolerância a contrações)
  // Tolerância: a fala do aluno pode ter "dont" mas a resposta pode ter "doesn't"
  // Solução: usa a primeira palavra + última palavra como âncora, e aceita
  // qualquer coisa no meio (incluindo aspas internas).
  const primeiraPalavra = palavrasFala[0] || '';
  const ultimaPalavra = palavrasFala[palavrasFala.length - 1] || '';
  const primeiraEscaped = primeiraPalavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ultimaEscaped = ultimaPalavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const ecoSingle = new RegExp(`^[\\s]*'[\\s]*${falaEscaped}[.?!'"]*\\s*`, 'i');
  const ecoDouble = new RegExp(`^[\\s]*"[\\s]*${falaEscaped}[.?!'"]*\\s*`, 'i');
  if (ecoSingle.test(t)) {
    t = t.replace(ecoSingle, '');
  } else if (ecoDouble.test(t)) {
    t = t.replace(ecoDouble, '');
  } else {
    // 2. Eco próximo (sem aspas) + extensões — SÓ se a resposta
    //    não começa com palavra capitalizada (sinal de fala natural)
    //    e tem aspas depois (sinal de eco)
    const tLimpo = t.replace(/^['"\s]+/, '').toLowerCase();
    if (tLimpo.startsWith(falaLower)) {
      // Verifica se a próxima coisa após a fala do aluno é um
      // sinal claro de eco: aspas, ponto final, ou extensão curta
      const ateFala = falaLower.length;
      let fimEco = ateFala;
      const resto = t.slice(fimEco);
      // Aceita: "frase do aluno."  "frase do aluno?"  "frase do aluno!"
      //         "frase do aluno too!"  "frase do aluno also!"  etc.
      const extMatch = resto.match(/^[.!?\s]*(too|also|as well|either|so do i|me too|of course)?[.!?\s]*/i);
      if (extMatch) fimEco += extMatch[0].length;
      // Verifica se depois vem aspas ou fim de string
      if (fimEco >= t.length || /^['"]/.test(t.slice(fimEco))) {
        t = t.slice(fimEco).replace(/^["'\s]+/, '');
      }
    }
  }

  // 3. Eco citado com pequena variação no INÍCIO (aspas, "I work at a hospital")
  if (/^['"]/.test(t.trim())) {
    const matchAspas = matchAspasGenerico(t);
    if (matchAspas && extrairEco(matchAspas)) {
      t = t.slice(matchAspas[0].length);
      t = t.replace(/^[\.\s,;!?'"-]+/, '');
    }
  }

  // 4. ECO NO MEIO: padrão  "Reação! 'frase do aluno (variada).' continuação"
  //    Onde a "reação" é curta (até ~40 chars) antes do eco.
  //    Aceita variação: ≥50% das palavras da fala do aluno presentes.
  const mMeio = t.match(/^([^.!?\n]{1,40}[.!?]?\s*)['"]([^\s][^'"]*(?:'[a-z][^'"]*)*)['"][.!?]?\s*/);
  if (mMeio && extrairEco({ 1: mMeio[2] })) {
    // Mantém a reação curta, remove o eco
    t = mMeio[1] + t.slice(mMeio[0].length);
  }

  // 5. ECO EM ASPAS MAIS À FRENTE (com pequena reação antes):
  //    Pega padrão "Reação! 'frase do aluno (variada).' continuação"
  //    Remove o par de aspas + conteúdo (e também qualquer aspas
  //    externa que tenha ficado sozinha).
  const todasAspas = [...t.matchAll(/['"]([^\s][^'"]*(?:'[a-z][^'"]*)*)['"]/g)];
  if (todasAspas.length >= 1) {
    for (const m of todasAspas) {
      if (extrairEco({ 1: m[1] })) {
        // Remove o eco (mantém a frase do aluno entre aspas + pontuação)
        t = t.replace(m[0], '');
        // Se sobraram aspas externas soltas (sem par), remove
        t = t.replace(/^["'\s]+/, '').replace(/["']{2,}/g, '"').trim();
        // Limpa espaços/pontuação dupla
        t = t.replace(/\s{2,}/g, ' ').replace(/\.\s*\./g, '.').trim();
        break;
      }
    }
  }

  // Limpar e capitalizar
  t = t.trim();
  if (t) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

function mensagemErroLLM(err) {
  const m = err.message || '';
  if (m.includes('429')) {
    return (
      'Modelos :free estão em fila (não usam seus créditos de $19). ' +
      'O servidor já tenta outros modelos. Recarregue a página ou aguarde 1 minuto.'
    );
  }
  if (m.includes('402')) {
    return (
      'Modelo :free sem cota (separado dos seus créditos na OpenRouter). ' +
      'Use deepseek/deepseek-v4-flash ou gemini-2.0-flash-001 — já configurados como alternativa.'
    );
  }
  return `Não foi possível obter resposta da IA. Detalhe: ${m}`;
}

/** Envia mensagem do aluno e retorna resposta da Professora Sofia */
app.post('/api/sessao/mensagem', async (req, res) => {
  const { sessaoId, mensagem } = req.body;

  if (!sessaoId || !mensagem?.trim()) {
    return res.status(400).json({ erro: 'sessaoId e mensagem são obrigatórios' });
  }

  const sessao = dbObterSessao(sessaoId);
  if (!sessao) {
    return res.status(404).json({ erro: 'Sessão não encontrada. Abra o chat e inicie uma nova conversa.' });
  }
  if (!sessao.ativa) {
    return res.status(400).json({ erro: 'Esta sessão foi encerrada.' });
  }

  const textoAluno = mensagem.trim();
  const idiomaAluno = detectarIdiomaMensagem(textoAluno);
  const evolucaoVocabulario = avaliarEvolucaoVocabulario(textoAluno, sessao.estagioAtivo);

  sessao.historico.push({
    role: 'user',
    content: textoAluno,
    ts: new Date().toISOString(),
    idioma: idiomaAluno,
    evolucaoVocabulario,
  });

  const contexto = historicoParaLLM(sessao.historico, !!sessao.aulaAoVivo);
  const systemPrompt = construirSystemPrompt({
    estagioAtivo: sessao.estagioAtivo,
    estagioRecomendado: sessao.estagioRecomendado,
    nomeAluno: sessao.nomeAluno,
    modoDesafio: sessao.modoDesafio,
    unidadeAtual: sessao.unidadeAtual,
    aulaAoVivo: !!sessao.aulaAoVivo,
    idiomaAluno,
    evolucaoVocabulario,
  });

  try {
    const maxTokens = sessao.aulaAoVivo ? 140 : 320;
    const respostaBruta = await chamarLLM(systemPrompt, contexto, {
      maxTokens,
      aulaAoVivo: !!sessao.aulaAoVivo,
      temperature: temperaturaProfessora(sessao.estagioAtivo, !!sessao.aulaAoVivo),
    });

    // Aplica filtro de eco (caso a resposta comece com a fala do aluno entre aspas)
    // Pega a fala real do aluno (sem prefixo de metadata [Student spoke...])
    const falaAlunoRaw = sessao.historico[sessao.historico.length - 1]?.content || '';
    const falaAluno = falaAlunoRaw.replace(/^\[[\s\S]*?\]\s*/, '').trim();
    const resposta = removerEco(respostaBruta, falaAluno);

    sessao.historico.push({
      role: 'assistant',
      content: resposta,
      ts: new Date().toISOString(),
    });
    dbAtualizarSessao(sessaoId, { historico: sessao.historico });

    res.json({
      resposta,
      historico: sessao.historico,
      professora: respostaProfessoraParaCliente(sessao.estagioAtivo),
      modeloLLM: ultimoModeloUsado,
      idiomaDetectado: idiomaAluno,
      evolucaoVocabulario,
    });
  } catch (err) {
    // Remove a mensagem do aluno do histórico se a IA falhou
    sessao.historico.pop();
    dbAtualizarSessao(sessaoId, { historico: sessao.historico });
    console.error('[LLM ERROR]', err.message);
    res.status(500).json({ erro: mensagemErroLLM(err) });
  }
});

/** Mensagem com streaming SSE (aula ao vivo — texto aparece antes de terminar) */
app.post('/api/sessao/mensagem/stream', async (req, res) => {
  const { sessaoId, mensagem, origemVoz, alternativas, confianca } = req.body;

  if (!sessaoId || !mensagem?.trim()) {
    return res.status(400).json({ erro: 'sessaoId e mensagem são obrigatórios' });
  }

  const sessao = dbObterSessao(sessaoId);
  if (!sessao?.ativa) {
    return res.status(404).json({ erro: 'Sessão não encontrada ou encerrada.' });
  }

  if (LLM_PROVIDER !== 'openrouter') {
    return res.status(400).json({ erro: 'Streaming só disponível com OpenRouter.' });
  }

  const textoAluno = mensagem.trim();
  const idiomaAluno = detectarIdiomaMensagem(textoAluno);
  const evolucaoVocabulario = avaliarEvolucaoVocabulario(textoAluno, sessao.estagioAtivo);

  const metadataVoz = origemVoz ? {
    origemVoz: true,
    alternativasConfianca: Array.isArray(alternativas) && alternativas.length > 0 ? alternativas : undefined,
    confiancaMelhor: typeof confianca === 'number' ? confianca : undefined,
    confiancaBaixa: typeof confianca === 'number' && confianca < 0.5,
  } : { origemVoz: true };

  sessao.historico.push({
    role: 'user',
    content: textoAluno,
    ts: new Date().toISOString(),
    idioma: idiomaAluno,
    ...metadataVoz,
    evolucaoVocabulario,
  });
  dbAtualizarSessao(sessaoId, { historico: sessao.historico });

  const contexto = historicoParaLLM(sessao.historico, true);
  const systemPrompt = construirSystemPrompt({
    estagioAtivo: sessao.estagioAtivo,
    estagioRecomendado: sessao.estagioRecomendado,
    nomeAluno: sessao.nomeAluno,
    modoDesafio: sessao.modoDesafio,
    unidadeAtual: sessao.unidadeAtual,
    aulaAoVivo: true,
    idiomaAluno,
    evolucaoVocabulario,
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Pega a fala real do aluno (sem o prefixo de metadata [Student spoke...])
  // O prefixo tem várias linhas; usa flag 's' (dotAll) para o . casar \n
  const falaParaFiltro = (contexto[contexto.length - 1]?.content || '')
    .replace(/^\[[\s\S]*?\]\s*/, '')
    .trim();

  try {
    const resposta = await chamarOpenRouterStream(
      systemPrompt,
      contexto,
      {
        maxTokens: 140,
        aulaAoVivo: true,
        temperature: temperaturaProfessora(sessao.estagioAtivo, true),
      },
      (pedaco, acumulado) => send('chunk', { pedaco, acumulado })
    );

    // Aplica filtro de eco como rede de segurança (prompt também já proíbe,
    // mas o modelo ainda ecoa em alguns casos — o filtro garante)
    const respostaLimpa = removerEco(resposta, falaParaFiltro);
    console.log('[eco] FALA:', JSON.stringify(falaParaFiltro));
    console.log('[eco] LIMPA:', JSON.stringify(respostaLimpa));

    sessao.historico.push({
      role: 'assistant',
      content: respostaLimpa,
      ts: new Date().toISOString(),
    });
    dbAtualizarSessao(sessaoId, { historico: sessao.historico });

    send('done', {
      resposta: respostaLimpa,
      modeloLLM: ultimoModeloUsado,
      idiomaDetectado: idiomaAluno,
      evolucaoVocabulario,
    });
    res.end();
  } catch (err) {
    sessao.historico.pop();
    dbAtualizarSessao(sessaoId, { historico: sessao.historico });
    console.error('[LLM STREAM ERROR]', err.message);
    send('error', { erro: mensagemErroLLM(err) });
    res.end();
  }
});

/** Health da sessão — usado pelo front para auto-reconexão */
app.get('/api/sessao/:sessaoId/health', (req, res) => {
  const s = dbObterSessao(req.params.sessaoId);
  if (!s) return res.status(404).json({ ok: false, erro: 'Sessão não encontrada' });
  res.json({
    ok: true,
    ativa: s.ativa,
    qtdMensagens: s.historico.length,
    estagioAtivo: s.estagioAtivo,
    modeloLLM: ultimoModeloUsado,
    ultimaMensagemTs: s.historico.length ? s.historico[s.historico.length - 1].ts : s.atualizadoEm,
  });
});

/** Encerra sessão */
app.delete('/api/sessao/:sessaoId', (req, res) => {
  const ok = dbEncerrarSessao(req.params.sessaoId);
  res.json({ ok });
});

/** Relatório pedagógico consolidado para acompanhamento do professor físico */
app.get('/api/relatorio/aluno/:alunoId', (req, res) => {
  const alunoId = String(req.params.alunoId || '').trim();
  if (!alunoId) return res.status(400).json({ ok: false, erro: 'alunoId é obrigatório' });
  res.json(construirRelatorioAluno(alunoId));
});

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  const apiOk = llmConfigurado();
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   🎓  Professora Sofia — MVP         ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`\n   URL      → http://localhost:${PORT}`);
  console.log(`   Provedor → ${provedorLabel()}`);
  console.log(`   API Key  → ${apiOk ? '✅ configurada' : '❌ NÃO configurada!'}`);
  console.log(
    `   D-ID     → ${didConfigurado() ? '✅ lip-sync ativo' : '○ desligado (DID_API_KEY)'}`
  );
  if (didConfigurado()) {
    garantirSourceUrlSofia().catch((err) => {
      console.warn('   D-ID     ⚠ imagem:', err.message);
    });
  }
  if (!apiOk) {
    console.log('\n   📋 .env — escolha um provedor:');
    console.log('      LLM_PROVIDER=openrouter');
    console.log('      OPENROUTER_API_KEY=sk-or-...');
    console.log('      OPENROUTER_MODEL=mistralai/mistral-nemo');
    console.log('      — ou —');
    console.log('      LLM_PROVIDER=gemini');
    console.log('      GEMINI_API_KEY=AIza...\n');
  }
});
