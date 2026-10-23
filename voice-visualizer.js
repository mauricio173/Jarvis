/*!
 * voice-visualizer.js — Visualizador de frequências sonoras para o <canvas id="core">
 * Anel radial de barras + onda circular + brilho pulsante, no estilo JARVIS.
 *
 * USO RÁPIDO
 *   const viz = createVoiceVisualizer(document.getElementById('core'));
 *   viz.setSpeaking(true);   // assistente começou a falar
 *   viz.setSpeaking(false);  // terminou
 *
 * ÁUDIO REAL (elemento <audio>, MediaStream ou AudioNode):
 *   viz.connectAudio(audioElement);
 *   Obs.: createMediaElementSource só pode ser chamado 1x por elemento.
 *
 * speechSynthesis (voz do navegador) NÃO expõe o áudio ao Web Audio,
 * então o módulo simula o espectro, sincronizado com os eventos da fala:
 *   viz.speakWith(utterance);  // antes de speechSynthesis.speak(utterance)
 *
 * SE O SEU APP JÁ TEM UM LOOP DE DESENHO NO CANVAS:
 *   const viz = createVoiceVisualizer(canvas, { standalone: false });
 *   // no seu loop, depois de desenhar o núcleo:
 *   viz.draw(performance.now());
 */
(function (global) {
  'use strict';
  var TAU = Math.PI * 2;

  function createVoiceVisualizer(canvas, options) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var o = Object.assign({
      color: '#00e5ff',        // cor principal
      accent: '#a8f6ff',       // cor do brilho/ponta das barras
      bars: 96,                // nº de barras no anel (par)
      innerRadius: Math.min(W, H) * 0.30,
      maxBar: Math.min(W, H) * 0.17,
      standalone: true,        // true = o módulo limpa e anima o canvas sozinho
      reducedMotion: global.matchMedia &&
        global.matchMedia('(prefers-reduced-motion: reduce)').matches
    }, options || {});

    var cx = W / 2, cy = H / 2;
    var speaking = false;
    var env = 0;              // envelope suave (0..1) de "está falando"
    var kick = 0;             // impulso extra (palavras / sílabas)
    var smooth = new Float32Array(o.bars);
    var analyser = null, freqData = null, timeData = null, audioCtx = null;
    var rafId = 0, last = 0, running = false;

    /* ---------- Entrada de áudio real ---------- */
    function connectAudio(source, existingCtx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      audioCtx = existingCtx || audioCtx || new AC();
      var node = source;
      if (source instanceof global.HTMLMediaElement) {
        node = audioCtx.createMediaElementSource(source);
        node.connect(audioCtx.destination); // mantém o som audível
      } else if (global.MediaStream && source instanceof global.MediaStream) {
        node = audioCtx.createMediaStreamSource(source);
      }
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.78;
      node.connect(analyser);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Uint8Array(analyser.fftSize);
      return true;
    }

    function disconnectAudio() { analyser = null; freqData = timeData = null; }

    /* ---------- Controle de estado ---------- */
    function setSpeaking(v) {
      speaking = !!v;
      if (speaking && audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      if (o.standalone) start();
    }

    function pulse(strength) { kick = Math.min(1, kick + (strength == null ? 0.6 : strength)); }

    function speakWith(utt) {
      var prevStart = utt.onstart, prevEnd = utt.onend, prevErr = utt.onerror, prevB = utt.onboundary;
      utt.onstart = function (e) { setSpeaking(true); prevStart && prevStart.call(utt, e); };
      utt.onboundary = function (e) { pulse(0.55); prevB && prevB.call(utt, e); };
      utt.onend = function (e) { setSpeaking(false); prevEnd && prevEnd.call(utt, e); };
      utt.onerror = function (e) { setSpeaking(false); prevErr && prevErr.call(utt, e); };
    }

    /* ---------- Espectro ---------- */
    // Preenche `smooth` com valores 0..1, simétricos (espelhado esquerda/direita).
    function updateBins(t, dt) {
      var n = o.bars, half = n / 2, i, v;
      var useReal = analyser && freqData;
      if (useReal) analyser.getByteFrequencyData(freqData);

      for (i = 0; i < half; i++) {
        var p = i / (half - 1); // 0 = graves, 1 = agudos
        if (useReal) {
          // faixa útil da voz (~80 Hz – 6 kHz), escala quase logarítmica
          var idx = Math.floor(Math.pow(p, 1.6) * freqData.length * 0.55) + 1;
          v = freqData[idx] / 255;
        } else {
          // Simulação "silábica": ~4-6 Hz de modulação + harmônicos por banda
          var syl = 0.55 + 0.45 * Math.sin(t * 0.0052 + Math.sin(t * 0.0013) * 2);
          var band = Math.abs(Math.sin(t * (0.004 + p * 0.011) + i * 0.83)) *
                     (0.6 + 0.4 * Math.sin(t * 0.0021 + i * 1.7));
          var tilt = 1 - p * 0.55; // voz tem mais energia nos graves/médios
          v = (0.18 + band * 0.82) * syl * tilt;
        }
        v = Math.min(1, v * (0.75 + kick * 0.5)) * env;
        var k = v > smooth[i] ? 0.45 : 0.14; // ataque rápido, queda suave
        smooth[i] += (v - smooth[i]) * k;
        smooth[n - 1 - i] = smooth[i]; // espelho
      }
    }

    /* ---------- Desenho ---------- */
    function draw(now) {
      var dt = Math.min(64, now - (draw._t || now)); draw._t = now;
      var target = speaking ? 1 : 0;
      env += (target - env) * (target > env ? 0.18 : 0.05);
      kick *= 0.9;
      if (env < 0.004 && !speaking) {
        if (env !== 0) { env = 0; smooth.fill(0); }
        return false; // nada a desenhar (ocioso)
      }
      updateBins(now, dt);

      var n = o.bars, r0 = o.innerRadius, i, a, h, v;
      var avg = 0; for (i = 0; i < n; i++) avg += smooth[i]; avg /= n;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      // 1) halo pulsante
      var haloR = r0 + o.maxBar * (0.5 + avg * 0.9);
      var g = ctx.createRadialGradient(0, 0, r0 * 0.6, 0, 0, haloR);
      g.addColorStop(0, 'rgba(0,229,255,0)');
      g.addColorStop(0.7, 'rgba(0,229,255,' + (0.05 + avg * 0.22).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(0,229,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, haloR, 0, TAU); ctx.fill();

      // 2) barras radiais (externas fortes, internas curtas)
      var rot = now * 0.00006 * (0.4 + env);
      ctx.shadowColor = o.color;
      ctx.shadowBlur = o.reducedMotion ? 0 : 14;
      ctx.strokeStyle = o.color;
      ctx.globalAlpha = 0.55 + 0.45 * env;
      ctx.lineWidth = Math.max(2, (TAU * r0) / n * 0.5);
      ctx.beginPath();
      for (i = 0; i < n; i++) {
        v = smooth[i]; a = (i / n) * TAU - Math.PI / 2 + rot;
        h = 3 + v * o.maxBar;
        var cs = Math.cos(a), sn = Math.sin(a);
        ctx.moveTo(cs * (r0 + 4), sn * (r0 + 4));
        ctx.lineTo(cs * (r0 + 4 + h), sn * (r0 + 4 + h));
      }
      ctx.stroke();

      ctx.strokeStyle = o.accent; ctx.shadowBlur = 0; ctx.globalAlpha = 0.5 * env;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (i = 0; i < n; i++) {
        v = smooth[i]; a = (i / n) * TAU - Math.PI / 2 + rot;
        h = 2 + v * o.maxBar * 0.35;
        ctx.moveTo(Math.cos(a) * (r0 - 4), Math.sin(a) * (r0 - 4));
        ctx.lineTo(Math.cos(a) * (r0 - 4 - h), Math.sin(a) * (r0 - 4 - h));
      }
      ctx.stroke();

      // 3) onda circular (forma de onda no domínio do tempo, ou simulada)
      var wr = r0 - o.maxBar * 0.45, steps = 180;
      if (analyser && timeData) analyser.getByteTimeDomainData(timeData);
      ctx.globalAlpha = 0.9 * env;
      ctx.strokeStyle = o.accent;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = o.accent; ctx.shadowBlur = o.reducedMotion ? 0 : 8;
      ctx.beginPath();
      for (i = 0; i <= steps; i++) {
        var u = i / steps; a = u * TAU - Math.PI / 2;
        var w;
        if (analyser && timeData) {
          w = (timeData[Math.floor(u * (timeData.length - 1))] - 128) / 128;
        } else {
          w = Math.sin(u * TAU * 5 + now * 0.007) * 0.5 +
              Math.sin(u * TAU * 11 - now * 0.011) * 0.3 +
              Math.sin(u * TAU * 3 + now * 0.004) * 0.2;
        }
        var rr = wr + w * (4 + avg * o.maxBar * 0.7) * env;
        var x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.stroke();

      ctx.restore();
      return true;
    }

    /* ---------- Loop próprio (modo standalone) ---------- */
    function frame(now) {
      if (!running) return;
      ctx.clearRect(0, 0, W, H);
      var drew = draw(now);
      if (!drew && !speaking) { running = false; return; }
      rafId = global.requestAnimationFrame(frame);
    }
    function start() {
      if (running) return;
      running = true; rafId = global.requestAnimationFrame(frame);
    }
    function stop() { running = false; global.cancelAnimationFrame(rafId); ctx.clearRect(0, 0, W, H); }

    return {
      setSpeaking: setSpeaking, pulse: pulse, speakWith: speakWith,
      connectAudio: connectAudio, disconnectAudio: disconnectAudio,
      draw: draw, start: start, stop: stop,
      get speaking() { return speaking; }
    };
  }

  global.createVoiceVisualizer = createVoiceVisualizer;
  if (typeof module !== 'undefined' && module.exports) module.exports = createVoiceVisualizer;
})(typeof window !== 'undefined' ? window : this);