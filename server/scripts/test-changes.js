'use strict';

/**
 * Vérifie la détection des changements durables.
 *
 *   node scripts/test-changes.js
 *
 * Les cas où il ne faut RIEN signaler comptent autant que les autres : un
 * journal qui s'agite à chaque relevé ne sera jamais lu.
 */

const { detecterChangements } = require('../lib/changes');

const GO = 1024 ** 3;

function poste(over = {}) {
  return {
    system: {
      manufacturer: 'Dell Inc.', model: 'Latitude 5550', serial: 'D42LY84',
      osName: 'Microsoft Windows 11 Professionnel', osDisplayVersion: '25H2',
      osBuild: '26200', loggedUser: 'SONES\\matheo', domain: 'sones.int',
      uptimeSeconds: 3600,
      ...over.system,
    },
    cpu: { name: 'Intel(R) Core(TM) Ultra 5 125U', loadPercent: 20, ...over.cpu },
    memory: { installedBytes: 16 * GO, totalBytes: 15.4 * GO, modules: 2, usedPercent: 50, ...over.memory },
    disk: {
      volumes: [{ drive: 'C:', usedPercent: 22 }],
      physical: over.physical ?? [{ name: 'SK hynix 512GB', mediaType: 'SSD', sizeBytes: 512110190592 }],
    },
  };
}

let echecs = 0;
const verifier = (nom, condition, detail) => {
  console.log(`  ${condition ? 'OK  ' : 'ECHEC'} ${nom}${condition ? '' : ` — ${detail}`}`);
  if (!condition) echecs += 1;
};
const cles = (c) => c.map((x) => x.cle).sort().join(',');

console.log('\n1. Rien ne bouge');
{
  const c = detecterChangements(poste(), poste());
  verifier('aucun changement sur deux rapports identiques', c.length === 0, cles(c));

  // Les métriques vivantes changent à chaque relevé et ne doivent rien produire.
  const c2 = detecterChangements(
    poste({ cpu: { loadPercent: 20 }, memory: { usedPercent: 40 } }),
    poste({ cpu: { loadPercent: 85 }, memory: { usedPercent: 91 } })
  );
  verifier('la charge CPU et RAM n’est pas un changement', c2.length === 0, cles(c2));

  const c3 = detecterChangements(poste({ system: { uptimeSeconds: 100 } }),
    poste({ system: { uptimeSeconds: 99999 } }));
  verifier('le temps de fonctionnement non plus', c3.length === 0, cles(c3));
}

console.log('\n2. Changements notables');
{
  const c = detecterChangements(poste(), poste({ memory: { installedBytes: 8 * GO, modules: 1 } }));
  const ram = c.find((x) => x.cle === 'ram');
  verifier('mémoire en baisse détectée', Boolean(ram), cles(c));
  verifier('et marquée notable', ram?.notable === true, JSON.stringify(ram));
  verifier('valeurs lisibles', ram?.avant === '16 Go' && ram?.apres === '8 Go', JSON.stringify(ram));
  verifier('barrette manquante aussi', c.some((x) => x.cle === 'modules' && x.notable), cles(c));

  const s = detecterChangements(poste(), poste({ system: { serial: 'AUTRE99' } }));
  verifier('numéro de série', s.length === 1 && s[0].cle === 'serial' && s[0].notable, cles(s));

  const d = detecterChangements(poste(), poste({ physical: [] }));
  verifier('disque retiré : aucun changement si la liste devient vide',
    d.length === 0, `on a signalé ${cles(d)}`);

  const d2 = detecterChangements(poste(),
    poste({ physical: [{ name: 'Autre SSD', sizeBytes: 256060514304 }] }));
  verifier('disque remplacé', d2.some((x) => x.cle === 'disques' && x.notable), cles(d2));

  const dom = detecterChangements(poste(), poste({ system: { domain: 'autre.int' } }));
  verifier('changement de domaine notable',
    dom.length === 1 && dom[0].cle === 'domain' && dom[0].notable, cles(dom));
}

console.log('\n3. Changements courants, signalés sans alarmer');
{
  const c = detecterChangements(poste(), poste({ system: { osDisplayVersion: '26H1', osBuild: '27000' } }));
  verifier('montée de Windows détectée', c.length === 2, cles(c));
  verifier('mais pas notable', c.every((x) => x.notable === false), JSON.stringify(c));

  const u = detecterChangements(poste(), poste({ system: { loggedUser: 'SONES\\laura' } }));
  verifier('changement d’utilisateur non notable',
    u.length === 1 && u[0].cle === 'user' && u[0].notable === false, cles(u));

  const plus = detecterChangements(poste(), poste({ memory: { installedBytes: 32 * GO, modules: 4 } }));
  verifier('mémoire ajoutée : signalée, non notable',
    plus.some((x) => x.cle === 'ram') && plus.every((x) => x.notable === false), JSON.stringify(plus));
}

console.log('\n4. Données manquantes');
{
  const c = detecterChangements(poste(), poste({ system: { serial: null } }));
  verifier('valeur devenue illisible : rien signalé', c.length === 0, cles(c));

  const c2 = detecterChangements(poste({ system: { serial: null } }), poste());
  verifier('valeur apparue : rien signalé non plus', c2.length === 0, cles(c2));

  verifier('rapport précédent absent', detecterChangements(null, poste()).length === 0, '');
  verifier('rapport suivant absent', detecterChangements(poste(), null).length === 0, '');
  verifier('deux rapports vides', detecterChangements({}, {}).length === 0, '');
}

console.log(echecs === 0 ? '\nTous les controles passent.\n' : `\n${echecs} controle(s) en echec.\n`);
process.exit(echecs === 0 ? 0 : 1);
