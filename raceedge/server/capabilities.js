const capabilityMatrix = require('../shared/capabilities.json')

const allSourceEntries = Object.values(capabilityMatrix.sources).flat()
const sourceById = new Map(allSourceEntries.map(entry => [entry.id, entry]))
const sourceByName = new Map(allSourceEntries.map(entry => [entry.sourceName, entry]))
const featureById = new Map(capabilityMatrix.features.map(entry => [entry.id, entry]))

function getCapabilityMatrix() {
  return capabilityMatrix
}

function getReleaseInfo() {
  return capabilityMatrix.release
}

function getFeatureMeta(featureId) {
  return featureById.get(featureId) || null
}

function getSourcesForRaceType(raceType) {
  return capabilityMatrix.sources?.[raceType] || []
}

function getSourceMeta(sourceIdOrName) {
  if (!sourceIdOrName) return null
  return sourceById.get(sourceIdOrName) || sourceByName.get(sourceIdOrName) || null
}

module.exports = {
  getCapabilityMatrix,
  getReleaseInfo,
  getFeatureMeta,
  getSourcesForRaceType,
  getSourceMeta,
}
