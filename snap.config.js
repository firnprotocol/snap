module.exports = {
  cliOptions: {
    src: "./src/index.js",
    port: 8080,
  },
  bundlerCustomizer: (bundler) => {
    bundler.transform("uglifyify");
  },
};
