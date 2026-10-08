'use strict';

/**
 * Détection des changements durables d'un poste.
 *
 * On compare le rapport qui arrive au précédent, et on retient ce qui ne
 * devrait pas bouger tout seul : mémoire, disques, processeur, numéro de
 * série, version de Windows, utilisateur principal.
 *
 * L'intérêt n'est pas la curiosité. Une barrette de 8 Go qui disparaît, un
 * disque en moins, un numéro de série qui change sous la même étiquette :
 * ce sont des faits qu'on ne remarque jamais au moment où ils se produisent,
 * et qu'on cherche désespérément six mois plus tard.
 *
 * Deux principes gouvernent ce fichier :
 *
 *   - **Ne rien signaler qu'on ne sache expliquer.** Un champ absent d'un
 *     côté ou de l'autre ne produit aucun changement : l'agent peut avoir
 *     échoué à le lire, et « RAM passée de 16 Go à inconnu » serait du bruit.
 *   - **Distinguer le notable du courant.** Une version de Windows qui monte
 *     est normal ; de la mémoire qui disparaît ne l'est pas.
 */

const GO = 1024 ** 3;

/** Les champs surveillés, et comment les lire. */
const CHAMPS = [
  {
    cle: 'serial', libelle: 'Numéro de série',
    lire: (p) => p.system?.serial,
    // Un numéro de série qui change, c'est une autre machine sous la même
    // étiquette. Toujours notable.
    notable: () => true,
  },
  {
    cle: 'model', libelle: 'Modèle',
    lire: (p) => [p.system?.manufacturer, p.system?.model].filter(Boolean).join(' ') || null,
    notable: () => true,
  },
  {
    cle: 'cpu', libelle: 'Processeur',
    lire: (p) => p.cpu?.name,
    notable: () => true,
  },
  {
    cle: 'ram', libelle: 'Mémoire installée',
    lire: (p) => p.memory?.installedBytes ?? p.memory?.totalBytes,
    format: (v) => `${Math.round(v / GO)} Go`,
    // En hausse : quelqu'un a ajouté de la mémoire, c'est une information.
    // En baisse : une barrette a disparu, c'est un fait à expliquer.
    notable: (avant, apres) => apres < avant,
  },
  {
    cle: 'modules', libelle: 'Barrettes mémoire',
    lire: (p) => p.memory?.modules,
    notable: (avant, apres) => apres < avant,
  },
  {
    cle: 'disques', libelle: 'Disques physiques',
    lire: (p) => {
      const d = p.disk?.physical;
      if (!Array.isArray(d) || d.length === 0) return null;
      return d.map((x) => `${x.name} (${Math.round((x.sizeBytes || 0) / 1e9)} Go)`).sort().join(', ');
    },
    notable: () => true,
  },
  {
    cle: 'os', libelle: 'Version de Windows',
    lire: (p) => [p.system?.osName, p.system?.osDisplayVersion].filter(Boolean).join(' ') || null,
    // Une montée de version est attendue, elle se note sans alarmer.
    notable: () => false,
  },
  {
    cle: 'build', libelle: 'Build de Windows',
    lire: (p) => p.system?.osBuild,
    notable: () => false,
  },
  {
    cle: 'user', libelle: 'Utilisateur principal',
    lire: (p) => p.system?.loggedUser,
    notable: () => false,
  },
  {
    cle: 'domain', libelle: 'Domaine',
    lire: (p) => p.system?.domain,
    notable: () => true,
  },
];

/**
 * @param {object} avant  rapport précédent
 * @param {object} apres  rapport qui arrive
 * @returns {Array<{cle,libelle,avant,apres,notable}>}
 */
function detecterChangements(avant, apres) {
  if (!avant || !apres) return [];

  const sorties = [];
  for (const champ of CHAMPS) {
    const a = champ.lire(avant);
    const b = champ.lire(apres);

    // Une valeur absente d'un côté n'est pas un changement : l'agent peut
    // simplement avoir échoué à la lire une fois.
    if (a === null || a === undefined || a === '') continue;
    if (b === null || b === undefined || b === '') continue;
    if (a === b) continue;

    const fmt = champ.format || String;
    sorties.push({
      cle: champ.cle,
      libelle: champ.libelle,
      avant: fmt(a),
      apres: fmt(b),
      notable: Boolean(champ.notable(a, b)),
    });
  }
  return sorties;
}

module.exports = { detecterChangements, CHAMPS };
