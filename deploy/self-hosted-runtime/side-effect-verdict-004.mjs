export function assessEffectCounts(atKill,final,expectedAtKill) {
  const valid=[atKill.successfulDispatches,atKill.committedEffects,final.successfulDispatches,final.committedEffects]
    .every(n=>Number.isSafeInteger(n)&&n>=0);
  return {noDuplicate:valid&&final.successfulDispatches<=1&&final.committedEffects<=1,
    countRetained:valid&&final.successfulDispatches>=atKill.successfulDispatches&&final.committedEffects>=atKill.committedEffects,
    appropriateKillBoundary:valid&&atKill.successfulDispatches===expectedAtKill&&atKill.committedEffects===expectedAtKill};
}
