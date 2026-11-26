// No code-signing certificate: skip signtool completely (it otherwise spends a long time trying)
exports.default = async function sign() {};
