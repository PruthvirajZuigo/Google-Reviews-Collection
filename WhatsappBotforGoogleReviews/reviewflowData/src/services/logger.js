function info(...args) {
  console.log(`[INFO] ${new Date().toISOString()}`, ...args);
}
function error(...args) {
  console.error(`[ERROR] ${new Date().toISOString()}`, ...args);
}

module.exports = { info, error };
