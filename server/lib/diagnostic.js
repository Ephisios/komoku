'use strict';

/**
 * Diagnostic en français, pour quelqu'un qui n'est pas informaticien.
 *
 * Le tableau de bord savait déjà dire « 470 défauts de page durs/s ». C'est
 * exact et parfaitement inutile : il faut déjà connaître la réponse pour
 * comprendre la question. Ce module traduit les indicateurs en une phrase de
 * constat et une phrase d'action.
 *
 * Deux règles de rédaction :
 *
 *   - **Dire ce qu'il faut faire.** Un diagnostic sans recommandation laisse
 *     le lecteur exactement où il était.
 *   - **Dire aussi ce que ce n'est pas.** « Ce n'est pas un programme en
 *     particulier » évite qu'on parte fermer des applications au hasard, ou
 *     qu'on conclue à tort qu'il faut changer la machine.
 */

const GO = 1024 ** 3;

const SEUILS = {
  defautsPage: 100,        // par seconde, au-delà la machine pagine
  defautsPageGrave: 300,
  fileDisque: 2,
  partDominante: 50,       // % de la RAM pour un seul programme
  partDiffuse: 40,         // en dessous, la charge est considérée répartie
  ramHaute: 88,            // %
  cpuHaut: 90,             // %
  presenceHaute: 60,       // % du temps passé au-dessus du seuil
  uptimeJours: 21,
};

function pct(v) {
  return `${String(Math.round(v)).replace('.', ',')} %`;
}

/**
 * @param {object} payload   dernier rapport
 * @param {object} [tendance] { mesures, ramHautPct, cpuHautPct } sur 24 h
 * @returns {{severite:string, titre:string, constat:string, action:string}|null}
 */
function diagnostiquer(payload, tendance = null) {
  if (!payload) return null;

  const pr = payload.pressure || {};
  const mem = payload.memory || {};
  const cpu = payload.cpu || {};
  const volumes = payload.disk?.volumes || [];
  const physique = payload.disk?.physical?.[0] || null;
  const principal = volumes.find((v) => /^C:/i.test(v.drive)) || volumes[0] || null;

  const ramInstallee = mem.installedBytes ?? mem.totalBytes ?? null;
  const ramGo = ramInstallee ? Math.round(ramInstallee / GO) : null;
  const estSsd = physique?.mediaType ? /ssd/i.test(physique.mediaType) : null;

  // L'historique rend le constat beaucoup plus solide : une mesure isolée
  // peut tomber pendant un pic sans conséquence.
  //
  // Ces pourcentages portent sur les RELEVÉS, donc sur le temps où le poste
  // était allumé — un portable en veille ne produit rien. C'est le bon
  // dénominateur : ce qui compte est la gêne pendant l'utilisation, pas
  // pendant la nuit.
  const assezDHistorique = tendance && tendance.mesures >= 20;
  const ramSouventHaute = assezDHistorique && tendance.ramHautPct >= SEUILS.presenceHaute;
  const cpuSouventHaut = assezDHistorique && tendance.cpuHautPct >= SEUILS.presenceHaute;
  const depuis = assezDHistorique
    ? ` — c'est le cas ${pct(tendance.ramHautPct)} du temps allumé sur les dernières 24 h`
    : '';

  // ------------------------------------------------- un programme domine
  if (pr.topSharePercent >= SEUILS.partDominante) {
    return {
      severite: 'warning',
      titre: 'Un seul programme occupe la mémoire',
      constat: `Un programme à lui seul utilise ${pct(pr.topSharePercent)} de la mémoire `
        + `de ce poste. Le reste de la machine se partage ce qu'il laisse.`,
      action: 'Demandez de fermer puis rouvrir les applications ouvertes. '
        + 'Si la situation revient chaque jour, c\u2019est cette application '
        + 'qui consomme anormalement, pas le poste qui est trop petit.',
    };
  }

  // ------------------------------------------- mémoire insuffisante, diffuse
  const pagine = pr.hardFaultsPerSec >= SEUILS.defautsPage;

  // Un pic isolé n'est pas un manque de mémoire. Sans cette distinction, le
  // diagnostic annoncerait « ce poste manque de mémoire » pendant la minute
  // du pic, puis « aucun ralentissement » au relevé suivant — et un outil qui
  // souffle le chaud et le froid cesse d'être cru.
  if (pagine && assezDHistorique && !ramSouventHaute) {
    return {
      severite: 'info',
      titre: 'Pic de mémoire passager',
      constat: `La machine a paginé au dernier relevé (${pr.hardFaultsPerSec} défauts par `
        + `seconde), mais sur les dernières 24 h la mémoire ne dépasse ${SEUILS.ramHaute} % `
        + `que ${pct(tendance.ramHautPct)} du temps allumé.`,
      action: 'Rien à faire : un pic passager, sans doute une application qui vient '
        + 'de s’ouvrir. À reconsidérer si cela devient habituel.',
    };
  }

  if (pagine || ramSouventHaute) {
    const diffuse = pr.topSharePercent !== undefined && pr.topSharePercent < SEUILS.partDiffuse;
    const grave = pr.hardFaultsPerSec >= SEUILS.defautsPageGrave;

    const morceaux = [];
    if (pagine) {
      morceaux.push('La machine va chercher sur le disque ce qui devrait tenir en mémoire'
        + `${grave ? ' , et très souvent' : ''}.`);
    }
    if (mem.usedPercent != null) {
      morceaux.push(`La mémoire est occupée à ${pct(mem.usedPercent)}${depuis}.`);
    }
    if (diffuse && pr.processCount) {
      morceaux.push(`Ce n'est pas un programme en particulier : la charge se répartit `
        + `sur ${pr.processCount} processus.`);
    }

    const action = diffuse
      ? (ramGo
        ? `Ce poste a ${ramGo} Go. Passer à ${ramGo * 2} Go est la seule réponse durable `
          + '— fermer des applications ne fera que déplacer le problème.'
        : 'Ajouter de la mémoire est la seule réponse durable.')
      : 'Vérifiez les applications ouvertes, puis envisagez d\u2019ajouter de la mémoire.';

    return {
      severite: grave ? 'critical' : 'warning',
      titre: 'Ce poste manque de mémoire',
      constat: morceaux.join(' '),
      action,
    };
  }

  // ------------------------------------------------------- disque saturé
  if (pr.diskQueue >= SEUILS.fileDisque) {
    if (estSsd === false) {
      return {
        severite: 'warning',
        titre: 'Le disque freine la machine',
        constat: 'Les demandes s\u2019accumulent en attente du disque, qui est un disque '
          + 'mécanique.',
        action: 'Remplacer ce disque par un SSD est, de loin, l\u2019amélioration la plus '
          + 'sensible pour un poste de ce type. Plus que doubler la mémoire.',
      };
    }
    return {
      severite: 'warning',
      titre: 'Le disque est très sollicité',
      constat: `Les demandes s\u2019accumulent en attente du disque `
        + `(${pr.diskBusyPercent != null ? `occupé à ${pct(pr.diskBusyPercent)}` : 'file d\u2019attente chargée'}), `
        + 'alors qu\u2019il s\u2019agit d\u2019un SSD.',
      action: 'Quelque chose écrit massivement : sauvegarde, analyse antivirus complète '
        + 'ou mise à jour Windows en cours. Vérifiez si cela dure au-delà d\u2019une heure.',
    };
  }

  // ---------------------------------------------------- processeur saturé
  if (cpuSouventHaut || (cpu.loadPercent != null && cpu.loadPercent >= SEUILS.cpuHaut)) {
    return {
      severite: cpuSouventHaut ? 'warning' : 'info',
      titre: 'Le processeur travaille beaucoup',
      constat: cpuSouventHaut
        ? `Le processeur dépasse ${SEUILS.cpuHaut} % de charge sur `
          + `${pct(tendance.cpuHautPct)} du temps allumé des dernières 24 h.`
        : `Le processeur est à ${pct(cpu.loadPercent)} au dernier relevé, `
          + 'ce qui peut n\u2019être qu\u2019un pic passager.',
      action: cpuSouventHaut
        ? 'Une charge aussi constante vient en général d\u2019une application de fond : '
          + 'analyse antivirus, synchronisation, ou traitement lancé en boucle.'
        : 'Rien à faire pour l\u2019instant : à surveiller si cela se répète.',
    };
  }

  // -------------------------------------------------- disque presque plein
  if (principal && principal.usedPercent >= 90) {
    return {
      severite: 'warning',
      titre: 'Le disque est presque plein',
      constat: `Il reste peu d\u2019espace libre sur ${principal.drive}. En dessous de `
        + '10 % d\u2019espace libre, Windows ralentit de lui-même.',
      action: 'Faire du ménage, ou prévoir un disque plus grand si le poste se remplit '
        + 'naturellement.',
    };
  }

  // ------------------------------------------------- jamais redémarré
  const jours = (payload.system?.uptimeSeconds ?? 0) / 86400;
  if (jours >= SEUILS.uptimeJours && (mem.usedPercent ?? 0) >= 75) {
    return {
      severite: 'info',
      titre: 'Un redémarrage ferait du bien',
      constat: `Ce poste fonctionne sans interruption depuis ${Math.round(jours)} jours, `
        + `et sa mémoire est occupée à ${pct(mem.usedPercent)}.`,
      action: 'Un redémarrage libère la mémoire que les applications n\u2019ont pas rendue, '
        + 'et applique les mises à jour en attente.',
    };
  }

  return {
    severite: 'ok',
    titre: 'Aucun ralentissement détecté',
    constat: 'Mémoire, disque et processeur sont dans des valeurs normales.',
    action: '',
  };
}

/**
 * Part du temps passé au-dessus des seuils, sur la fenêtre fournie.
 * @param {Array<{ram:number, cpu:number}>} mesures
 */
function calculerTendance(mesures) {
  const valides = (mesures || []).filter((m) => m && (m.ram != null || m.cpu != null));
  if (valides.length === 0) return { mesures: 0, ramHautPct: 0, cpuHautPct: 0 };

  const ram = valides.filter((m) => m.ram != null);
  const cpu = valides.filter((m) => m.cpu != null);
  const part = (liste, seuil) => (liste.length
    ? Math.round((liste.filter((x) => x >= seuil).length / liste.length) * 1000) / 10
    : 0);

  return {
    mesures: valides.length,
    ramHautPct: part(ram.map((m) => m.ram), SEUILS.ramHaute),
    cpuHautPct: part(cpu.map((m) => m.cpu), SEUILS.cpuHaut),
  };
}

module.exports = { diagnostiquer, calculerTendance, SEUILS };
