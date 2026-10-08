'use strict';

/**
 * Remise en forme des rapports reçus des agents.
 *
 * PowerShell déballe les tableaux d'un seul élément : un poste avec un seul
 * disque envoie `disk.volumes` sous forme d'objet, pas de tableau. L'agent
 * corrige cela de son côté, mais le serveur ne peut pas faire confiance à la
 * version d'agent installée sur chaque poste — et un rapport mal formé ne doit
 * jamais faire tomber le tableau de bord entier.
 */

/** Toujours renvoyer un tableau, quelle que soit la forme reçue. */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

const ARRAY_PATHS = [
  ['disk', 'volumes'],
  ['disk', 'physical'],
  ['network', 'interfaces'],
  ['gpu', 'adapters'],
  ['vpn', 'details'],
  ['security', 'antivirus'],
  ['security', 'firewall'],
  ['security', 'bitlocker'],
  ['security', 'vpnProfiles'],
];

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};

  for (const segments of ARRAY_PATHS) {
    let node = payload;
    for (let i = 0; i < segments.length - 1; i += 1) {
      node = node?.[segments[i]];
      if (!node || typeof node !== 'object') break;
    }
    if (!node || typeof node !== 'object') continue;
    const leaf = segments[segments.length - 1];
    if (leaf in node) node[leaf] = asArray(node[leaf]);
  }

  // Un poste avec une seule IP, une seule passerelle ou un seul DNS tombe
  // dans le même piège, un niveau plus bas.
  for (const iface of asArray(payload.network?.interfaces)) {
    if (!iface || typeof iface !== 'object') continue;
    for (const field of ['ipv4', 'gateway', 'dns']) {
      if (field in iface) iface[field] = asArray(iface[field]).filter(Boolean);
    }
  }

  return payload;
}

module.exports = { normalizePayload, asArray };
