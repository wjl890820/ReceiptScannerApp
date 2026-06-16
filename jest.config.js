/** Minimal Jest config for lib unit tests (Node). */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/lib'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: false }],
  },
  transformIgnorePatterns: ['node_modules/(?!(@)?(expo|react-native|@react-native))'],
};
