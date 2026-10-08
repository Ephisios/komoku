'use strict';

/**
 * Prevision de saturation disque.
 *
 * On dispose de 30 jours de mesures et on ne s'en servait que pour tracer des
 * courbes. Une regression lineaire sur la serie du disque permet de dire
 * « C: sera plein dans 12 jours » — ce qui fait passer l'outil du constat a
 * la prevention.
 *
 * Le parti pris de ce fichier : **mieux vaut ne rien annoncer qu'annoncer
 * n'importe quoi**. Une prevision fausse une fois sur trois serait pire
 * qu'une absence de prevision, parce qu'on cesserait d'y croire. Chaque
 * refus est donc motive, et le motif est renvoye pour pouvoir l'afficher.
 */

// Fenetre d'observation. Deux semaines suffisent a capter une tendance sans
// se laisser entrainer par un menage fait le mois dernier.
const FENETRE_JOURS = 14;

// Garde-fous. Ils sont volontairement stricts.
const MIN_POINTS = 20;        // moins, et le bruit domine
const MIN_SPAN_HEURES = 48;   // une journee ne dit rien d'une tendance
const MIN_PENTE = 0.05;       // %/jour en deca : considere stable
const MIN_R2 = 0.5;           // qualite d'ajustement minimale
const MAX_JOURS = 365;        // au-dela, l'annonce n'a plus de sens

const JOUR_MS = 86400000;

/**
 * Regression lineaire par moindres carres.
 * @returns {{pente:number, ordonnee:number, r2:number}} pente en unites de y par jour
 */
function regresser(points) {
  const n = points.length;
  const moyX = points.reduce((s, p) => s + p.x, 0) / n;
  const moyY = points.reduce((s, p) => s + p.y, 0) / n;

  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - moyX) * (p.y - moyY);
    den += (p.x - moyX) ** 2;
  }
  // Tous les points au meme instant : pente indefinie.
  if (den === 0) return { pente: 0, ordonnee: moyY, r2: 0 };

  const pente = num / den;
  const ordonnee = moyY - pente * moyX;

  // Coefficient de determination : quelle part de la variation la droite
  // explique-t-elle. Sans lui, une serie en dents de scie produirait une
  // pente rassurante et parfaitement trompeuse.
  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    ssRes += (p.y - (ordonnee + pente * p.x)) ** 2;
    ssTot += (p.y - moyY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { pente, ordonnee, r2 };
}

/**
 * @param {Array<{ts:number, disk:number}>} echantillons  mesures brutes, dans n'importe quel ordre
 * @param {object} [options]
 * @param {number} [options.now]       instant de reference (test)
 * @param {number} [options.seuil]     pourcentage considere comme « plein ». 100 par defaut.
 * @returns {{
 *   possible: boolean, raison?: string, joursRestants?: number|null,
 *   penteParJour?: number, r2?: number, niveauActuel?: number, points?: number
 * }}
 */
function prevoirSaturationDisque(echantillons, options = {}) {
  const now = options.now ?? Date.now();
  const seuil = options.seuil ?? 100;
  const depuis = now - FENETRE_JOURS * JOUR_MS;

  const retenus = (echantillons || [])
    .filter((e) => e && typeof e.ts === 'number' && typeof e.disk === 'number'
      && Number.isFinite(e.disk) && e.ts >= depuis && e.ts <= now)
    .sort((a, b) => a.ts - b.ts);

  if (retenus.length < MIN_POINTS) {
    return {
      possible: false,
      raison: `pas assez de mesures (${retenus.length} sur ${MIN_POINTS} requises)`,
      points: retenus.length,
    };
  }

  const spanHeures = (retenus[retenus.length - 1].ts - retenus[0].ts) / 3600000;
  if (spanHeures < MIN_SPAN_HEURES) {
    return {
      possible: false,
      raison: `historique trop court (${Math.round(spanHeures)} h sur ${MIN_SPAN_HEURES} requises)`,
      points: retenus.length,
    };
  }

  const t0 = retenus[0].ts;
  const points = retenus.map((e) => ({ x: (e.ts - t0) / JOUR_MS, y: e.disk }));
  const { pente, ordonnee, r2 } = regresser(points);

  // On lit le niveau courant sur la droite ajustee, pas sur la derniere
  // mesure : un pic isole decalerait la prevision de plusieurs jours.
  const xDernier = points[points.length - 1].x;
  const niveauAjuste = ordonnee + pente * xDernier;
  const niveauActuel = Math.round(retenus[retenus.length - 1].disk * 10) / 10;

  const base = {
    penteParJour: Math.round(pente * 100) / 100,
    r2: Math.round(r2 * 100) / 100,
    niveauActuel,
    points: retenus.length,
  };

  if (niveauAjuste >= seuil) {
    return { possible: true, joursRestants: 0, ...base };
  }
  if (pente < MIN_PENTE) {
    return { possible: false, raison: 'occupation stable ou en baisse', ...base };
  }
  if (r2 < MIN_R2) {
    // La pente existe mais les mesures sont trop dispersees pour qu'on
    // puisse en tirer une date.
    return { possible: false, raison: 'progression trop irreguliere', ...base };
  }

  const joursRestants = (seuil - niveauAjuste) / pente;
  if (joursRestants > MAX_JOURS) {
    return { possible: false, raison: 'saturation au-dela d’un an', ...base };
  }

  return { possible: true, joursRestants: Math.round(joursRestants * 10) / 10, ...base };
}

module.exports = {
  prevoirSaturationDisque,
  regresser,
  SEUILS_PREVISION: { FENETRE_JOURS, MIN_POINTS, MIN_SPAN_HEURES, MIN_PENTE, MIN_R2, MAX_JOURS },
};
