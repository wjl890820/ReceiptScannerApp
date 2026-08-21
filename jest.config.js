/** Minimal Jest config for lib unit tests (Node). */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/lib'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // Test-only: RN/expo-crypto needs a Node stand-in; production uses real expo-crypto.
    '^expo-crypto$': '<rootDir>/lib/__mocks__/expo-crypto.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: false }],
  },
  transformIgnorePatterns: ['node_modules/(?!(@)?(expo|react-native|@react-native))'],
};
