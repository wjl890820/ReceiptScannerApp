/**
 * Jest-only mock for expo-crypto.
 * Uses Node crypto for expected SHA-256 values in unit tests.
 * Not part of the React Native / Metro production bundle graph.
 */
const { createHash } = require('crypto');

const CryptoDigestAlgorithm = {
  SHA256: 'SHA-256',
};

async function digestStringAsync(_algorithm, data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

module.exports = {
  CryptoDigestAlgorithm,
  digestStringAsync,
};
