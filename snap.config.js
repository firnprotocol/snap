module.exports = {
  cliOptions: {
    src: "./src/index.js",
    port: 8080,
    transpilationMode: "localAndDeps"
  },
  bundlerCustomizer: (bundler) => {
    bundler.transform("@browserify/uglifyify");
  },
};
