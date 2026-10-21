'use strict';

/**
 * Lance le serveur en local, pour développer.
 *
 *   node scripts/dev.js
 *
 * Le serveur refuse de démarrer sans API_KEY ni DASH_PASS — c'est voulu, un
 * serveur de collecte sans clé est un serveur ouvert. Mais en développement on
 * relance dix fois par jour, et retaper deux secrets à chaque fois finit par
 * donner envie de les mettre dans l'historique du shell. Ce lanceur les lit
 * donc dans server/.env (ignoré par git), et les fabrique au premier
 * démarrage s'ils manquent.
 *
 * Ce fichier ne sert qu'au développement : en production, les secrets viennent
 * de l'unité systemd (voir deploy/install-serveur.sh), jamais d'un .env généré.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RACINE = path.join(__dirname, '..');
const ENV_PATH = path.join(RACINE, '.env');

// Valeurs de développement : la base de démonstration déjà peuplée, un port
// qui ne risque pas de croiser autre chose, et une écoute sur la boucle
// locale uniquement — inutile d'exposer un serveur de test au réseau.
const DEFAUTS = {
  PORT: '8099',
  HOST: '127.0.0.1',
  DB_PATH: path.join(RACINE, 'data', 'demo.db'),
};

function lireEnv(fichier) {
  if (!fs.existsSync(fichier)) return {};
  const out = {};
  for (const ligne of fs.readFileSync(fichier, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(ligne);
    if (!m) continue;                                   // commentaire ou vide
    out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

const secret = () => crypto.randomBytes(24).toString('base64url');

const env = lireEnv(ENV_PATH);
const crees = [];

for (const cle of ['API_KEY', 'DASH_PASS']) {
  if (!env[cle]) { env[cle] = secret(); crees.push(cle); }
}

if (crees.length) {
  // On réécrit le fichier entier plutôt que d'ajouter à la suite : deux
  // affectations de la même clé, et c'est la dernière qui gagne — une
  // incohérence qu'on ne verrait qu'au prochain 401.
  const lignes = [
    '# Secrets du serveur de développement, générés par scripts/dev.js.',
    '# Ignoré par git. Ne sert jamais en production.',
    '#',
    '# API_KEY doit être la même que celle des agents installés : si tu la',
    '# changes, chaque agent recevra un 401 — sa file d’attente est',
    '# conservée, mais plus rien n’arrive au tableau de bord.',
    '',
    `API_KEY=${env.API_KEY}`,
    `DASH_PASS=${env.DASH_PASS}`,
    '',
  ];
  for (const [k, v] of Object.entries(env)) {
    if (k !== 'API_KEY' && k !== 'DASH_PASS') lignes.splice(-1, 0, `${k}=${v}`);
  }
  fs.writeFileSync(ENV_PATH, lignes.join('\n'), { encoding: 'utf8' });
  console.log(`[dev] ${crees.join(' et ')} généré(s) dans server/.env`);
}

for (const [cle, valeur] of Object.entries({ ...DEFAUTS, ...env })) {
  // La ligne de commande reste prioritaire : PORT=9000 node scripts/dev.js
  if (process.env[cle] === undefined || process.env[cle] === '') process.env[cle] = valeur;
}

console.log(`[dev] base    : ${process.env.DB_PATH}`);
console.log(`[dev] adresse : http://127.0.0.1:${process.env.PORT}/`);
console.log('[dev] mot de passe du tableau de bord : voir DASH_PASS dans server/.env');

require(path.join(RACINE, 'server.js'));
