'use strict';

/**
 * Vérifie le diagnostic en français.
 *
 *   node scripts/test-diagnostic.js
 *
 * On contrôle autant la CONCLUSION que la RECOMMANDATION : un diagnostic qui
 * conclut juste mais conseille mal est pire qu'un silence, parce qu'on agit
 * dessus.
 */

const { diagnostiquer, calculerTendance } = require('../lib/diagnostic');

const GO = 1024 ** 3;

function poste(over = {}) {
  return {
    system: { uptimeSeconds: 3 * 86400, ...over.system },
    cpu: { name: 'Intel', loadPercent: 20, ...over.cpu },
    memory: { installedBytes: 16 * GO, totalBytes: 15.4 * GO, usedPercent: 50, ...over.memory },
    pressure: {
      processCount: 200, topSharePercent: 6, hardFaultsPerSec: 0,
      diskQueue: 0, diskBusyPercent: 2, ...over.pressure,
    },
    disk: {
      volumes: [{ drive: 'C:', usedPercent: 40, ...over.volume }],
      physical: [{ name: 'SSD', mediaType: over.media ?? 'SSD', sizeBytes: 512e9 }],
    },
  };
}

let echecs = 0;
const verifier = (nom, condition, detail) => {
  console.log(`  ${condition ? 'OK  ' : 'ECHEC'} ${nom}${condition ? '' : ` — ${detail}`}`);
  if (!condition) echecs += 1;
};

console.log('\n1. Le cas qui a motivé ce module : mémoire insuffisante, charge diffuse');
{
  const d = diagnostiquer(
    poste({ memory: { usedPercent: 88 }, pressure: { hardFaultsPerSec: 470, topSharePercent: 5.9, processCount: 347 } }),
    { mesures: 300, ramHautPct: 78, cpuHautPct: 4 }
  );
  verifier('conclut au manque de mémoire', /manque de mémoire/i.test(d.titre), d.titre);
  verifier('gravité critique à 470 défauts/s', d.severite === 'critical', d.severite);
  verifier('dit que ce n’est PAS un programme en particulier',
    /pas un programme en particulier/i.test(d.constat), d.constat);
  verifier('cite le nombre de processus', /347 processus/.test(d.constat), d.constat);
  verifier('appuie sur l’historique', /24 h/.test(d.constat), d.constat);
  verifier('recommande de doubler la mémoire, en chiffres',
    /16 Go/.test(d.action) && /32 Go/.test(d.action), d.action);
  verifier('écarte explicitement la fausse piste',
    /fermer des applications/i.test(d.action), d.action);
}

console.log('\n1 bis. Le même pic, mais isolé : pas le même verdict');
{
  // Valeurs réellement relevées sur un poste : un pic à 470 défauts/s, alors
  // que sur 24 h la mémoire ne dépasse le seuil que 13 % du temps.
  const d = diagnostiquer(
    poste({ memory: { usedPercent: 81 }, pressure: { hardFaultsPerSec: 470, topSharePercent: 5 } }),
    { mesures: 121, ramHautPct: 13.2, cpuHautPct: 0 }
  );
  verifier('conclut à un pic, pas à un manque', /pic/i.test(d.titre), d.titre);
  verifier('gravité faible malgré 470 défauts/s', d.severite === 'info', d.severite);
  verifier('cite la part du temps réelle', /13 %/.test(d.constat), d.constat);
  verifier('ne recommande pas d’acheter de la mémoire', !/Go/.test(d.action), d.action);

  // Le même pic sur une machine durablement chargée : verdict opposé.
  const grave = diagnostiquer(
    poste({ memory: { usedPercent: 92 }, pressure: { hardFaultsPerSec: 470, topSharePercent: 5 } }),
    { mesures: 300, ramHautPct: 79, cpuHautPct: 0 }
  );
  verifier('le même pic sur fond chargé : manque de mémoire',
    /manque de mémoire/i.test(grave.titre), grave.titre);
  verifier('et gravité critique', grave.severite === 'critical', grave.severite);
}

console.log('\n2. Un programme domine : conseil opposé');
{
  const d = diagnostiquer(poste({ pressure: { topSharePercent: 72, hardFaultsPerSec: 150 } }));
  verifier('conclut au programme unique', /seul programme/i.test(d.titre), d.titre);
  verifier('conseille de fermer et rouvrir', /fermer puis rouvrir/i.test(d.action), d.action);
  verifier('ne conseille PAS d’acheter de la mémoire',
    !/Go/.test(d.action), d.action);
}

console.log('\n3. Disque : le conseil dépend du support');
{
  const meca = diagnostiquer(poste({ media: 'HDD', pressure: { diskQueue: 5, diskBusyPercent: 95 } }));
  verifier('disque mécanique : recommande un SSD', /SSD/.test(meca.action), meca.action);
  verifier('et le situe par rapport à la mémoire',
    /mémoire/i.test(meca.action), meca.action);

  const ssd = diagnostiquer(poste({ media: 'SSD', pressure: { diskQueue: 5, diskBusyPercent: 95 } }));
  verifier('SSD saturé : cherche la cause, ne propose pas de matériel',
    /antivirus|sauvegarde|mise à jour/i.test(ssd.action) && !/Remplacer/i.test(ssd.action), ssd.action);
}

console.log('\n4. Processeur : distinguer le pic de la charge durable');
{
  const pic = diagnostiquer(poste({ cpu: { loadPercent: 95 } }), { mesures: 300, ramHautPct: 2, cpuHautPct: 3 });
  verifier('pic isolé : gravité faible', pic.severite === 'info', pic.severite);
  verifier('et le dit', /pic passager/i.test(pic.constat), pic.constat);

  const durable = diagnostiquer(poste({ cpu: { loadPercent: 95 } }), { mesures: 300, ramHautPct: 2, cpuHautPct: 81 });
  verifier('charge durable : gravité supérieure', durable.severite === 'warning', durable.severite);
  verifier('et cite la part du temps', /81/.test(durable.constat), durable.constat);
}

console.log('\n5. Ordre de priorité');
{
  // Mémoire ET disque en souffrance : la mémoire passe devant, c'est la cause.
  const d = diagnostiquer(poste({
    pressure: { hardFaultsPerSec: 400, topSharePercent: 10, diskQueue: 6 },
  }));
  verifier('la mémoire prime sur le disque qu’elle sature',
    /manque de mémoire/i.test(d.titre), d.titre);
}

console.log('\n6. Cas calmes et cas limites');
{
  const ok = diagnostiquer(poste());
  verifier('poste sain : aucun ralentissement', ok.severite === 'ok', ok.titre);
  verifier('et pas d’action inutile', ok.action === '', ok.action);

  const vieux = diagnostiquer(poste({ system: { uptimeSeconds: 40 * 86400 }, memory: { usedPercent: 80 } }));
  verifier('jamais redémarré : suggéré sans alarmer',
    /redémarrage/i.test(vieux.titre) && vieux.severite === 'info', vieux.titre);

  const plein = diagnostiquer(poste({ volume: { usedPercent: 94 } }));
  verifier('disque presque plein', /presque plein/i.test(plein.titre), plein.titre);

  verifier('rapport absent', diagnostiquer(null) === null, '');
  verifier('rapport vide ne plante pas', Boolean(diagnostiquer({}).titre), '');

  // Sans historique suffisant, on ne doit pas invoquer les 24 h.
  const sansHisto = diagnostiquer(
    poste({ memory: { usedPercent: 90 }, pressure: { hardFaultsPerSec: 200, topSharePercent: 5 } }),
    { mesures: 4, ramHautPct: 100, cpuHautPct: 0 }
  );
  verifier('historique trop court : pas de mention des 24 h',
    !/24 h/.test(sansHisto.constat), sansHisto.constat);
}

console.log('\n7. Calcul de la tendance');
{
  const t = calculerTendance([
    ...Array(70).fill({ ram: 95, cpu: 10 }),
    ...Array(30).fill({ ram: 40, cpu: 10 }),
  ]);
  verifier('part du temps au-dessus du seuil mémoire',
    Math.abs(t.ramHautPct - 70) < 0.1, `obtenu ${t.ramHautPct}`);
  verifier('processeur calme', t.cpuHautPct === 0, `obtenu ${t.cpuHautPct}`);
  verifier('nombre de mesures', t.mesures === 100, `obtenu ${t.mesures}`);

  const vide = calculerTendance([]);
  verifier('aucune mesure', vide.mesures === 0 && vide.ramHautPct === 0, JSON.stringify(vide));

  const trous = calculerTendance([{ ram: 95, cpu: null }, { ram: null, cpu: 95 }, { ram: null, cpu: null }]);
  verifier('mesures partielles comptées séparément',
    trous.ramHautPct === 100 && trous.cpuHautPct === 100, JSON.stringify(trous));
}

console.log(echecs === 0 ? '\nTous les controles passent.\n' : `\n${echecs} controle(s) en echec.\n`);
process.exit(echecs === 0 ? 0 : 1);
