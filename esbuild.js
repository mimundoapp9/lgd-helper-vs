const esbuild = require('esbuild');
const { copy } = require('esbuild-plugin-copy');

const production = process.argv.includes('--production');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['./src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	external: ['vscode'],
	format: 'cjs',
	platform: 'node',
	sourcemap: !production,
	minify: production,
	plugins: [
		/* add to the end of plugins array */
		esbuildProblemMatcherPlugin,
	],
};

// Simplificar la compilación
if (process.argv.includes('--watch')) {
	// Modo watch
	esbuild.context(options).then(ctx => {
		ctx.watch();
		console.log('Watching...');
	});
} else {
	// Compilación única
	esbuild.build(options).catch(() => process.exit(1));
}
