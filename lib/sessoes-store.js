import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SOFIA_DB_PATH || join(__dirname, '..', 'data', 'sessoes.sqlite');

let db = null;

function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessoes (
      sessaoId TEXT PRIMARY KEY,
      alunoId TEXT NOT NULL,
      nomeAluno TEXT,
      estagioRecomendado TEXT,
      estagioAtivo TEXT,
      modoDesafio INTEGER DEFAULT 0,
      unidadeAtual TEXT,
      aulaAoVivo INTEGER DEFAULT 0,
      historico TEXT NOT NULL,
      ativa INTEGER DEFAULT 1,
      criadoEm TEXT NOT NULL,
      atualizadoEm TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessoes_alunoId ON sessoes(alunoId);
    CREATE INDEX IF NOT EXISTS idx_sessoes_ativa ON sessoes(ativa);
  `);
  return db;
}

export function obterSessao(sessaoId) {
  const row = getDb().prepare('SELECT * FROM sessoes WHERE sessaoId = ?').get(sessaoId);
  if (!row) return null;
  return {
    sessaoId: row.sessaoId,
    alunoId: row.alunoId,
    nomeAluno: row.nomeAluno,
    estagioRecomendado: row.estagioRecomendado,
    estagioAtivo: row.estagioAtivo,
    modoDesafio: !!row.modoDesafio,
    unidadeAtual: row.unidadeAtual ? Number(row.unidadeAtual) : null,
    aulaAoVivo: !!row.aulaAoVivo,
    historico: JSON.parse(row.historico),
    ativa: !!row.ativa,
    criadoEm: row.criadoEm,
    atualizadoEm: row.atualizadoEm,
  };
}

export function criarSessao(sessao) {
  const agora = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessoes (sessaoId, alunoId, nomeAluno, estagioRecomendado, estagioAtivo, modoDesafio, unidadeAtual, aulaAoVivo, historico, ativa, criadoEm, atualizadoEm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      sessao.sessaoId,
      sessao.alunoId,
      sessao.nomeAluno || null,
      sessao.estagioRecomendado || null,
      sessao.estagioAtivo || null,
      sessao.modoDesafio ? 1 : 0,
      sessao.unidadeAtual != null ? String(sessao.unidadeAtual) : null,
      sessao.aulaAoVivo ? 1 : 0,
      JSON.stringify(sessao.historico || []),
      agora,
      agora
    );
}

export function atualizarSessao(sessaoId, patch) {
  const atual = obterSessao(sessaoId);
  if (!atual) return false;
  const merged = { ...atual, ...patch };
  getDb()
    .prepare(
      `UPDATE sessoes SET
        nomeAluno = ?,
        estagioRecomendado = ?,
        estagioAtivo = ?,
        modoDesafio = ?,
        unidadeAtual = ?,
        aulaAoVivo = ?,
        historico = ?,
        ativa = ?,
        atualizadoEm = ?
       WHERE sessaoId = ?`
    )
    .run(
      merged.nomeAluno || null,
      merged.estagioRecomendado || null,
      merged.estagioAtivo || null,
      merged.modoDesafio ? 1 : 0,
      merged.unidadeAtual != null ? String(merged.unidadeAtual) : null,
      merged.aulaAoVivo ? 1 : 0,
      JSON.stringify(merged.historico || []),
      merged.ativa ? 1 : 0,
      new Date().toISOString(),
      sessaoId
    );
  return true;
}

export function encerrarSessao(sessaoId) {
  return atualizarSessao(sessaoId, { ativa: false });
}

export function listarSessoesAluno(alunoId) {
  return getDb()
    .prepare('SELECT sessaoId, ativa, criadoEm, atualizadoEm FROM sessoes WHERE alunoId = ? ORDER BY atualizadoEm DESC LIMIT 10')
    .all(alunoId);
}

export function listarSessoesAlunoDetalhado(alunoId) {
  return getDb()
    .prepare('SELECT * FROM sessoes WHERE alunoId = ? ORDER BY criadoEm ASC')
    .all(alunoId)
    .map((row) => ({
      sessaoId: row.sessaoId,
      alunoId: row.alunoId,
      nomeAluno: row.nomeAluno,
      estagioRecomendado: row.estagioRecomendado,
      estagioAtivo: row.estagioAtivo,
      modoDesafio: !!row.modoDesafio,
      unidadeAtual: row.unidadeAtual ? Number(row.unidadeAtual) : null,
      aulaAoVivo: !!row.aulaAoVivo,
      historico: JSON.parse(row.historico),
      ativa: !!row.ativa,
      criadoEm: row.criadoEm,
      atualizadoEm: row.atualizadoEm,
    }));
}

export function fechar() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
}
