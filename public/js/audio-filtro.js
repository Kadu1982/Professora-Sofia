'use strict';

/**
 * Filtro de ruído no microfone: constraints do navegador + Web Audio (high-pass,
 * compressor) + VAD simples para ignorar sons de fundo antes do STT.
 */
(function (global) {
  var stream = null;
  var context = null;
  var analyser = null;
  var rafId = null;
  var ativo = false;

  var rmsAtual = 0;
  var limiarRuido = 0.018;
  var limiarFala = 0.045;
  var framesAcima = 0;
  var framesAbaixo = 0;
  var falandoAgora = false;
  var ultimoInstanteVoz = 0;
  var amostrasCalibracao = [];

  var FRASES_RUIDO = [
    /inscreva/i,
    /legenda[s]?\s*(por)?/i,
    /m[uú]sica de fundo/i,
    /aproveite e se inscreva/i,
    /clique no sininho/i,
    /ativar notifica/i,
  ];

  var SOMENTE_RUIDO = /^(\s*(ah|ahm|hm|hum|uh|é|eh|ã|hã|ahn)\s*[.!,]?)+$/i;

  function calcularRms(data) {
    var sum = 0;
    for (var i = 0; i < data.length; i++) {
      var v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  function loopAnalise() {
    if (!analyser || !ativo) return;
    var buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    rmsAtual = calcularRms(buf);

    if (amostrasCalibracao.length < 120) {
      amostrasCalibracao.push(rmsAtual);
    }

    if (rmsAtual > limiarFala) {
      framesAcima++;
      framesAbaixo = 0;
      if (framesAcima >= 3) {
        falandoAgora = true;
        ultimoInstanteVoz = Date.now();
      }
    } else if (rmsAtual < limiarRuido * 1.35) {
      framesAbaixo++;
      framesAcima = 0;
      if (framesAbaixo >= 12) {
        falandoAgora = false;
      }
    }

    rafId = global.requestAnimationFrame(loopAnalise);
  }

  function aplicarLimiarCalibrado() {
    if (!amostrasCalibracao.length) return;
    var ordenado = amostrasCalibracao.slice().sort(function (a, b) {
      return a - b;
    });
    var p50 = ordenado[Math.floor(ordenado.length * 0.5)] || 0.012;
    var p75 = ordenado[Math.floor(ordenado.length * 0.75)] || p50;
    limiarRuido = Math.max(0.01, Math.min(0.1, p75 * 1.4));
    limiarFala = Math.max(limiarRuido * 1.8, Math.min(0.16, p50 * 2.8));
  }

  var AudioFiltro = {
    iniciar: function () {
      if (!global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia) {
        return Promise.resolve(false);
      }
      if (ativo && stream) return Promise.resolve(true);

      var audioOpts = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      };
      if (typeof audioOpts.sampleRate === 'undefined') {
        try {
          audioOpts.sampleRate = 48000;
        } catch (e) {}
      }

      return global.navigator.mediaDevices
        .getUserMedia({ audio: audioOpts })
        .then(function (s) {
          stream = s;
          var AC = global.AudioContext || global.webkitAudioContext;
          if (!AC) {
            ativo = true;
            return true;
          }
          context = new AC();
          var source = context.createMediaStreamSource(stream);
          var highpass = context.createBiquadFilter();
          highpass.type = 'highpass';
          highpass.frequency.value = 110;
          highpass.Q.value = 0.7;

          var compressor = context.createDynamicsCompressor();
          compressor.threshold.value = -42;
          compressor.knee.value = 12;
          compressor.ratio.value = 8;
          compressor.attack.value = 0.003;
          compressor.release.value = 0.15;

          analyser = context.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.65;

          source.connect(highpass);
          highpass.connect(compressor);
          compressor.connect(analyser);

          if (context.state === 'suspended') {
            context.resume().catch(function () {});
          }

          ativo = true;
          amostrasCalibracao = [];
          if (rafId) global.cancelAnimationFrame(rafId);
          loopAnalise();
          return true;
        });
    },

    parar: function () {
      ativo = false;
      if (rafId) {
        global.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (stream) {
        stream.getTracks().forEach(function (t) {
          t.stop();
        });
        stream = null;
      }
      if (context) {
        context.close().catch(function () {});
        context = null;
      }
      analyser = null;
      falandoAgora = false;
      amostrasCalibracao = [];
    },

    calibrarRuidoAmbiente: function (ms) {
      var duracao = typeof ms === 'number' ? ms : 2200;
      amostrasCalibracao = [];
      return new Promise(function (resolve) {
        setTimeout(function () {
          aplicarLimiarCalibrado();
          resolve({
            limiarRuido: limiarRuido,
            limiarFala: limiarFala,
          });
        }, duracao);
      });
    },

    reanudar: function () {
      if (!context) return Promise.resolve();
      if (context.state === 'suspended') return context.resume();
      return Promise.resolve();
    },

    detectouVozRecente: function (janelaMs) {
      var janela = typeof janelaMs === 'number' ? janelaMs : 700;
      return falandoAgora || Date.now() - ultimoInstanteVoz < janela;
    },

    /** Legendas: o STT já ouviu; VAD só evita ruído óbvio na UI */
    podeMostrarInterim: function () {
      return true;
    },

    ehFraseRuido: function (texto) {
      var t = String(texto || '').trim();
      if (!t) return true;
      if (t.length < 2) return true;
      if (SOMENTE_RUIDO.test(t)) return true;
      for (var i = 0; i < FRASES_RUIDO.length; i++) {
        if (FRASES_RUIDO[i].test(t)) return true;
      }
      return false;
    },

    /**
     * Aula ao vivo: envia o que o STT captou; a professora (LLM) corrige verbalização errada.
     * Só bloqueia ruído óbvio (TV, "ah hm"), não exige fala "perfeita".
     */
    aceitarTranscricao: function (texto, confianca) {
      var t = String(texto || '').trim();
      if (!t || this.ehFraseRuido(t)) return false;
      return t.length >= 2;
    },

    nivelRms: function () {
      return rmsAtual;
    },

    estaAtivo: function () {
      return ativo;
    },
  };

  global.AudioFiltro = AudioFiltro;
})(window);
