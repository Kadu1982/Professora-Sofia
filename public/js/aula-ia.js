'use strict';

var PROFESSORAS = {
  iniciante: {
    nome: 'Sofia',
    nomeCompleto: 'Professora Sofia',
    corPrimaria: '#16a34a',
    corSecundaria: '#22c55e',
    icone: 'fa-seedling',
    avatar: '/images/professora-sofia.png',
    voz: { lang: 'en-US', rate: 0.92, pitch: 1.0, preferencias: ['Jenny', 'Aria', 'Female'] },
  },
  intermediario: {
    nome: 'Paul',
    nomeCompleto: 'Professor Paul',
    corPrimaria: '#1d4ed8',
    corSecundaria: '#3b82f6',
    icone: 'fa-comments',
    avatar: '/images/professor-paul.png',
    voz: { lang: 'en-US', rate: 0.98, pitch: 0.82, preferencias: ['Guy', 'Alex', 'Google US English Male', 'Male'] },
  },
  avancado: {
    nome: 'Kate',
    nomeCompleto: 'Professora Kate',
    corPrimaria: '#be185d',
    corSecundaria: '#ec4899',
    icone: 'fa-star',
    avatar: '/images/professora-kate.png',
    voz: { lang: 'en-US', rate: 1.06, pitch: 0.95, preferencias: ['Sara', 'Sonia', 'Google UK English Female'] },
  },
};

var params = {};
var aluno = {};
var professora = PROFESSORAS.iniciante;
var sessaoId = null;
var sessaoAtiva = false;
var enviando = false;
var vozProfAtiva = true;
var micOuvir = false;
var recognition = null;
var timerInterval = null;
var segundosAula = 0;
var escutaAutomatica = true;
var escutaSilenciada = false;
var debounceVoz = null;
var permissaoMicOk = false;
var professoraFalando = false;
var watchdogEscuta = null;
var textoInterim = '';
var reinicioEscutaTimer = null;
var reinicioBackoffMs = 60;
var pausaCapturaAte = 0;
var ultimoTextoEnviado = '';
var falhasReinicioSeguidas = 0;
var turnosConversa = 0;
var bufferFinaisVoz = '';
var textoPendenteVoz = '';
var ultimasAlternativasVoz = [];
var ultimaConfiancaVoz = null;
var timerSilencioVoz = null;
var ESPERA_ENVIO_VOZ_MS = 2500;
var didLipsyncAtivo = false;
var didLipsyncAbort = null;
var streamController = null;        // AbortController do fetch atual (cancelável)
var streamProgressTimer = null;     // watchdog de progresso do stream
var STREAM_PROGRESS_TIMEOUT_MS = 30000;
var STREAM_FIRST_BYTE_TIMEOUT_MS = 15000;

  function lerParamsUrl() {
  var q = new URLSearchParams(window.location.search);
  params = {
    nome: q.get('nome') || q.get('aluno') || 'Aluno',
    alunoId: q.get('alunoId') || q.get('id') || 'aluno-' + Date.now(),
    unidade: parseInt(q.get('unidade') || q.get('unit') || '8', 10),
    estagio: q.get('estagio') || q.get('nivel') || null,
    voltar: q.get('voltar') || 'https://inglesaprendadeumavez.com/student-area/home',
  };
  // Modo paciente: aumenta o tempo de espera da captura por voz (idosos/iniciantes)
  if (q.get('paciente') === '1' || q.get('paciente') === 'true') {
    ESPERA_ENVIO_VOZ_MS = 4000;
  }
}

function inferirEstagioPorUnidade(u) {
  if (u <= 20) return 'iniciante';
  if (u <= 40) return 'intermediario';
  return 'avancado';
}

function professoraTemVideoLocal() {
  return false;
}

function configurarMidiaProfessora() {
  var grad =
    'linear-gradient(135deg, ' + professora.corPrimaria + ', ' + professora.corSecundaria + ')';
  var usaVideo = professoraTemVideoLocal();
  var avatar = professora.avatar || null;

  $('#tile-prof').toggleClass('tile-midia-sofia', usaVideo);
  $('#tile-prof').toggleClass('tile-midia-foto', !usaVideo && !!avatar);

  $('#lobby-foto-prof')
    .attr('src', avatar || '')
    .attr('alt', professora.nomeCompleto);

  if (avatar) {
    $('#tile-prof-foto')
      .attr('src', avatar)
      .attr('alt', professora.nomeCompleto)
      .show();
  } else {
    $('#tile-prof-foto').hide();
  }

  $('#tile-prof-avatar')
    .css('background', grad)
    .find('i')
    .attr('class', 'fas ' + professora.icone);

  if (usaVideo) {
    iniciarVideosProfessora();
  } else {
    pausarVideosProfessora();
  }
}

function iniciarVideosProfessora() {
  ['video-prof-idle', 'video-prof-fala'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.muted = true;
    el.playsInline = true;
    if (id === 'video-prof-idle') {
      el.style.display = '';
      el.play().catch(function () {});
    } else {
      el.style.display = 'none';
    }
  });
}

function pausarVideosProfessora() {
  ['video-prof-idle', 'video-prof-fala'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.pause();
    }
  });
}

function pararVideoLipsync() {
  var lipsync = document.getElementById('video-prof-lipsync');
  if (didLipsyncAbort) {
    didLipsyncAbort.abort();
    didLipsyncAbort = null;
  }
  if (lipsync) {
    lipsync.pause();
    lipsync.removeAttribute('src');
    lipsync.load();
    lipsync.style.display = 'none';
    lipsync.onended = null;
  }
  $('#tile-prof').removeClass('tile-lipsync-ativo');
}

function reproduzirVideoLipsync(url, onFim) {
  if (!url) {
    if (onFim) onFim();
    return;
  }

  var lipsync = document.getElementById('video-prof-lipsync');
  if (!lipsync) {
    if (onFim) onFim();
    return;
  }

  interromperVozProfessora();
  pararVideoLipsync();

  var idle = document.getElementById('video-prof-idle');
  var fala = document.getElementById('video-prof-fala');
  if (idle) idle.pause();
  if (fala) fala.pause();

  $('#tile-prof').addClass('tile-lipsync-ativo tile-speaking');
  setStatusProf('Falando...', true);

  lipsync.src = url;
  lipsync.muted = false;
  lipsync.loop = false;
  lipsync.style.display = 'block';
  lipsync.onended = function () {
    pararVideoLipsync();
    iniciarVideosProfessora();
    setStatusProf('Pode falar — estou ouvindo', false);
    $('#tile-prof').removeClass('tile-speaking');
    if (onFim) onFim();
  };
  lipsync.onerror = function () {
    pararVideoLipsync();
    iniciarVideosProfessora();
    if (onFim) onFim();
  };
  lipsync.play().catch(function () {
    pararVideoLipsync();
    iniciarVideosProfessora();
    if (onFim) onFim();
  });
}

function solicitarVideoLipsync(texto, onFim) {
  if (!didLipsyncAtivo || !professora.avatar || !texto?.trim()) {
    if (onFim) onFim(false);
    return;
  }

  if (didLipsyncAbort) didLipsyncAbort.abort();
  var controller = new AbortController();
  didLipsyncAbort = controller;

  setStatusProf('Gerando vídeo (lip-sync)...', true);
  atualizarVideoProfessora(true);

  fetch('/api/sofia/video-lipsync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      texto: texto.trim(),
      estagio: aluno.estagioAtivo || 'iniciante',
    }),
    signal: controller.signal,
  })
    .then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.erro || 'Erro D-ID');
        return data;
      });
    })
    .then(function (data) {
      didLipsyncAbort = null;
      if (data.ok && data.videoUrl) {
        reproduzirVideoLipsync(data.videoUrl, function () {
          if (onFim) onFim(true);
        });
      } else {
        atualizarVideoProfessora(false);
        if (onFim) onFim(false);
      }
    })
    .catch(function (err) {
      didLipsyncAbort = null;
      if (err.name !== 'AbortError') {
        console.warn('[D-ID]', err.message);
      }
      atualizarVideoProfessora(false);
      if (onFim) onFim(false);
    });
}

function aoReceberRespostaProfessora(texto) {
  enviando = false;
  $('#chat-input').prop('disabled', false);

  if (!texto?.trim()) {
    liberarParaAlunoFalar();
    aposRespostaProfessora();
    return;
  }

  if (didLipsyncAtivo && professora.avatar) {
    solicitarVideoLipsync(texto, function (ok) {
      pausaCapturaAte = Date.now() + 750;
      setStatusProf('Pode falar — estou ouvindo', false);
      aposRespostaProfessora();
      garantirEscutaAtiva();
      atualizarUIMic();
      if (!ok && vozProfAtiva) {
        falarTexto(texto);
      }
    });
    return;
  }

  liberarParaAlunoFalar();
  aposRespostaProfessora();
  if (vozProfAtiva) {
    falarTexto(texto);
  }
}

function atualizarVideoProfessora(falando) {
  if (!professoraTemVideoLocal()) return;
  if ($('#tile-prof').hasClass('tile-lipsync-ativo')) return;
  var idle = document.getElementById('video-prof-idle');
  var fala = document.getElementById('video-prof-fala');
  if (!idle || !fala) return;

  if (falando) {
    idle.style.display = 'none';
    idle.pause();
    fala.style.display = 'block';
    fala.currentTime = 0;
    fala.play().catch(function () {});
  } else {
    fala.style.display = 'none';
    fala.pause();
    idle.style.display = 'block';
    idle.play().catch(function () {});
  }
}

function aplicarTemaProfessora(estagio) {
  professora = PROFESSORAS[estagio] || PROFESSORAS.iniciante;
  document.documentElement.style.setProperty('--prof-primary', professora.corPrimaria);
  document.documentElement.style.setProperty(
    '--prof-gradient',
    'linear-gradient(135deg, ' + professora.corPrimaria + ', ' + professora.corSecundaria + ')'
  );

  $('#lobby-nome-prof, #tile-prof-nome').text(professora.nomeCompleto);
  $('#sala-titulo-text').text('Speaking · ' + professora.nome);
  configurarMidiaProfessora();

  $.get('/api/professora/' + estagio).done(function (data) {
    PROFESSORAS[estagio] = Object.assign({}, PROFESSORAS[estagio], data);
    professora = PROFESSORAS[estagio];
    configurarMidiaProfessora();
  });
}

function iniciais(nome) {
  return nome
    .split(/\s+/)
    .slice(0, 2)
    .map(function (p) {
      return p[0] || '';
    })
    .join('')
    .toUpperCase() || 'A';
}

function prepararLobby() {
  $('#lobby-nome-aluno').text(aluno.nome);
  $('#lobby-unidade').text(aluno.unidadeAtual);
  $('#lobby-nivel').text(
    (professora.nomeCompleto.split(' ')[1] || professora.nome) +
      ' · ' +
      (aluno.estagioAtivo === 'iniciante'
        ? 'Básico'
        : aluno.estagioAtivo === 'intermediario'
          ? 'Intermediário'
          : 'Avançado')
  );
  $('#link-voltar').attr('href', params.voltar);
  $('#tile-aluno-nome').text(aluno.nome);
  $('#tile-aluno-iniciais').text(iniciais(aluno.nome));
  $('#sala-unidade-label').text('Unit ' + aluno.unidadeAtual);
}

function entrarNaSala() {
  pedirPermissaoMicrofone(function () {
    $('#tela-lobby').fadeOut(200, function () {
      $('#tela-sala').fadeIn(200, function () {
        configurarMidiaProfessora();
      });
      document.body.classList.add('em-sala');
      iniciarTimer();
      iniciarSessao();
    });
  });
}

function iniciarTimer() {
  segundosAula = 0;
  atualizarTimer();
  timerInterval = setInterval(function () {
    segundosAula++;
    atualizarTimer();
  }, 1000);
}

function atualizarTimer() {
  var m = Math.floor(segundosAula / 60);
  var s = segundosAula % 60;
  $('#sala-timer').text(
    (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
  );
}

function setStatusProf(texto, falando) {
  // Suporta textos com placeholders {{dots}} que viram uma animação
  // pulsante de 3 pontos. Melhora a percepção de "está processando"
  // (estudos de UX: dots animados reduzem a percepção de espera em 30%).
  var $el = $('#tile-prof-status');
  if (typeof texto === 'string' && texto.indexOf('{{dots}}') !== -1) {
    $el.html(texto.replace('{{dots}}', '<span class="status-dots"><span></span><span></span><span></span></span>'));
  } else {
    $el.text(texto);
  }
  var ativo = !!falando;
  $('#tile-prof').toggleClass('tile-speaking', ativo);
  atualizarVideoProfessora(ativo);
}

function mostrarLegenda(texto) {
  if (!texto) {
    $('#tile-legenda').hide();
    return;
  }
  $('#tile-legenda').text(texto).fadeIn(150);
}

function atualizarUIMic() {
  var ouvindo = micOuvir && !escutaSilenciada && sessaoAtiva && !enviando;
  $('#btn-mic').toggleClass('mic-on', ouvindo).toggleClass('active', escutaAutomatica && !escutaSilenciada);
  if (escutaSilenciada) {
    $('#icon-mic-status').attr('class', 'fas fa-microphone-slash text-danger');
    $('#btn-mic .ctrl-label').text('Mudo');
  } else if (ouvindo) {
    $('#icon-mic-status').attr('class', 'fas fa-microphone text-success');
    $('#btn-mic .ctrl-label').text('Ouvindo');
  } else if (enviando) {
    $('#icon-mic-status').attr('class', 'fas fa-microphone-slash text-secondary');
    $('#btn-mic .ctrl-label').text('Aguarde');
  } else {
    $('#icon-mic-status').attr('class', 'fas fa-microphone text-warning');
    $('#btn-mic .ctrl-label').text('Mic');
  }
}

function cancelarReinicioEscuta() {
  if (reinicioEscutaTimer) {
    clearTimeout(reinicioEscutaTimer);
    reinicioEscutaTimer = null;
  }
}

function cancelarTimerSilencioVoz() {
  if (timerSilencioVoz) {
    clearTimeout(timerSilencioVoz);
    timerSilencioVoz = null;
  }
}

function limparPendenciaVoz() {
  cancelarTimerSilencioVoz();
  clearTimeout(debounceVoz);
  bufferFinaisVoz = '';
  textoPendenteVoz = '';
  textoInterim = '';
}

function agendarEnvioPorSilencio() {
  cancelarTimerSilencioVoz();
  if (!textoPendenteVoz.trim() || enviando || escutaSilenciada) return;

  timerSilencioVoz = setTimeout(function () {
    timerSilencioVoz = null;
    if (!textoPendenteVoz.trim() || enviando) return;
    setStatusProf('Enviando o que ouvi...', false);
    tentarEnviarFalaCapturada(true);
  }, ESPERA_ENVIO_VOZ_MS);
}

function tentarEnviarFalaCapturada(porSilencio) {
  if (enviando || Date.now() < pausaCapturaAte || escutaSilenciada) return;

  var t = (textoPendenteVoz || textoInterim || bufferFinaisVoz || '').trim();
  if (!t || t.length < 2 || t === ultimoTextoEnviado) return;

  var aceitar = true;
  if (window.AudioFiltro) {
    aceitar = AudioFiltro.aceitarTranscricao(t, null);
    if (!aceitar && porSilencio && !AudioFiltro.ehFraseRuido(t)) {
      aceitar = true;
    }
  }

  if (!aceitar) {
    if (porSilencio) $('#tile-legenda').hide();
    return;
  }

  limparPendenciaVoz();
  enviarMensagem(t, {
    origemVoz: true,
    alternativas: ultimasAlternativasVoz,
    confianca: ultimaConfiancaVoz,
  });
  ultimasAlternativasVoz = [];
  ultimaConfiancaVoz = null;
}

function pararEscuta(forcarAbort) {
  limparPendenciaVoz();
  cancelarReinicioEscuta();
  if (recognition) {
    try {
      if (forcarAbort) recognition.abort();
      else recognition.stop();
    } catch (e) {}
  }
  micOuvir = false;
  atualizarUIMic();
}

function deveManterEscuta() {
  return escutaAutomatica && !escutaSilenciada && sessaoAtiva && !!recognition;
}

function podeEscutar() {
  return deveManterEscuta() && !enviando;
}

function retomarEscuta(delay) {
  reiniciarEscuta(delay);
}

function reiniciarEscuta(delay) {
  if (!deveManterEscuta()) {
    atualizarUIMic();
    return;
  }
  if (micOuvir) return;

  cancelarReinicioEscuta();
  var espera = typeof delay === 'number' ? delay : reinicioBackoffMs;

  reinicioEscutaTimer = setTimeout(function () {
    reinicioEscutaTimer = null;
    if (!deveManterEscuta() || micOuvir) return;

    if (window.AudioFiltro && AudioFiltro.reanudar) {
      AudioFiltro.reanudar();
    }

    try {
      recognition.start();
      reinicioBackoffMs = 60;
      falhasReinicioSeguidas = 0;
    } catch (e) {
      if (micOuvir) return;
      falhasReinicioSeguidas++;
      if (falhasReinicioSeguidas >= 2) {
        recriarReconhecimentoVoz();
        return;
      }
      reinicioBackoffMs = Math.min(Math.round(reinicioBackoffMs * 1.4), 500);
      try {
        recognition.stop();
      } catch (e2) {}
      reiniciarEscuta(reinicioBackoffMs);
    }
  }, espera);
}

function garantirEscutaAtiva() {
  if (!deveManterEscuta()) {
    atualizarUIMic();
    return;
  }
  if (!micOuvir) reiniciarEscuta(20);
  else atualizarUIMic();
}

function iniciarWatchdogEscuta() {
  if (watchdogEscuta) clearInterval(watchdogEscuta);
  watchdogEscuta = setInterval(function () {
    if (deveManterEscuta() && !micOuvir && !reinicioEscutaTimer) {
      reiniciarEscuta(0);
    }
  }, 900);
}

function pararWatchdogEscuta() {
  if (watchdogEscuta) {
    clearInterval(watchdogEscuta);
    watchdogEscuta = null;
  }
}

function pedirPermissaoMicrofone(callback) {
  if (!window.AudioFiltro) {
    if (callback) callback(false);
    return;
  }
  window.AudioFiltro.iniciar()
    .then(function (ok) {
      permissaoMicOk = !!ok;
      if (!ok) {
        mostrarErro('Permita o microfone para conversar naturalmente com a professora.', true);
      }
      if (callback) callback(!!ok);
    })
    .catch(function () {
      permissaoMicOk = false;
      mostrarErro('Permita o microfone para conversar naturalmente com a professora.', true);
      if (callback) callback(false);
    });
}

function interromperVozProfessora() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  professoraFalando = false;
  pararVideoLipsync();
  $('#tile-prof').removeClass('tile-speaking');
  atualizarVideoProfessora(false);
}

function selecionarVozProfessora() {
  var cfg = professora.voz || {};
  var voices = window.speechSynthesis.getVoices();
  var lang = cfg.lang || 'en-US';
  var prefs = cfg.preferencias || ['Female'];
  var i;
  var match;

  for (i = 0; i < prefs.length; i++) {
    match = voices.find(function (v) {
      return v.lang.indexOf(lang.split('-')[0]) === 0 && v.name.indexOf(prefs[i]) >= 0;
    });
    if (match) return match;
  }
  match = voices.find(function (v) {
    return v.lang.startsWith('en') && v.name.indexOf('Female') >= 0;
  });
  if (match) return match;
  return voices.find(function (v) { return v.lang.startsWith('en'); });
}

function falarTexto(texto, onEnd) {
  if (!vozProfAtiva || !window.speechSynthesis) {
    professoraFalando = false;
    if (onEnd) onEnd();
    return;
  }
  interromperVozProfessora();
  professoraFalando = true;
  var cfg = professora.voz || {};
  var u = new SpeechSynthesisUtterance(texto);
  u.lang = cfg.lang || 'en-US';
  u.rate = typeof cfg.rate === 'number' ? cfg.rate : 1.0;
  u.pitch = typeof cfg.pitch === 'number' ? cfg.pitch : 1.0;
  var voz = selecionarVozProfessora();
  if (voz) u.voice = voz;

  setStatusProf('Falando...', true);
  mostrarLegenda(texto);

  u.onend = function () {
    professoraFalando = false;
    setStatusProf('Pode falar — estou ouvindo', false);
    setTimeout(function () { $('#tile-legenda').fadeOut(300); }, 800);
    if (onEnd) onEnd();
    garantirEscutaAtiva();
  };
  u.onerror = function () {
    professoraFalando = false;
    setStatusProf('Pode falar — estou ouvindo', false);
    if (onEnd) onEnd();
    garantirEscutaAtiva();
  };
  window.speechSynthesis.speak(u);
}

function liberarParaAlunoFalar() {
  enviando = false;
  pausaCapturaAte = Date.now() + 750;
  $('#chat-input').prop('disabled', false);
  setStatusProf('Pode falar — estou ouvindo', false);
  garantirEscutaAtiva();
  atualizarUIMic();
}

function aposRespostaProfessora() {
  turnosConversa++;
  if (turnosConversa > 0 && turnosConversa % 3 === 0) {
    recriarReconhecimentoVoz();
  } else {
    garantirEscutaAtiva();
  }
}

function adicionarMensagem(role, texto, idioma) {
  var isProf = role === 'assistant' || role === 'sofia';
  var $b = $('<div class="msg-bubble ' + (isProf ? 'msg-prof' : 'msg-aluno') + '"></div>').text(
    texto
  );
  var $wrap = $('<div></div>').append($b);
  if (!isProf && idioma === 'portuguese') {
    $wrap.append(
      '<div class="msg-idioma-hint"><i class="fas fa-language me-1"></i>Português detectado — a professora responde em inglês</div>'
    );
  }
  $('#chat-messages').append($wrap);
  var el = document.getElementById('chat-messages');
  el.scrollTop = el.scrollHeight;
}

function mostrarRecompensaEvolucao(evolucao) {
  if (!evolucao || !Array.isArray(evolucao.palavras) || !evolucao.palavras.length) return;
  var palavras = evolucao.palavras.join(', ');
  var $wrap = $('<div class="msg-evolucao"></div>');
  $wrap.append('<i class="fas fa-trophy me-2"></i><strong>Great progress!</strong> You naturally used: ' + $('<span>').text(palavras).html() + '.');
  $('#chat-messages').append($wrap);
  $('#chat-messages')[0].scrollTop = $('#chat-messages')[0].scrollHeight;
}

function mostrarLoading(msg) {
  $('#overlay-msg').text(msg || 'A professora está respondendo...');
  $('#overlay-loading').fadeIn(150);
}

function esconderLoading() {
  $('#overlay-loading').fadeOut(150);
}

function mostrarErro(msg, persistente) {
  $('#toast-erro').text(msg).fadeIn(200);
  if (persistente) {
    $('#banner-erro-texto').text(msg);
    $('#banner-erro').show();
  }
  setTimeout(function () { $('#toast-erro').fadeOut(300); }, 8000);
}

function esconderErro() {
  $('#banner-erro').hide();
}

var iniciarSessaoEmCurso = false;

function iniciarSessao() {
  if (iniciarSessaoEmCurso) {
    console.log('[sessao] iniciarSessao já em curso — ignorando');
    return;
  }
  iniciarSessaoEmCurso = true;
  setStatusProf('Conectando...', false);
  esconderErro();
  sessaoId = aluno.alunoId + '-' + aluno.estagioAtivo;
  mostrarLoading('Conectando com a professora...');

  $.ajax({
    url: '/api/sessao/iniciar',
    method: 'POST',
    contentType: 'application/json',
    timeout: 120000,
    data: JSON.stringify({
      alunoId: aluno.alunoId,
      nomeAluno: aluno.nome,
      estagioRecomendado: aluno.estagioRecomendado,
      estagioAtivo: aluno.estagioAtivo,
      unidadeAtual: aluno.unidadeAtual,
      aulaAoVivo: true,
    }),
    success: function (data) {
      esconderLoading();
      sessaoAtiva = true;
      if (window.AudioFiltro && AudioFiltro.estaAtivo()) {
        AudioFiltro.calibrarRuidoAmbiente(2500);
      }
      iniciarWatchdogEscuta();
      if (data.professora) {
        var est = data.estagioAtivo || aluno.estagioAtivo;
        aluno.estagioAtivo = est;
        aplicarTemaProfessora(est);
      }
      $('#chat-messages').empty();
      if (data.historico && data.historico.length) {
        data.historico.forEach(function (m) {
          if (m.role === 'user' && m.content === 'Hello!') return;
          adicionarMensagem(m.role, m.content);
        });
        var ultima = data.historico.filter(function (m) {
          return m.role === 'assistant';
        }).pop();
        if (ultima) {
          aoReceberRespostaProfessora(ultima.content);
        } else {
          liberarParaAlunoFalar();
        }
      } else {
        liberarParaAlunoFalar();
      }
      iniciarSessaoEmCurso = false;
    },
    error: function (xhr) {
      esconderLoading();
      sessaoAtiva = false;
      var msg = (xhr.responseJSON && xhr.responseJSON.erro) || 'Não foi possível iniciar a aula.';
      setStatusProf('Erro — clique em Tentar de novo', false);
      mostrarErro(msg, true);
      iniciarSessaoEmCurso = false;
    },
  });
}

function detectarIdiomaCliente(texto) {
  var t = String(texto || '').toLowerCase();
  if (/[áàâãéêíóôõúç]/.test(t) || /\b(não|nao|você|voce|tudo bem|obrigad|estou|também|tambem)\b/.test(t)) {
    return 'portuguese';
  }
  return 'english';
}

function parsearSSE(buffer) {
  var eventos = [];
  var blocos = buffer.split('\n\n');
  for (var i = 0; i < blocos.length - 1; i++) {
    var bloco = blocos[i];
    var tipo = 'message';
    var dados = '';
    bloco.split('\n').forEach(function (linha) {
      if (linha.startsWith('event: ')) tipo = linha.slice(7).trim();
      if (linha.startsWith('data: ')) dados = linha.slice(6);
    });
    if (dados) {
      try {
        eventos.push({ tipo: tipo, data: JSON.parse(dados) });
      } catch (e) {}
    }
  }
  return { eventos: eventos, resto: blocos[blocos.length - 1] || '' };
}

function enviarMensagem(texto, opts) {
  opts = opts || {};
  if (!texto || !texto.trim() || enviando) return;
  if (!sessaoAtiva) {
    mostrarErro('A aula ainda não conectou. Clique em "Tentar de novo".', true);
    return;
  }
  texto = texto.trim();
  ultimoTextoEnviado = texto;
  limparPendenciaVoz();
  pausaCapturaAte = Date.now() + 400;
  enviando = true;
  setStatusProf('Pensando{{dots}}', true);
  esconderLoading();
  atualizarUIMic();

  adicionarMensagem('aluno', texto, detectarIdiomaCliente(texto));
  $('#chat-input').val('').prop('disabled', true);

  var $bubbleProf = $('<div class="msg-bubble msg-prof msg-stream"></div>').text('...');
  var $wrap = $('<div class="msg-stream-wrap"></div>').append($bubbleProf);
  $wrap.append('<button class="btn-cancelar-stream" title="Cancelar"><i class="fas fa-times"></i></button>');
  $('#chat-messages').append($wrap);
  $('#chat-messages')[0].scrollTop = $('#chat-messages')[0].scrollHeight;
  mostrarLegenda('');

  var controller = new AbortController();
  streamController = controller;
  var primeiroByte = true;
  var jaMostrouEscrevendo = false;
  var timeoutId = setTimeout(function () { controller.abort(); }, 90000);

  // Watchdog: se não chegar primeiro byte em 15s, ou se ficar 30s sem progresso, aborta.
  function armarWatchdog() {
    clearTimeout(streamProgressTimer);
    streamProgressTimer = setTimeout(function () {
      console.warn('[stream] sem progresso — abortando', { sessaoId, texto });
      controller.abort();
    }, STREAM_PROGRESS_TIMEOUT_MS);
  }
  armarWatchdog();

  // Botão de cancelar (criado acima)
  $wrap.find('.btn-cancelar-stream').on('click', function () {
    controller.abort();
  });

  fetch('/api/sessao/mensagem/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessaoId: sessaoId,
      mensagem: texto,
      origemVoz: !!opts.origemVoz,
      alternativas: opts.alternativas || [],
      confianca: opts.confianca != null ? opts.confianca : null,
    }),
    signal: controller.signal,
  })
    .then(function (res) {
      if (!res.ok) {
        return res.json().then(function (j) {
          // 404: sessão perdida (PM2 reiniciou). Auto-reconectar UMA vez.
          if (res.status === 404) {
            console.warn('[stream] 404 — recriando sessão automaticamente');
            sessaoAtiva = false;
            iniciarSessao();
            throw new Error('Sessão reconectando — tente de novo em 2s.');
          }
          throw new Error(j.erro || 'Erro na resposta');
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var respostaFinal = '';
      var ultimoProgresso = Date.now();

      function ler() {
        return reader.read().then(function (result) {
          if (primeiroByte) {
            primeiroByte = false;
            console.log('[stream] primeiro byte em', Date.now() - (ultimoProgresso - STREAM_PROGRESS_TIMEOUT_MS), 'ms');
          }
          if (result.done) {
            // Stream terminou sem evento 'done' explícito — finalizar com o que temos.
            return respostaFinal;
          }
          // Recebeu dados → resetar watchdog
          ultimoProgresso = Date.now();
          clearTimeout(streamProgressTimer);
          streamProgressTimer = setTimeout(function () {
            console.warn('[stream] sem progresso por', STREAM_PROGRESS_TIMEOUT_MS, 'ms — abortando');
            controller.abort();
          }, STREAM_PROGRESS_TIMEOUT_MS);

          buffer += decoder.decode(result.value, { stream: true });
          var parsed = parsearSSE(buffer);
          buffer = parsed.resto;
          var erroStream = null;
          parsed.eventos.forEach(function (ev) {
            if (ev.tipo === 'chunk' && ev.data.acumulado) {
              respostaFinal = ev.data.acumulado;
              $bubbleProf.text(respostaFinal);
              mostrarLegenda(respostaFinal);
              // Primeira vez que chega conteúdo do stream, troca o
              // status de "Pensando..." (com dots animados) para
              // "Escrevendo..." — feedback claro de progresso.
              if (jaMostrouEscrevendo === false) {
                setStatusProf('Escrevendo{{dots}}', true);
                jaMostrouEscrevendo = true;
              }
              $('#chat-messages')[0].scrollTop = $('#chat-messages')[0].scrollHeight;
            }
            if (ev.tipo === 'done' && ev.data.resposta) {
              respostaFinal = ev.data.resposta;
              mostrarRecompensaEvolucao(ev.data.evolucaoVocabulario);
              if (ev.data.idiomaDetectado === 'portuguese') {
                setStatusProf('Entendi em português — responda em inglês comigo', false);
              }
            }
            if (ev.tipo === 'error') {
              erroStream = new Error(ev.data.erro || 'Erro no stream');
            }
          });
          if (erroStream) throw erroStream;
          return ler();
        });
      }

      return ler();
    })
    .then(function (respostaFinal) {
      $bubbleProf.removeClass('msg-stream');
      aoReceberRespostaProfessora(respostaFinal);
    })
    .catch(function (err) {
      clearTimeout(timeoutId);
      clearTimeout(streamProgressTimer);
      $wrap.remove();
      // Watchdog de segurança: se algo der errado, garantir que 'enviando' é resetado
      // e o input é re-habilitado.
      var foiCancelado = err.name === 'AbortError' || controller.signal.aborted;
      // Em caso de cancelamento, NÃO forçar reset imediato se houver um cancelamento
      // de usuário (o botão já cuidou disso na próxima interação). Mas como o usuário
      // pode ter cancelado E ficado travado, resetamos sempre.
      enviando = false;
      $('#chat-input').prop('disabled', false).focus();
      setStatusProf('Pode falar — estou ouvindo', false);
      var msg = foiCancelado
        ? 'Resposta cancelada.'
        : (err.message || 'Erro ao obter resposta.');
      if (!err.message || err.message.indexOf('reconectando') === -1) {
        mostrarErro(msg, true);
      }
      garantirEscutaAtiva();
      atualizarUIMic();
      console.log('[stream] finalizado', { erro: err.message, cancelado: foiCancelado });
    })
    .finally(function () {
      clearTimeout(timeoutId);
      clearTimeout(streamProgressTimer);
      if (streamController === controller) streamController = null;
    });
}

function vincularEventosReconhecimento(rec) {
  rec.onstart = function () {
    micOuvir = true;
    reinicioBackoffMs = 60;
    falhasReinicioSeguidas = 0;
    if (window.AudioFiltro && AudioFiltro.reanudar) AudioFiltro.reanudar();
    if (!enviando) {
      setStatusProf('Pode falar — estou ouvindo', false);
    }
    atualizarUIMic();
  };

  rec.onend = function () {
    micOuvir = false;
    if (textoPendenteVoz.trim() && !enviando && Date.now() >= pausaCapturaAte) {
      tentarEnviarFalaCapturada(true);
    }
    atualizarUIMic();
    if (deveManterEscuta()) {
      reiniciarEscuta(30);
    }
  };

  rec.onresult = function (ev) {
    if (escutaSilenciada) return;

    var interim = '';
    var textoFinal = '';
    var confiancaFinal = null;
    var alternativas = [];
    for (var i = ev.resultIndex; i < ev.results.length; i++) {
      var r = ev.results[i];
      if (r.isFinal) {
        var melhor = r[0].transcript;
        textoFinal += melhor;
        if (r[0].confidence != null) confiancaFinal = r[0].confidence;
        var alts = [];
        for (var k = 0; k < r.length; k++) {
          alts.push({ texto: r[k].transcript, confianca: r[k].confidence });
        }
        alternativas.push({ final: melhor, alternativas: alts });
      } else {
        interim += r[0].transcript;
      }
    }
    if (alternativas.length > 0) {
      ultimasAlternativasVoz = alternativas;
      ultimaConfiancaVoz = confiancaFinal;
    }

    if (enviando) {
      if (interim.trim() && professoraFalando) {
        interromperVozProfessora();
        setStatusProf('Te ouvindo...', false);
      }
      return;
    }

    if (Date.now() < pausaCapturaAte) return;

    var mostrarInterim =
      interim.trim() &&
      (!window.AudioFiltro || AudioFiltro.podeMostrarInterim()) &&
      (!window.AudioFiltro || !AudioFiltro.ehFraseRuido(interim.trim()));

    if (interim.trim()) {
      textoInterim = interim.trim();
      textoPendenteVoz = (bufferFinaisVoz + ' ' + textoInterim).trim();
      if (mostrarInterim) {
        mostrarLegenda('🎤 ' + textoPendenteVoz);
      }
      agendarEnvioPorSilencio();
    }

    if (textoFinal.trim()) {
      bufferFinaisVoz = (bufferFinaisVoz + ' ' + textoFinal).trim();
      textoPendenteVoz = bufferFinaisVoz;
      textoInterim = '';
      mostrarLegenda('🎤 ' + textoPendenteVoz);

      clearTimeout(debounceVoz);
      debounceVoz = setTimeout(function () {
        tentarEnviarFalaCapturada(false);
      }, 320);
      agendarEnvioPorSilencio();
    }
  };

  rec.onerror = function (ev) {
    if (ev.error === 'aborted') return;
    if (ev.error === 'no-speech') {
      if (textoPendenteVoz.trim() && !enviando) {
        tentarEnviarFalaCapturada(true);
      }
      if (deveManterEscuta()) reiniciarEscuta(60);
      return;
    }
    if (ev.error === 'not-allowed') {
      escutaSilenciada = true;
      mostrarErro('Microfone bloqueado. Permita o acesso nas configurações do navegador.', true);
      return;
    }
    if (ev.error === 'network') {
      mostrarErro('Reconhecimento de voz precisa de internet (Chrome).', true);
      if (deveManterEscuta()) reiniciarEscuta(350);
      return;
    }
    if (deveManterEscuta()) reiniciarEscuta(150);
  };
}

function criarInstanciaReconhecimento() {
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  var rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  // Sessões curtas são mais estáveis no Chrome/Edge; o onend reinicia a escuta.
  rec.continuous = false;
  rec.maxAlternatives = 5;
  vincularEventosReconhecimento(rec);
  return rec;
}

function recriarReconhecimentoVoz() {
  if (!escutaAutomatica || escutaSilenciada) return;
  if (textoPendenteVoz.trim() && !enviando) {
    tentarEnviarFalaCapturada(true);
  }
  cancelarReinicioEscuta();
  try {
    if (recognition) recognition.abort();
  } catch (e) {}
  micOuvir = false;
  recognition = criarInstanciaReconhecimento();
  falhasReinicioSeguidas = 0;
  if (sessaoAtiva) reiniciarEscuta(180);
}

function configurarReconhecimentoVoz() {
  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    escutaAutomatica = false;
    $('#btn-mic').attr('title', 'Use Chrome ou Edge para conversa por voz');
    return;
  }
  recognition = criarInstanciaReconhecimento();
}

function toggleMic() {
  if (!recognition) {
    mostrarErro('Use Chrome ou Edge para conversa por voz.');
    return;
  }
  escutaSilenciada = !escutaSilenciada;
  if (escutaSilenciada) {
    pararEscuta(true);
    setStatusProf('Microfone no mudo — clique no mic para falar', false);
  } else {
    setStatusProf('Pode falar — estou ouvindo', false);
    garantirEscutaAtiva();
  }
  atualizarUIMic();
}

function sairAula() {
  if (
    sessaoAtiva &&
    !window.confirm('Encerrar a aula e sair da sala?')
  ) {
    return;
  }
  if (sessaoId && sessaoAtiva) {
    $.ajax({ url: '/api/sessao/' + encodeURIComponent(sessaoId), method: 'DELETE' });
  }
  window.speechSynthesis && window.speechSynthesis.cancel();
  pararEscuta(true);
  pararVideoLipsync();
  pararWatchdogEscuta();
  cancelarReinicioEscuta();
  escutaAutomatica = false;
  if (window.AudioFiltro) AudioFiltro.parar();
  clearInterval(timerInterval);
  window.location.href = params.voltar;
}

function carregarConfig(callback) {
  $.get('/api/estagio/inferir', { unidade: aluno.unidadeAtual })
    .done(function (data) {
      aluno.estagioRecomendado = data.estagioRecomendado || inferirEstagioPorUnidade(aluno.unidadeAtual);
      if (!params.estagio) {
        aluno.estagioAtivo = aluno.estagioRecomendado;
      }
      if (data.professora) {
        var estRec = data.estagioRecomendado;
        PROFESSORAS[estRec] = Object.assign({}, PROFESSORAS[estRec], data.professora);
      }
      var estAtivo = aluno.estagioAtivo || data.estagioRecomendado;
      $.get('/api/professora/' + estAtivo).done(function (prof) {
        PROFESSORAS[estAtivo] = Object.assign({}, PROFESSORAS[estAtivo], prof);
        professora = PROFESSORAS[estAtivo];
      }).always(callback);
      return;
    })
    .fail(function () {
      aluno.estagioRecomendado = inferirEstagioPorUnidade(aluno.unidadeAtual);
      if (!params.estagio) aluno.estagioAtivo = aluno.estagioRecomendado;
      callback();
    });
}

function carregarStatusServidor() {
  $.get('/api/status')
    .done(function (data) {
      didLipsyncAtivo = false;
    })
    .fail(function () {
      didLipsyncAtivo = false;
    });
}

/**
 * Pede à Professora para reformular a última resposta com a frase correta em inglês.
 * Funciona como um "echo corretivo": injeta um pedido no histórico que força recast.
 */
function pedirRecast() {
  if (enviando || !sessaoAtiva) return;
  var $ultima = $('#chat-messages .msg-row.sofia').last();
  if (!$ultima.length) {
    mostrarErro('Ainda não há resposta da professora para reformular.', true);
    return;
  }
  $('#btn-nao-entendi').prop('disabled', true);
  enviarMensagem(
    'Please repeat your last reply more simply and show me the correct English phrase in single quotes. Use very short sentences.',
    { origemVoz: false }
  );
  setTimeout(function () { $('#btn-nao-entendi').prop('disabled', false); }, 3000);
}

$(document).ready(function () {
  lerParamsUrl();
  carregarStatusServidor();

  aluno = {
    nome: params.nome,
    alunoId: params.alunoId,
    unidadeAtual: params.unidade,
    estagioAtivo: params.estagio || null,
    estagioRecomendado: null,
  };

  if (params.estagio && PROFESSORAS[params.estagio]) {
    aluno.estagioAtivo = params.estagio;
    aluno.estagioRecomendado = params.estagio;
    aplicarTemaProfessora(params.estagio);
    prepararLobby();
  } else {
    carregarConfig(function () {
      aplicarTemaProfessora(aluno.estagioAtivo);
      prepararLobby();
    });
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = function () {
      window.speechSynthesis.getVoices();
    };
  }

  configurarReconhecimentoVoz();

  $('#btn-entrar-sala').on('click', entrarNaSala);
  $('#btn-enviar-texto').on('click', function () {
    enviarMensagem($('#chat-input').val());
  });
  $('#btn-nao-entendi').on('click', pedirRecast);
  $('#chat-input').on('keydown', function (e) {
    if (e.key === 'Enter') enviarMensagem($('#chat-input').val());
  });
  $('#btn-mic').on('click', toggleMic).addClass('active');
  $('#btn-mic').attr(
    'title',
    'Silenciar / ativar microfone (conversa contínua, com filtro de ruído)'
  );
  $('#btn-voz-prof').on('click', function () {
    vozProfAtiva = !vozProfAtiva;
    $(this).toggleClass('active', vozProfAtiva);
    if (!vozProfAtiva) window.speechSynthesis.cancel();
  });
  $('#btn-chat').on('click', function () {
    $('#painel-chat').toggleClass('oculto');
    $(this).toggleClass('active', !$('#painel-chat').hasClass('oculto'));
  });
  $('#btn-fechar-chat').on('click', function () {
    $('#painel-chat').addClass('oculto');
    $('#btn-chat').removeClass('active');
  });
  $('#btn-sair').on('click', sairAula);
  $('#btn-reconectar').on('click', function () {
    esconderErro();
    iniciarSessao();
  });
});
