/* Blockstead — Graphics settings panel (ES module).
 * Renders the Quality preset, render scale, per-effect overrides, adaptive
 * resolution, frame-rate readout and a cost summary into the Settings
 * screen's Graphics section. Strings are localized for every supported
 * locale (picked from navigator.languages, falling back to en-US).
 */
import { CATEGORIES, PRESETS, choosePreset, describe, presetTier, setOverride } from './gfx.js';

const L = {
  'en-US': {
    quality: 'Quality', auto: 'Auto (detected: {t})', renderScale: 'Render scale', fromPreset: 'From preset ({t})',
    adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
    postFailed: 'Post-processing is unavailable on this device, so ambient occlusion, bloom, colour grade and FXAA/SMAA are off.',
    presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
    cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
      reflections: 'Reflections', detail: 'Surface detail', particles: 'Particles', background: 'Scenery motion' },
    tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', plain: 'Plain', detailed: 'Detailed',
      static: 'Still', animated: 'Animated', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
    words: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion',
      bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing' }
  },
  'es-419': {
    quality: 'Calidad', auto: 'Automática (detectada: {t})', renderScale: 'Escala de renderizado', fromPreset: 'Del ajuste ({t})',
    adaptive: 'Resolución adaptable', showFps: 'Mostrar cuadros por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; la oclusión ambiental, el resplandor, la corrección de color y FXAA/SMAA están desactivados.',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Antialiasing',
      reflections: 'Reflejos', detail: 'Detalle de superficies', particles: 'Partículas', background: 'Movimiento del paisaje' },
    tiers: { off: 'No', on: 'Sí', low: 'Bajas', medium: 'Medias', high: 'Altas', plain: 'Simple', detailed: 'Detallado',
      static: 'Quieto', animated: 'Animado', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
    words: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoFull: 'oclusión ambiental completa',
      bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin antialiasing' }
  },
  'de-DE': {
    quality: 'Qualität', auto: 'Automatisch (erkannt: {t})', renderScale: 'Renderskalierung', fromPreset: 'Aus Voreinstellung ({t})',
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Umgebungsverdeckung, Bloom, Farbkorrektur und FXAA/SMAA sind aus.',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
      reflections: 'Spiegelungen', detail: 'Oberflächendetails', particles: 'Partikel', background: 'Landschaftsbewegung' },
    tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', plain: 'Schlicht', detailed: 'Detailliert',
      static: 'Ruhig', animated: 'Animiert', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
    words: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoFull: 'volle Umgebungsverdeckung',
      bloom: 'Bloom', reflections: 'Spiegelungen', noAA: 'keine Kantenglättung' }
  },
  'fr-FR': {
    quality: 'Qualité', auto: 'Auto (détectée : {t})', renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({t})',
    adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postFailed: 'Le post-traitement est indisponible sur cet appareil : occlusion ambiante, halo lumineux, étalonnage et FXAA/SMAA sont désactivés.',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
      reflections: 'Reflets', detail: 'Détail des surfaces', particles: 'Particules', background: 'Paysage animé' },
    tiers: { off: 'Non', on: 'Oui', low: 'Basses', medium: 'Moyennes', high: 'Hautes', plain: 'Simple', detailed: 'Détaillé',
      static: 'Immobile', animated: 'Animé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
    words: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoFull: 'occlusion ambiante complète',
      bloom: 'halo', reflections: 'reflets', noAA: 'sans anticrénelage' }
  },
  'pt-BR': {
    quality: 'Qualidade', auto: 'Automática (detectada: {t})', renderScale: 'Escala de renderização', fromPreset: 'Da predefinição ({t})',
    adaptive: 'Resolução adaptável', showFps: 'Mostrar taxa de quadros',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; oclusão ambiente, brilho, correção de cor e FXAA/SMAA estão desligados.',
    presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Antisserrilhamento',
      reflections: 'Reflexos', detail: 'Detalhe das superfícies', particles: 'Partículas', background: 'Movimento da paisagem' },
    tiers: { off: 'Desligado', on: 'Ligado', low: 'Baixas', medium: 'Médias', high: 'Altas', plain: 'Simples', detailed: 'Detalhado',
      static: 'Parado', animated: 'Animado', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
    words: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão ambiente', aoFull: 'oclusão ambiente completa',
      bloom: 'brilho', reflections: 'reflexos', noAA: 'sem antisserrilhamento' }
  },
  'it-IT': {
    quality: 'Qualità', auto: 'Automatica (rilevata: {t})', renderScale: 'Scala di rendering', fromPreset: 'Dal preset ({t})',
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra fotogrammi al secondo',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo: occlusione ambientale, bagliore, correzione colore e FXAA/SMAA sono disattivati.',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing',
      reflections: 'Riflessi', detail: 'Dettaglio superfici', particles: 'Particelle', background: 'Paesaggio animato' },
    tiers: { off: 'No', on: 'Sì', low: 'Basse', medium: 'Medie', high: 'Alte', plain: 'Semplice', detailed: 'Dettagliato',
      static: 'Fermo', animated: 'Animato', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
    words: { noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoFull: 'occlusione ambientale completa',
      bloom: 'bagliore', reflections: 'riflessi', noAA: 'senza antialiasing' }
  }
};
// Regional variants: only the words that differ.
L['en-GB'] = Object.assign({}, L['en-US'], {
  postFailed: 'Post-processing is unavailable on this device, so ambient occlusion, bloom, colour grade and FXAA/SMAA are off.',
  cats: Object.assign({}, L['en-US'].cats, { grade: 'Colour grade' })
});
L['es-ES'] = Object.assign({}, L['es-419'], {
  renderScale: 'Escala de renderizado', showFps: 'Mostrar fotogramas por segundo',
  cats: Object.assign({}, L['es-419'].cats, { antialias: 'Suavizado de bordes' }),
  words: Object.assign({}, L['es-419'].words, { noAA: 'sin suavizado de bordes' })
});
L['fr-CA'] = Object.assign({}, L['fr-FR'], {
  auto: 'Auto (détectée : {t})', showFps: 'Afficher la fréquence d’images',
  cats: Object.assign({}, L['fr-FR'].cats, { bloom: 'Éclat lumineux' }),
  words: Object.assign({}, L['fr-FR'].words, { bloom: 'éclat' })
});

export const LOCALES = Object.keys(L);

/** Best supported locale for a list of BCP-47 tags (exact, then language, then en-US). */
export function pickLocale(tags) {
  const list = (tags || []).filter(Boolean);
  for (const t of list) if (L[t]) return t;
  for (const t of list) {
    const lang = String(t).split('-')[0].toLowerCase();
    const region = String(t).split('-')[1] || '';
    if (lang === 'es') return /^(ES)$/i.test(region) || !region ? 'es-ES' : 'es-419';
    if (lang === 'fr') return /^CA$/i.test(region) ? 'fr-CA' : 'fr-FR';
    if (lang === 'en') return /^(GB|UK|IE|AU|NZ)$/i.test(region) ? 'en-GB' : 'en-US';
    const hit = LOCALES.find(k => k.split('-')[0] === lang);
    if (hit) return hit;
  }
  return 'en-US';
}

export function strings(locale) { return L[locale] || L['en-US']; }

/** StarHermit account strings (title sign-in / invite, toasts). `{name}` = display name. */
export const ACCOUNT_STRINGS = {
  "en-US": {
    "signIn": "Sign in with StarHermit",
    "invite": "Invite a friend",
    "inviteCopied": "Invite link copied to the clipboard.",
    "inviteFailed": "Could not copy the invite link.",
    "offline": "Offline — progress is stored on this device.",
    "playingAs": "Playing as {name}",
    "synced": "progress synced",
    "saving": "saving…",
    "syncOff": "cloud sync unavailable",
    "signedOut": "Signed out of StarHermit — progress stays on this device."
  },
  "en-GB": {
    "signIn": "Sign in with StarHermit",
    "invite": "Invite a friend",
    "inviteCopied": "Invite link copied to the clipboard.",
    "inviteFailed": "Could not copy the invite link.",
    "offline": "Offline — progress is stored on this device.",
    "playingAs": "Playing as {name}",
    "synced": "progress synced",
    "saving": "saving…",
    "syncOff": "cloud sync unavailable",
    "signedOut": "Signed out of StarHermit — progress stays on this device."
  },
  "es-419": {
    "signIn": "Iniciar sesión con StarHermit",
    "invite": "Invitar a un amigo",
    "inviteCopied": "Enlace de invitación copiado al portapapeles.",
    "inviteFailed": "No se pudo copiar el enlace de invitación.",
    "offline": "Sin conexión: el progreso se guarda en este dispositivo.",
    "playingAs": "Jugando como {name}",
    "synced": "progreso sincronizado",
    "saving": "guardando…",
    "syncOff": "sincronización en la nube no disponible",
    "signedOut": "Sesión de StarHermit cerrada: el progreso se queda en este dispositivo."
  },
  "es-ES": {
    "signIn": "Iniciar sesión con StarHermit",
    "invite": "Invitar a un amigo",
    "inviteCopied": "Enlace de invitación copiado en el portapapeles.",
    "inviteFailed": "No se pudo copiar el enlace de invitación.",
    "offline": "Sin conexión: el progreso se guarda en este dispositivo.",
    "playingAs": "Jugando como {name}",
    "synced": "progreso sincronizado",
    "saving": "guardando…",
    "syncOff": "sincronización en la nube no disponible",
    "signedOut": "Sesión de StarHermit cerrada: el progreso se queda en este dispositivo."
  },
  "de-DE": {
    "signIn": "Mit StarHermit anmelden",
    "invite": "Freund einladen",
    "inviteCopied": "Einladungslink in die Zwischenablage kopiert.",
    "inviteFailed": "Einladungslink konnte nicht kopiert werden.",
    "offline": "Offline – der Fortschritt wird auf diesem Gerät gespeichert.",
    "playingAs": "Du spielst als {name}",
    "synced": "Fortschritt synchronisiert",
    "saving": "wird gespeichert …",
    "syncOff": "Cloud-Synchronisierung nicht verfügbar",
    "signedOut": "Von StarHermit abgemeldet – der Fortschritt bleibt auf diesem Gerät."
  },
  "fr-FR": {
    "signIn": "Se connecter avec StarHermit",
    "invite": "Inviter un ami",
    "inviteCopied": "Lien d’invitation copié dans le presse-papiers.",
    "inviteFailed": "Impossible de copier le lien d’invitation.",
    "offline": "Hors ligne : la progression est enregistrée sur cet appareil.",
    "playingAs": "Vous jouez en tant que {name}",
    "synced": "progression synchronisée",
    "saving": "enregistrement…",
    "syncOff": "synchronisation cloud indisponible",
    "signedOut": "Déconnecté de StarHermit : la progression reste sur cet appareil."
  },
  "fr-CA": {
    "signIn": "Se connecter avec StarHermit",
    "invite": "Inviter un ami",
    "inviteCopied": "Lien d’invitation copié dans le presse-papiers.",
    "inviteFailed": "Impossible de copier le lien d’invitation.",
    "offline": "Hors ligne : la progression est enregistrée sur cet appareil.",
    "playingAs": "Vous jouez en tant que {name}",
    "synced": "progression synchronisée",
    "saving": "enregistrement…",
    "syncOff": "synchronisation infonuagique indisponible",
    "signedOut": "Déconnecté de StarHermit : la progression reste sur cet appareil."
  },
  "pt-BR": {
    "signIn": "Entrar com a StarHermit",
    "invite": "Convidar um amigo",
    "inviteCopied": "Link de convite copiado para a área de transferência.",
    "inviteFailed": "Não foi possível copiar o link de convite.",
    "offline": "Offline — o progresso fica salvo neste dispositivo.",
    "playingAs": "Jogando como {name}",
    "synced": "progresso sincronizado",
    "saving": "salvando…",
    "syncOff": "sincronização na nuvem indisponível",
    "signedOut": "Você saiu da StarHermit — o progresso continua neste dispositivo."
  },
  "it-IT": {
    "signIn": "Accedi con StarHermit",
    "invite": "Invita un amico",
    "inviteCopied": "Link di invito copiato negli appunti.",
    "inviteFailed": "Impossibile copiare il link di invito.",
    "offline": "Offline: i progressi sono salvati su questo dispositivo.",
    "playingAs": "Stai giocando come {name}",
    "synced": "progressi sincronizzati",
    "saving": "salvataggio…",
    "syncOff": "sincronizzazione cloud non disponibile",
    "signedOut": "Disconnesso da StarHermit: i progressi restano su questo dispositivo."
  }
};
export function accountStrings(locale) { return ACCOUNT_STRINGS[locale] || ACCOUNT_STRINGS['en-US']; }

/**
 * Mount the panel. `api`: { get(): savedGfx, set(savedGfx), info(): renderer.graphicsInfo() | null }.
 */
export function mountGraphicsPanel(root, api) {
  const S = strings(pickLocale(typeof navigator !== 'undefined' ? (navigator.languages || [navigator.language]) : []));
  root.textContent = '';
  root.classList.add('gfx-panel');
  const el = (tag, props, text) => {
    const e = document.createElement(tag);
    if (props) Object.assign(e, props);
    if (text != null) e.textContent = text;
    return e;
  };
  const row = (labelText, input, extra) => {
    const label = el('label', { className: 'gfx-row' });
    label.appendChild(el('span', { className: 'gfx-label' }, labelText));
    const wrap = el('span', { className: 'gfx-control' });
    wrap.appendChild(input);
    if (extra) wrap.appendChild(extra);
    label.appendChild(wrap);
    root.appendChild(label);
    return label;
  };

  const info0 = api.info() || { detected: 'low' };
  const presetSel = el('select', { id: 'gfx-preset' });
  presetSel.dataset.gfx = 'preset';
  presetSel.appendChild(el('option', { value: 'auto' }, S.auto.replace('{t}', S.presets[info0.detected] || info0.detected)));
  PRESETS.forEach(p => presetSel.appendChild(el('option', { value: p }, S.presets[p])));
  row(S.quality, presetSel);

  const scale = el('input', { id: 'gfx-scale', type: 'range', min: 50, max: 200, step: 5 });
  scale.dataset.gfx = 'render_scale';
  const scaleOut = el('output', { id: 'gfx-scale-value', className: 'gfx-out' });
  scale.setAttribute('aria-describedby', 'gfx-scale-value');
  row(S.renderScale, scale, scaleOut);

  const catSel = {};
  Object.keys(CATEGORIES).forEach(cat => {
    const sel = el('select', { id: 'gfx-' + cat });
    sel.dataset.gfx = cat;
    catSel[cat] = sel;
    row(S.cats[cat], sel);
  });

  const adaptive = el('input', { id: 'gfx-adaptive', type: 'checkbox' });
  row(S.adaptive, adaptive);
  const showFps = el('input', { id: 'gfx-fps', type: 'checkbox' });
  row(S.showFps, showFps);

  const summary = el('p', { id: 'gfx-summary', className: 'gfx-summary mini' });
  summary.setAttribute('aria-live', 'polite');
  root.appendChild(summary);
  const note = el('p', { id: 'gfx-post-note', className: 'gfx-note mini', hidden: true }, S.postFailed);
  root.appendChild(note);

  function sync() {
    const saved = api.get() || {};
    const info = api.info();
    const r = info ? info.resolved : null;
    presetSel.value = PRESETS.includes(saved.preset) ? saved.preset : 'auto';
    const pct = Math.round((Number(saved.render_scale) || 1) * 100);
    scale.value = pct;
    scaleOut.textContent = pct + '%';
    const effPreset = r ? r.preset : (PRESETS.includes(saved.preset) ? saved.preset : 'balanced');
    Object.keys(CATEGORIES).forEach(cat => {
      const sel = catSel[cat];
      sel.textContent = '';
      const pt = presetTier(effPreset, cat);
      sel.appendChild(el('option', { value: 'preset' }, S.fromPreset.replace('{t}', S.tiers[pt] || pt)));
      CATEGORIES[cat].forEach(t => sel.appendChild(el('option', { value: t }, S.tiers[t] || t)));
      sel.value = CATEGORIES[cat].includes(saved[cat]) ? saved[cat] : 'preset';
    });
    adaptive.checked = saved.adaptive !== false;
    showFps.checked = !!saved.show_fps;
    if (info) {
      const px = info.summary.match(/(\d+×\d+ px)$/);
      summary.textContent = [info.gpu, describe(info.resolved, null, S.words), px ? px[1] : null].filter(Boolean).join(' · ');
      note.hidden = !info.postFailed;
    } else {
      summary.textContent = '';
    }
  }

  function commit(next) { api.set(next); sync(); requestAnimationFrame(() => requestAnimationFrame(sync)); }
  presetSel.addEventListener('change', () => commit(choosePreset(api.get(), presetSel.value)));
  scale.addEventListener('input', () => { scaleOut.textContent = scale.value + '%'; });
  scale.addEventListener('change', () => commit(Object.assign({}, api.get(), { render_scale: Number(scale.value) / 100 })));
  Object.keys(catSel).forEach(cat => {
    catSel[cat].addEventListener('change', () => commit(setOverride(api.get(), cat, catSel[cat].value)));
  });
  adaptive.addEventListener('change', () => commit(Object.assign({}, api.get(), { adaptive: adaptive.checked })));
  showFps.addEventListener('change', () => commit(Object.assign({}, api.get(), { show_fps: showFps.checked })));

  sync();
  // pixel size settles a frame after a change; refresh the summary once more
  requestAnimationFrame(() => requestAnimationFrame(sync));
  return { sync };
}
