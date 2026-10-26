import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ESLint stays on 9: eslint-plugin-jsx-a11y (6.10) supports up to ESLint 9.

// slice V4b: features with an enforced boundary (see the rule at the end).
const BOUNDED_FEATURES = ['audit', 'knownHosts', 'multiexec', 'ops', 'snippets', 'status', 'tunnels'];

export default defineConfig([
    globalIgnores([
        'dist/',
        'dist-*/',
        'release/',
        'node_modules/',
        'coverage/',
        'test-results/',
        'playwright-report/',
        // Hidden folders at the root: editor settings, other local checkouts.
        '.*/',
    ]),

    js.configs.recommended,
    tseslint.configs.recommended,

    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': ['error', {
                args: 'after-used',
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
                ignoreRestSiblings: true,
            }],
        },
    },

    {
        files: ['src/**/*.{ts,tsx}'],
        plugins: {
            'react-hooks': reactHooks,
            'jsx-a11y': jsxA11y,
        },
        languageOptions: {
            globals: globals.browser,
            parserOptions: {
                ecmaFeatures: { jsx: true },
            },
        },
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            ...jsxA11y.flatConfigs.recommended.rules,
        },
    },

    {
        files: [
            'server.ts',
            'server/**/*.ts',
            'electron/**/*.ts',
            'test/**/*.{ts,tsx}',
            'scripts/**/*.{js,mjs,cjs,ts}',
            '*.config.{js,mjs,cjs,ts}',
        ],
        languageOptions: {
            globals: globals.node,
        },
    },

    // shared/ is compiled into both the CommonJS backend and the browser bundle,
    // so it gets neither Node nor browser globals and may not import Node modules
    // or frameworks.
    {
        files: ['shared/**/*.ts'],
        ignores: ['shared/**/*.test.ts'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: builtinModules.map((name) => ({
                    name,
                    message: 'shared/ must stay free of Node APIs (it is bundled into the frontend).',
                })),
                patterns: [
                    {
                        group: ['node:*'],
                        message: 'shared/ must stay free of Node APIs (it is bundled into the frontend).',
                    },
                    {
                        group: ['react', 'react-*', 'express', 'socket.io', 'socket.io-*', 'sqlite3', 'ssh2', '@/*', '../server/*', '../src/*'],
                        message: 'shared/ is framework-free: only types, constants and pure functions.',
                    },
                ],
            }],
        },
    },

    // slice V4b: the backend logs through server/logger.ts (levels, LOG_LEVEL,
    // redaction); console output bypasses all three.
    {
        files: ['server.ts', 'server/**/*.ts'],
        ignores: ['server/**/*.test.ts', 'server/logger.ts'],
        rules: {
            'no-console': 'error',
        },
    },

    // slice V4b: these features reach each other only through a public.ts;
    // shared helpers live in src/lib or src/components.
    ...BOUNDED_FEATURES.map((feature) => ({
        files: [`src/features/${feature}/**/*.{ts,tsx}`],
        ignores: ['src/**/*.test.{ts,tsx}'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: BOUNDED_FEATURES.filter((other) => other !== feature)
                        .flatMap((other) => [`@/features/${other}/*`, `!@/features/${other}/public`, `../${other}/*`, `!../${other}/public`]),
                    message: 'Import another feature through its public.ts, or move what both need to src/lib.',
                }],
            }],
        },
    })),
]);
