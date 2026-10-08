'use strict';

/**
 * Règles d'évaluation d'un poste.
 *
 * Centralisées ici pour que le tableau de bord, les futures notifications et
 * l'API disent tous exactement la même chose. Chaque anomalie porte un code
 * stable, un libellé lisible et un niveau de gravité.
 */

const SEVERITY_RANK = { ok: 0, info: 1, warning: 2, critical: 3 };

const SEUILS = {
  diskCriticalPercent: 95,
  diskWarningPercent: 85,
  diskCriticalFreeBytes: 5 * 1024 ** 3,
  ramCriticalPercent: 95,
  ramWarningPercent: 88,
  cpuWarningPercent: 92,
  batteryLowPercent: 20,
  signatureStaleDays: 7,
  uptimeStaleDays: 30,
};

/** Virgule décimale : ces chaînes sont affichées telles quelles dans l'interface. */
function nb(v) {
  if (v === null || v === undefined) return '—';
  return String(Math.round(Number(v) * 10) / 10).replace('.', ',');
}

function formatBytes(n) {
  if (n === null || n === undefined) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}

/**
 * @param {object} payload   dernier rapport envoyé par l'agent
 * @param {number} lastSeen  horodatage de réception, en millisecondes
 * @param {object} config    { offlineAfterMinutes, vpnRequired }
 * @param {number} [now]     instant d'évaluation. Paramètre explicite plutôt
 *                           que Date.now() en dur : sans lui, impossible de
 *                           tester la détection d'un poste muet sans attendre
 *                           réellement douze minutes.
 */
function evaluateMachine(payload, lastSeen, config = {}, now = Date.now()) {
  const issues = [];
  const add = (severity, code, label, detail) => issues.push({ severity, code, label, detail });

  const offlineAfter = (config.offlineAfterMinutes ?? 12) * 60000;
  const silentFor = now - lastSeen;
  const offline = silentFor > offlineAfter;

  if (offline) {
    const minutes = Math.round(silentFor / 60000);
    const human = minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
    add('critical', 'offline', 'Hors ligne', `Aucun signe de vie depuis ${human}`);
    // Un poste muet rend toutes les autres mesures périmées : on s'arrête là.
    return { status: 'critical', offline: true, issues, silentForMs: silentFor };
  }

  // -- Stockage
  for (const v of payload.disk?.volumes || []) {
    const pct = v.usedPercent ?? 0;
    const free = v.freeBytes ?? 0;
    if (pct >= SEUILS.diskCriticalPercent || free < SEUILS.diskCriticalFreeBytes) {
      add('critical', 'disk-full', `Disque ${v.drive} presque plein`,
        `${formatBytes(free)} libres sur ${formatBytes(v.totalBytes)} (${nb(pct)} % utilisés)`);
    } else if (pct >= SEUILS.diskWarningPercent) {
      add('warning', 'disk-low', `Disque ${v.drive} se remplit`,
        `${formatBytes(free)} libres (${nb(pct)} % utilisés)`);
    }
  }
  for (const d of payload.disk?.physical || []) {
    if (d.healthStatus && !/healthy|sain/i.test(d.healthStatus)) {
      add('critical', 'disk-health', 'Disque physique en défaut',
        `${d.name} : état « ${d.healthStatus} »`);
    }
  }

  // -- Mémoire et processeur
  const ram = payload.memory?.usedPercent;
  if (ram != null) {
    if (ram >= SEUILS.ramCriticalPercent) {
      add('critical', 'ram-full', 'Mémoire saturée', `${nb(ram)} % de la RAM utilisée`);
    } else if (ram >= SEUILS.ramWarningPercent) {
      add('warning', 'ram-high', 'Mémoire très sollicitée', `${nb(ram)} % de la RAM utilisée`);
    }
  }
  const cpu = payload.cpu?.loadPercent;
  if (cpu != null && cpu >= SEUILS.cpuWarningPercent) {
    add('warning', 'cpu-high', 'Processeur saturé', `${nb(cpu)} % de charge au dernier relevé`);
  }

  // -- Réseau et VPN
  if (config.vpnRequired && !payload.vpn?.connected) {
    add('warning', 'vpn-off', 'VPN déconnecté', 'Aucun tunnel actif détecté sur ce poste');
  }

  // -- Sécurité
  const av = payload.security?.antivirus || [];
  if (av.length > 0 && !av.some((p) => p.realTime)) {
    add('critical', 'av-off', 'Antivirus inactif',
      `Aucune protection en temps réel : ${av.map((p) => p.name).join(', ')}`);
  }
  const outdated = av.filter((p) => p.realTime && !p.upToDate);
  if (outdated.length > 0) {
    add('warning', 'av-stale', 'Antivirus non à jour',
      `Signatures obsolètes : ${outdated.map((p) => p.name).join(', ')}`);
  }
  const sigAge = payload.security?.defender?.signatureAgeDays;
  const defenderActive = payload.security?.defender?.realTimeProtection;
  if (defenderActive && sigAge != null && sigAge > SEUILS.signatureStaleDays) {
    add('warning', 'defender-stale', 'Signatures Defender anciennes', `${sigAge} jours`);
  }

  const offProfiles = (payload.security?.firewall || []).filter((p) => !p.enabled);
  if (offProfiles.length > 0) {
    add('warning', 'firewall-off', 'Pare-feu désactivé',
      `Profils concernés : ${offProfiles.map((p) => p.name).join(', ')}`);
  }

  if (payload.rebootPending) {
    add('info', 'reboot-pending', 'Redémarrage en attente',
      'Des mises à jour ne seront actives qu’après un redémarrage');
  }

  const uptimeDays = (payload.system?.uptimeSeconds ?? 0) / 86400;
  if (uptimeDays > SEUILS.uptimeStaleDays) {
    add('info', 'uptime-long', 'Poste jamais redémarré',
      `Allumé depuis ${Math.round(uptimeDays)} jours`);
  }

  // -- Batterie
  const bat = payload.battery;
  if (bat && !bat.onAc && bat.percent != null && bat.percent <= SEUILS.batteryLowPercent) {
    add('info', 'battery-low', 'Batterie faible', `${bat.percent} % restants, sur batterie`);
  }

  const status = issues.reduce(
    (worst, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[worst] ? i.severity : worst),
    'ok'
  );

  // Les anomalies les plus graves d'abord : le tableau de bord les affiche dans l'ordre.
  issues.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  return { status, offline: false, issues, silentForMs: silentFor };
}

module.exports = { evaluateMachine, formatBytes, nb, SEUILS, SEVERITY_RANK };
