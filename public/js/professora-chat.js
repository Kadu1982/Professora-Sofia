/* ══════════════════════════════════════════════════
   Talk Method — Chat com professoras por nível
   Sofia (Básico) · Paul (Intermediário) · Kate (Avançado)
   ══════════════════════════════════════════════════ */

'use strict';

var PROFESSORAS_UI = {
  iniciante: {
    nome: 'Sofia',
    nomeCompleto: 'Professora Sofia',
    nivel: 'Básico',
    corPrimaria: '#16a34a',
    corSecundaria: '#22c55e',
    icone: 'fa-seedling',
    avatar: '/images/professora-sofia.png',
    cenario: 'Estúdio de ensino para adultos',
    placeholder: 'Hi! I am Sofia. Type in English...',
    intro: 'Olá! Sou a Professora Sofia.',
    introSub: 'Vou praticar com você o inglês das suas aulas de <strong>Básico</strong> (Talk Method).',
  },
  intermediario: {
    nome: 'Paul',
    nomeCompleto: 'Professor Paul',
    nivel: 'Intermediário',
    corPrimaria: '#1d4ed8',
    corSecundaria: '#3b82f6',
    icone: 'fa-comments',
    avatar: '/images/professor-paul.png',
    cenario: 'Home office moderno',
    placeholder: 'Hello! I am Paul. Type in English...',
    intro: 'Olá! Sou o Professor Paul.',
    introSub: 'Vamos conversar usando o material do seu <strong>Intermediário</strong> no Talk Method.',
  },
  avancado: {
    nome: 'Kate',
    nomeCompleto: 'Professora Kate',
    nivel: 'Avançado',
    corPrimaria: '#be185d',
    corSecundaria: '#ec4899',
    icone: 'fa-star',
    avatar: '/images/professora-kate.png',
    cenario: 'Biblioteca elegante',
    placeholder: 'Hi! I am Kate. Type in English...',
    intro: 'Olá! Sou a Professora Kate.',
    introSub: 'Prática de <strong>Avançado</strong> alinhada às suas unidades do Talk Method.',
  },
};

// ── Estado ──────────────────────────────────────────
var chatAberto = false;
var enviando = false;
var sessaoIniciada = false;
var professoraAtual = PROFESSORAS_UI.iniciante;

function htmlAvatarProfessora(tamanho) {
  var p = professoraAtual;
  var cls = tamanho === 'lg' ? 'sofia-avatar-lg' : 'sofia-avatar-sm';
  if (tamanho === 'header') cls = 'sofia-avatar';
  if (p.avatar) {
    return (
      '<div class="' + cls + ' has-foto">' +
        '<img src="' + p.avatar + '" alt="' + p.nomeCompleto + '" />' +
      '</div>'
    );
  }
  return '<div class="' + cls + '"><i class="fas ' + p.icone + '"></i></div>';
}

function aplicarTemaProfessora(estagio) {
  var p = PROFESSORAS_UI[estagio] || PROFESSORAS_UI.iniciante;
  professoraAtual = p;
  var $win = $('#chat-sofia');
  $win.css('--prof-primary', p.corPrimaria);
  $win.css('--prof-secondary', p.corSecundaria);
  $win.attr('data-professora', estagio);

  $('#chat-header-name').text(p.nomeCompleto);
  if (p.avatar) {
    $('#chat-header-avatar').html('<img src="' + p.avatar + '" alt="' + p.nomeCompleto + '" />');
  } else {
    $('#chat-header-avatar').html('<i class="fas ' + p.icone + '" id="chat-header-icone"></i>');
  }
  $('#chat-input').attr('placeholder', p.placeholder);
  $('#btn-sofia').css(
    'background',
    'linear-gradient(135deg, ' + p.corPrimaria + ' 0%, ' + p.corSecundaria + ' 100%)'
  );
  $('.sofia-tooltip').text(p.nomeCompleto);
  $('#typing-indicator .sofia-avatar-sm').replaceWith(
    $(htmlAvatarProfessora('sm')).addClass('sofia-avatar-sm')
  );

  if (window.alunoConfig) {
    window.atualizarUIAluno && window.atualizarUIAluno();
  }
}

function placeholderHtmlProfessora() {
  var p = professoraAtual;
  return (
    '<div class="chat-placeholder" id="chat-placeholder">' +
      htmlAvatarProfessora('lg') +
      '<p class="mt-3 mb-1 fw-semibold text-secondary">' + p.intro + '</p>' +
      '<p class="text-muted small mb-3">' + p.introSub + '</p>' +
      '<button class="btn btn-sm btn-iniciar-chat" onclick="iniciarChat()">' +
        '<i class="fas fa-comments me-2"></i>Iniciar conversa' +
      '</button>' +
    '</div>'
  );
}

// ── Toggle do widget ────────────────────────────────
function toggleChat() {
  chatAberto = !chatAberto;
  var $win = $('#chat-sofia');
  if (chatAberto) {
    $win.show();
    // Anima o botão
    $('#btn-sofia').css('transform', 'scale(0.9) rotate(10deg)');
    setTimeout(function () { $('#btn-sofia').css('transform', ''); }, 200);
  } else {
    $win.hide();
  }
}

// ── Reset do chat (ao trocar de aluno/estágio) ───────
function resetarChat() {
  sessaoIniciada = false;
  enviando = false;
  var estagio = window.alunoConfig ? window.alunoConfig.estagioAtivo : 'iniciante';
  aplicarTemaProfessora(estagio);
  $('#chat-messages').html(placeholderHtmlProfessora());
  $('#chat-input-area').hide();
  $('#typing-indicator').hide();
  $('#chat-input').val('').prop('disabled', false);
  $('#btn-send').prop('disabled', false);
}

// ── Inicia sessão ─────────────────────────────────────
function iniciarChat() {
  if (sessaoIniciada) return;

  var estagio = window.alunoConfig ? window.alunoConfig.estagioAtivo : 'iniciante';
  aplicarTemaProfessora(estagio);

  $('#chat-placeholder').hide();
  $('#typing-indicator').show();
  $('#online-dot').addClass('animate-pulse');

  $.ajax({
    url: '/api/sessao/iniciar',
    method: 'POST',
    contentType: 'application/json',
    data: JSON.stringify({
      alunoId: window.alunoConfig ? window.alunoConfig.id : 'demo-001',
      nomeAluno: window.alunoConfig ? window.alunoConfig.nome : 'Aluno',
      estagioRecomendado: window.alunoConfig ? window.alunoConfig.estagioRecomendado : 'iniciante',
      estagioAtivo: window.alunoConfig ? window.alunoConfig.estagioAtivo : 'iniciante',
      unidadeAtual: window.alunoConfig ? window.alunoConfig.unidadeAtual : null,
    }),
    success: function (data) {
      sessaoIniciada = true;
      if (data.professora) {
        var est = window.alunoConfig ? window.alunoConfig.estagioAtivo : 'iniciante';
        if (data.professora.nome) {
          PROFESSORAS_UI[est] = Object.assign({}, PROFESSORAS_UI[est], data.professora);
        }
        aplicarTemaProfessora(est);
      }
      $('#typing-indicator').hide();
      renderizarHistorico(data.historico);
      $('#chat-input-area').show();
      $('#chat-input').focus();
      scrollParaBaixo();
    },
    error: function (xhr) {
      $('#typing-indicator').hide();
      var msg = xhr.responseJSON ? xhr.responseJSON.erro : 'Erro ao conectar com a professora.';
      mostrarErro(msg);
      // Mostra o placeholder de volta
      if ($('#chat-placeholder').length === 0) {
        $('#chat-messages').prepend(
          '<div class="chat-placeholder" id="chat-placeholder">' +
            '<div class="sofia-avatar-lg"><i class="fas fa-graduation-cap"></i></div>' +
            '<p class="mt-3 mb-1 fw-semibold text-secondary">Tente novamente</p>' +
            '<button class="btn btn-sm btn-iniciar-chat" onclick="iniciarChat()">' +
              '<i class="fas fa-redo me-2"></i>Tentar novamente' +
            '</button>' +
          '</div>'
        );
      }
    }
  });
}

// ── Envia mensagem do aluno ───────────────────────────
function enviarMensagem() {
  if (enviando) return;

  var texto = $('#chat-input').val().trim();
  if (!texto) return;

  var sessaoId = window.alunoConfig
    ? (window.alunoConfig.id + '-' + window.alunoConfig.estagioAtivo)
    : 'demo-001-iniciante';

  // Exibe mensagem do aluno imediatamente
  adicionarBolha('aluno', texto);
  $('#chat-input').val('').prop('disabled', true);
  $('#btn-send').prop('disabled', true);
  enviando = true;

  // Mostra indicador de digitação da Sofia
  $('#typing-indicator').show();
  scrollParaBaixo();

  $.ajax({
    url: '/api/sessao/mensagem',
    method: 'POST',
    contentType: 'application/json',
    data: JSON.stringify({ sessaoId: sessaoId, mensagem: texto }),
    success: function (data) {
      $('#typing-indicator').hide();
      adicionarBolha('sofia', data.resposta);
      scrollParaBaixo();
    },
    error: function (xhr) {
      $('#typing-indicator').hide();
      var msg = xhr.responseJSON ? xhr.responseJSON.erro : 'Erro ao obter resposta. Tente novamente.';
      mostrarErro(msg);
    },
    complete: function () {
      enviando = false;
      $('#chat-input').prop('disabled', false).focus();
      $('#btn-send').prop('disabled', false);
    }
  });
}

// ── Renderiza histórico completo ──────────────────────
function renderizarHistorico(historico) {
  $('#chat-messages').empty();
  if (!historico || historico.length === 0) return;

  $.each(historico, function (i, msg) {
    var tipo = msg.role === 'assistant' ? 'sofia' : 'aluno';
    adicionarBolha(tipo, msg.content, msg.ts, false);
  });
}

// ── Adiciona uma bolha ao chat ────────────────────────
function adicionarBolha(tipo, texto, ts, animar) {
  if (typeof animar === 'undefined') animar = true;

  var hora = ts ? formatarHora(ts) : formatarHora(new Date().toISOString());
  var html;

  if (tipo === 'sofia') {
    html =
      '<div class="msg-row sofia' + (animar ? ' msg-nova' : '') + '">' +
        htmlAvatarProfessora('sm') +
        '<div>' +
          '<div class="msg-bubble">' + escaparHtml(texto) + '</div>' +
          '<div class="msg-time">' + hora + '</div>' +
        '</div>' +
      '</div>';
  } else {
    html =
      '<div class="msg-row aluno' + (animar ? ' msg-nova' : '') + '">' +
        '<div>' +
          '<div class="msg-bubble">' + escaparHtml(texto) + '</div>' +
          '<div class="msg-time">' + hora + '</div>' +
        '</div>' +
      '</div>';
  }

  var $el = $(html);
  if (animar) { $el.css({ opacity: 0, transform: 'translateY(8px)' }); }
  $('#chat-messages').append($el);

  if (animar) {
    $el.animate({ opacity: 1 }, 200);
    $el.css('transform', 'translateY(0)');
  }
}

// ── Mensagem de erro inline ───────────────────────────
function mostrarErro(msg) {
  var $erro = $('<div class="msg-erro"><i class="fas fa-exclamation-circle me-1"></i>' + msg + '</div>');
  $('#chat-messages').append($erro);
  scrollParaBaixo();
  setTimeout(function () { $erro.fadeOut(400, function () { $(this).remove(); }); }, 5000);
}

// ── Scroll para baixo ─────────────────────────────────
function scrollParaBaixo() {
  var $msgs = $('#chat-messages');
  $msgs.animate({ scrollTop: $msgs[0].scrollHeight }, 250);
}

// ── Helpers ───────────────────────────────────────────
function formatarHora(isoString) {
  try {
    var d = new Date(isoString);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function escaparHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
}
