const fs = require('fs');

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJSONAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function queueCircuitResetCommand(commandsPath, stage) {
  const current = readJSON(commandsPath, []);
  const commands = Array.isArray(current) ? current : [];
  commands.push({
    stage,
    requested_at: new Date().toISOString(),
  });
  writeJSONAtomic(commandsPath, commands);
}

function consumeCircuitResetCommands(commandsPath, allowedStages) {
  const current = readJSON(commandsPath, []);
  if (!Array.isArray(current) || current.length === 0) return [];
  writeJSONAtomic(commandsPath, []);
  return current.filter((command) => command && allowedStages.includes(command.stage));
}

module.exports = {
  queueCircuitResetCommand,
  consumeCircuitResetCommands,
};
