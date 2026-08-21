const path = require('path')
const webpack = require('webpack')
const TerserPlugin = require('terser-webpack-plugin')
const { getBuildEnvValue } = require('../../scripts/lib/buildEnv')

// This config does not reuse webpack.base.js: that one is pinned to ES2018 in three places
// (webpack target, ts-loader config file and Terser `ecma`), which is exactly what this build has
// to move away from.
module.exports = (_env, argv) => ({
  entry: path.resolve(__dirname, 'src/entries/main.ts'),
  mode: argv.mode,
  output: {
    filename: 'fc-rum-legacy.js',
    path: path.resolve(__dirname, 'bundle'),
  },
  target: ['web', 'es5'],
  devtool: false,
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
        options: {
          configFile: path.resolve(__dirname, 'tsconfig.json'),
          onlyCompileBundledFiles: true,
        },
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  optimization: {
    minimizer: [
      new TerserPlugin({
        extractComments: false,
        terserOptions: {
          // Without this, Terser happily "optimizes" the ES5 input back into arrow functions and
          // shorthand syntax, undoing the whole point of the build.
          ecma: 5,
          module: false,
          compress: {
            passes: 3,
          },
          format: {
            ecma: 5,
          },
        },
      }),
    ],
  },
  plugins: [
    new webpack.SourceMapDevToolPlugin({
      filename: '[file].map',
      append: false,
    }),
    new webpack.DefinePlugin({
      __BUILD_ENV__SDK_VERSION__: webpack.DefinePlugin.runtimeValue(() =>
        JSON.stringify(getBuildEnvValue('SDK_VERSION'))
      ),
    }),
  ],
})
