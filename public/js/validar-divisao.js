'use strict';

var estadoLocal = { unidades: {}, grupos: {} };

function carregarEstadoLocal() {
  try {
    var s = localStorage.getItem('divisao-validacao-draft');
    if (s) return JSON.parse(s);
  } catch (e) {}
  return null;
}

function salvarEstadoLocal() {
  localStorage.setItem('divisao-validacao-draft', JSON.stringify(estadoLocal));
}

function getUnidadeEstado(num) {
  var k = String(num);
  if (!estadoLocal.unidades[k]) {
    estadoLocal.unidades[k] = { validado: false, nota: '' };
  }
  return estadoLocal.unidades[k];
}

function getGrupoEstado(id) {
  if (!estadoLocal.grupos[id]) {
    estadoLocal.grupos[id] = { aprovado: false, nota: '' };
  }
  return estadoLocal.grupos[id];
}

function atualizarProgresso() {
  var total = $('.check-unidade').length;
  var ok = $('.check-unidade:checked').length;
  var pct = total ? Math.round((ok / total) * 100) : 0;
  $('#badge-progresso').text(pct + '% validado (' + ok + '/' + total + ')');
  $('.grupo-card').each(function () {
    var gid = $(this).data('grupo');
    var $checks = $(this).find('.check-unidade');
    var $ok = $(this).find('.check-unidade:checked');
    var p = $checks.length ? Math.round(($ok.length / $checks.length) * 100) : 0;
    $(this).find('.progress-grupo').css('width', p + '%');
    $(this).find('.pct-grupo').text(p + '%');
  });
}

function renderGrupo(grupo) {
  var p = grupo.professora || {};
  var cor1 = p.corPrimaria || '#6b7280';
  var cor2 = p.corSecundaria || '#9ca3af';
  var caps = (grupo.capitulosTalk || []).join(', ') || '—';
  var gid = grupo.id;
  var gEst = getGrupoEstado(gid);

  var unitsHtml = grupo.unidades
    .map(function (u) {
      var ue = getUnidadeEstado(u.numero);
      var cls = ue.validado ? 'validada' : '';
      return (
        '<div class="unidade-item ' + cls + '" data-num="' + u.numero + '">' +
          '<input type="checkbox" class="form-check-input check-unidade mt-1" data-num="' + u.numero + '" ' +
            (ue.validado ? 'checked' : '') + ' />' +
          '<div class="flex-grow-1">' +
            '<div class="d-flex gap-2">' +
              '<span class="num">Unit ' + u.numero + '</span>' +
              '<span class="titulo">' + escapeHtml(u.titulo) + '</span>' +
            '</div>' +
            '<input type="text" class="form-control form-control-sm nota-unidade" data-num="' + u.numero + '" ' +
              'placeholder="Observação (opcional)" value="' + escapeAttr(ue.nota) + '" />' +
          '</div>' +
        '</div>'
      );
    })
    .join('');

  return (
    '<div class="col-lg-4">' +
      '<div class="card card-grupo shadow-sm grupo-card" data-grupo="' + gid + '">' +
        '<div class="card-grupo-header" style="background:linear-gradient(135deg,' + cor1 + ',' + cor2 + ')">' +
          '<h2>' + escapeHtml(grupo.rotulo) + '</h2>' +
          '<div class="professor-tag mt-1">' +
            '<i class="fas fa-user-graduate me-1"></i>' + escapeHtml(p.nomeCompleto || '') +
            ' · Units ' + grupo.unidadesDe + '–' + grupo.unidadesAte +
          '</div>' +
          '<div class="caps-talk mt-1">Capítulos Talk: ' + escapeHtml(caps) + '</div>' +
        '</div>' +
        '<div class="unidade-list">' + unitsHtml + '</div>' +
        '<div class="grupo-footer">' +
          '<div class="d-flex justify-content-between small mb-1">' +
            '<span>Progresso do grupo</span><span class="pct-grupo fw-semibold">0%</span>' +
          '</div>' +
          '<div class="progress progress-grupo mb-2"><div class="progress-bar" style="width:0;background:' + cor1 + '"></div></div>' +
          '<div class="form-check mb-2">' +
            '<input class="form-check-input check-grupo" type="checkbox" data-grupo="' + gid + '" id="g-' + gid + '" ' +
              (gEst.aprovado ? 'checked' : '') + ' />' +
            '<label class="form-check-label small" for="g-' + gid + '">Grupo aprovado</label>' +
          '</div>' +
          '<input type="text" class="form-control form-control-sm nota-grupo" data-grupo="' + gid + '" ' +
            'placeholder="Nota do grupo" value="' + escapeAttr(gEst.nota) + '" />' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function renderExtras(curriculo) {
  var html = '';
  curriculo.capitulos.forEach(function (cap) {
    cap.unidades.forEach(function (u) {
      if (u.numero > 50) {
        html +=
          '<div class="col-md-4 col-lg-3">' +
            '<div class="extra-unit">Unit ' + u.numero + ' — ' + escapeHtml(u.titulo) +
            ' <span class="text-muted">(' + escapeHtml(cap.titulo) + ')</span></div>' +
          '</div>';
      }
    });
  });
  $('#extras-container').html(html || '<p class="text-muted small">Nenhuma unidade extra encontrada.</p>');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function mergeValidacaoServidor(v) {
  if (!v) return;
  if (v.unidades) estadoLocal.unidades = Object.assign({}, estadoLocal.unidades, v.unidades);
  if (v.grupos) estadoLocal.grupos = Object.assign({}, estadoLocal.grupos, v.grupos);
  if (v.aprovadoGeral !== undefined) $('#aprovado-geral').prop('checked', !!v.aprovadoGeral);
  if (v.comentarioGeral) $('#comentario-geral').val(v.comentarioGeral);
}

$(document).ready(function () {
  var draft = carregarEstadoLocal();
  if (draft) estadoLocal = draft;

  $.get('/api/divisao-ia', function (data) {
    $('#alert-fonte')
      .html(
        '<i class="fas fa-file-word me-1"></i>Fonte: <strong>' + escapeHtml(data.fonte) + '</strong>' +
        (data.observacao ? ' — ' + escapeHtml(data.observacao) : '')
      )
      .show();

    mergeValidacaoServidor(data.validacao);

    var html = data.grupos.map(renderGrupo).join('');
    $('#grupos-container').html(html);

    $.get('/api/curriculo', function (cur) {
      renderExtras(cur);
    });

    bindEvents();
    atualizarProgresso();
  });
});

function bindEvents() {
  $(document).on('change', '.check-unidade', function () {
    var num = $(this).data('num');
    var ue = getUnidadeEstado(num);
    ue.validado = $(this).is(':checked');
    $(this).closest('.unidade-item').toggleClass('validada', ue.validado);
    salvarEstadoLocal();
    atualizarProgresso();
  });

  $(document).on('input', '.nota-unidade', function () {
    getUnidadeEstado($(this).data('num')).nota = $(this).val();
    salvarEstadoLocal();
  });

  $(document).on('change', '.check-grupo', function () {
    var gid = $(this).data('grupo');
    getGrupoEstado(gid).aprovado = $(this).is(':checked');
    salvarEstadoLocal();
  });

  $(document).on('input', '.nota-grupo', function () {
    getGrupoEstado($(this).data('grupo')).nota = $(this).val();
    salvarEstadoLocal();
  });

  $('#btn-salvar').on('click', function () {
    var payload = {
      unidades: estadoLocal.unidades,
      grupos: estadoLocal.grupos,
      aprovadoGeral: $('#aprovado-geral').is(':checked'),
      comentarioGeral: $('#comentario-geral').val(),
    };
    $.ajax({
      url: '/api/divisao-ia/validacao',
      method: 'PUT',
      contentType: 'application/json',
      data: JSON.stringify(payload),
      success: function () {
        $('#msg-salvar').text('✓ Salvo em data/divisao-validacao.json').show();
        setTimeout(function () { $('#msg-salvar').fadeOut(); }, 4000);
      },
      error: function () {
        $('#msg-salvar').removeClass('text-success').addClass('text-danger').text('Erro ao salvar.').show();
      },
    });
  });
}
