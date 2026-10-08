'use strict';

/**
 * Verifie la prevision de saturation disque sur des series fabriquees, dont
 * on connait la reponse.
 *
 *   node scripts/test-forecast.js
 *
 * Les cas de refus comptent autant que les cas de reussite : une prevision
 * qui se tait quand elle ne sait pas vaut mieux qu'une prevision qui invente.
 */

const assert = require('assert');
const { prevoirSaturationDisque } = require('../lib/forecast');

const JOUR = 86400000;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

/**
 * Fabrique une serie de mesures.
 * @param {object} o
 * @param {number} o.depart      pourcentage au debut de la fenetre
 * @param {number} o.parJour     progression en points de pourcentage par jour
 * @param {number} o.jours       duree couverte
 * @param {number} [o.parJourMesures] nombre de mesures par jour
 * @param {number} [o.bruit]     amplitude du bruit, en points
 * @param {function} [o.deforme] transformation appliquee a chaque valeur
 */
function serie(o) {
  const parJourMesures = o.parJourMesures ?? 48;
  const total = Math.round(o.jours * parJourMesures);
  const pts = [];
  // Generateur deterministe : un test qui echoue une fois sur dix est pire
  // que pas de test du tout.
  let graine = 42;
  const alea = () => {
    graine = (graine * 1103515245 + 12345) % 2147483648;
    return graine / 2147483648 - 0.5;
  };
  for (let i = 0; i < total; i++) {
    const t = NOW - o.jours * JOUR + (i / parJourMesures) * JOUR;
    let v = o.depart + o.parJour * ((t - (NOW - o.jours * JOUR)) / JOUR);
    if (o.bruit) v += alea() * o.bruit;
    if (o.deforme) v = o.deforme(v, i, total);
    pts.push({ ts: Math.round(t), disk: Math.max(0, Math.min(100, v)) });
  }
  return pts;
}

let echecs = 0;
function verifier(nom, condition, detail) {
  console.log(`  ${condition ? 'OK  ' : 'ECHEC'} ${nom}${condition ? '' : ` — ${detail}`}`);
  if (!condition) echecs += 1;
}

console.log('\n1. Progression reguliere : la date doit etre juste');
{
  // 60 % au depart, +2 pts/jour sur 10 jours -> 80 % aujourd'hui.
  // Il reste 20 points a 2 pts/jour, soit 10 jours.
  const r = prevoirSaturationDisque(serie({ depart: 60, parJour: 2, jours: 10 }), { now: NOW });
  verifier('prevision rendue', r.possible === true, r.raison);
  verifier('environ 10 jours annonces',
    Math.abs(r.joursRestants - 10) < 0.5, `obtenu ${r.joursRestants}`);
  verifier('pente retrouvee a 2 pts/jour',
    Math.abs(r.penteParJour - 2) < 0.05, `obtenu ${r.penteParJour}`);
  verifier('ajustement quasi parfait', r.r2 > 0.99, `r2=${r.r2}`);
}

console.log('\n2. Progression bruitee mais nette');
{
  const r = prevoirSaturationDisque(
    serie({ depart: 70, parJour: 1.5, jours: 12, bruit: 3 }), { now: NOW });
  verifier('prevision rendue malgre le bruit', r.possible === true, r.raison);
  // 70 + 1.5*12 = 88 aujourd'hui ; (100-88)/1.5 = 8 jours.
  verifier('date plausible', r.joursRestants > 6 && r.joursRestants < 10,
    `obtenu ${r.joursRestants}`);
}

console.log('\n3. Refus justifies');
{
  const stable = prevoirSaturationDisque(
    serie({ depart: 55, parJour: 0, jours: 10, bruit: 2 }), { now: NOW });
  verifier('disque stable : aucune date', stable.possible === false, 'une date a ete rendue');
  verifier('motif « stable »', /stable|baisse/.test(stable.raison || ''), stable.raison);

  const baisse = prevoirSaturationDisque(
    serie({ depart: 80, parJour: -1, jours: 10 }), { now: NOW });
  verifier('disque qui se vide : aucune date', baisse.possible === false, baisse.raison);

  const court = prevoirSaturationDisque(
    serie({ depart: 60, parJour: 3, jours: 1 }), { now: NOW });
  verifier('un seul jour d’historique : refus', court.possible === false, court.raison);
  verifier('motif « trop court »', /court/.test(court.raison || ''), court.raison);

  const rares = prevoirSaturationDisque(
    serie({ depart: 60, parJour: 3, jours: 10, parJourMesures: 1 }), { now: NOW });
  verifier('10 mesures seulement : refus',
    rares.possible === false && /pas assez/.test(rares.raison || ''), rares.raison);

  // Dents de scie : monte puis redescend, sans tendance exploitable.
  const scie = prevoirSaturationDisque(
    serie({ depart: 70, parJour: 0.3, jours: 12, deforme: (v, i) => v + (i % 40 < 20 ? 12 : -12) }),
    { now: NOW });
  verifier('serie en dents de scie : refus',
    scie.possible === false, `une date a ete rendue : ${scie.joursRestants}`);
  verifier('motif « irreguliere »', /irreguli/.test(scie.raison || ''), scie.raison);

  const lent = prevoirSaturationDisque(
    serie({ depart: 20, parJour: 0.06, jours: 12 }), { now: NOW });
  verifier('progression tres lente : au-dela d’un an',
    lent.possible === false && /an/.test(lent.raison || ''), lent.raison);
}

console.log('\n4. Cas limites');
{
  verifier('tableau vide', prevoirSaturationDisque([], { now: NOW }).possible === false, '');
  verifier('entree nulle', prevoirSaturationDisque(null, { now: NOW }).possible === false, '');

  const avecTrous = serie({ depart: 60, parJour: 2, jours: 10 })
    .map((p, i) => (i % 3 === 0 ? { ts: p.ts, disk: null } : p));
  const r = prevoirSaturationDisque(avecTrous, { now: NOW });
  verifier('mesures manquantes ignorees sans planter', r.possible === true, r.raison);

  const plein = prevoirSaturationDisque(
    serie({ depart: 99.5, parJour: 1, jours: 5 }), { now: NOW });
  verifier('disque deja plein : zero jour',
    plein.possible === true && plein.joursRestants === 0, `obtenu ${plein.joursRestants}`);

  // Des mesures hors fenetre ne doivent pas peser : ici un passe lointain
  // tres different de la tendance recente.
  const vieux = serie({ depart: 10, parJour: 0, jours: 5 })
    .map((p) => ({ ts: p.ts - 60 * JOUR, disk: p.disk }));
  const recent = serie({ depart: 70, parJour: 2, jours: 10 });
  const melange = prevoirSaturationDisque([...vieux, ...recent], { now: NOW });
  verifier('mesures hors fenetre ecartees',
    melange.possible === true && Math.abs(melange.penteParJour - 2) < 0.1,
    `pente=${melange.penteParJour}`);

  const desordre = [...serie({ depart: 60, parJour: 2, jours: 10 })].reverse();
  const rd = prevoirSaturationDisque(desordre, { now: NOW });
  verifier('ordre des mesures indifferent',
    rd.possible === true && Math.abs(rd.joursRestants - 10) < 0.5, `obtenu ${rd.joursRestants}`);
}

console.log(echecs === 0 ? '\nTous les controles passent.\n' : `\n${echecs} controle(s) en echec.\n`);
process.exit(echecs === 0 ? 0 : 1);
